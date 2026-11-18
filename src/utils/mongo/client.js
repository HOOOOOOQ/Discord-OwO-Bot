/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * MongoDB Atlas is the only datastore this bot needs. This module owns the
 * connection:
 *
 *   - reads `MONGODB_URI` (or `MONGO_URI`), validates the scheme,
 *   - never logs the password (the URI is reduced to `host/database`),
 *   - retries a few times with backoff, then fails with a readable `[ACTION]`
 *     line instead of crashing in a restart loop,
 *   - creates the collections and indexes that the SQL layer relies on,
 *   - closes cleanly on SIGTERM/SIGINT so no write is cut in half.
 */

const log = require('../log.js');
const { MongoStore } = require('./store.js');
const { loadSchema } = require('./schema.js');
const { coerceForColumn } = require('./values.js');

const DEFAULT_DB = 'ocean';

let store = null;
let connecting = null;
let indexesReady = false;

function readUri(env = process.env) {
	return (env.MONGODB_URI || env.MONGO_URI || '').trim();
}

/** `mongodb://user:pass@host:27017/db?x=y` → `{ ok, scheme, host, database }` */
function inspectUri(uri) {
	if (!uri) {
		return {
			ok: false,
			reason: 'MONGODB_URI is not set',
			action:
				'Pterodactyl → Startup → add MONGODB_URI (mongodb+srv://user:pass@cluster.mongodb.net/ocean)',
		};
	}
	const schemeMatch = uri.match(/^([a-z0-9+.-]+):\/\//i);
	if (!schemeMatch) {
		return {
			ok: false,
			reason: 'MONGODB_URI has no scheme',
			action: 'the value must start with mongodb:// or mongodb+srv://',
		};
	}
	const scheme = schemeMatch[1].toLowerCase();
	if (scheme !== 'mongodb' && scheme !== 'mongodb+srv') {
		return {
			ok: false,
			reason: `MONGODB_URI uses an unsupported scheme "${scheme}:"`,
			action:
				scheme === 'mysql' || scheme === 'mariadb'
					? 'this is a SQL URL — the bot uses MongoDB Atlas now: mongodb+srv://user:pass@cluster.mongodb.net/ocean'
					: 'the value must start with mongodb:// or mongodb+srv://',
		};
	}
	const rest = uri.slice(schemeMatch[0].length);
	const withoutQuery = rest.split('?')[0];
	const at = withoutQuery.lastIndexOf('@');
	const credentials = at >= 0 ? withoutQuery.slice(0, at) : '';
	const hostPart = at >= 0 ? withoutQuery.slice(at + 1) : withoutQuery;
	const slash = hostPart.indexOf('/');
	const host = slash >= 0 ? hostPart.slice(0, slash) : hostPart;
	const database = slash >= 0 ? hostPart.slice(slash + 1) : '';
	if (!host) {
		return { ok: false, reason: 'MONGODB_URI has no host', action: 'check the value after "@"' };
	}
	if (!credentials) {
		return {
			ok: false,
			reason: 'MONGODB_URI has no username:password',
			action: 'Atlas → Database Access → add a user, then use mongodb+srv://USER:PASSWORD@cluster…',
		};
	}
	return { ok: true, scheme, host, database: database || DEFAULT_DB };
}

function maskUri(uri) {
	const info = inspectUri(uri);
	if (!info.ok) return '(invalid)';
	return `${info.scheme}://***@${info.host}/${info.database}`;
}

function databaseName(uri) {
	if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
	const info = inspectUri(uri);
	return info.database || DEFAULT_DB;
}

async function ensureIndexes(mongoStore) {
	if (indexesReady) return;
	const schema = loadSchema();
	for (const table of Object.values(schema)) {
		const collection = mongoStore.collection(table.name);
		// Unique keys other than the primary key (pid, tid, uid, pgid ...)
		for (const unique of table.uniques) {
			try {
				await collection.createIndex(
					Object.fromEntries(unique.columns.map((column) => [column, 1])),
					{ unique: true, name: `uniq_${unique.name}` }
				);
			} catch (err) {
				log.warn(
					`[MONGO] could not create unique index ${table.name}.${unique.name}: ${
						err.message.code || err.message
					}`
				);
			}
		}
		for (const index of table.indexes) {
			try {
				await collection.createIndex(
					Object.fromEntries(index.columns.map((column) => [column, 1])),
					{ name: `idx_${index.name}` }
				);
			} catch (err) {
				log.debug(`[MONGO] index ${table.name}.${index.name} skipped: ${err.message}`);
			}
		}
	}
	indexesReady = true;
}

async function connect(options = {}) {
	if (store) return store;
	if (connecting) return connecting;
	const uri = options.uri || readUri();
	const info = inspectUri(uri);
	if (!info.ok) {
		const err = new Error(`${info.reason}. ${info.action}`);
		err.code = 'MONGODB_URI_INVALID';
		throw err;
	}

	const attempts =
		options.attempts || Number.parseInt(process.env.MONGODB_CONNECT_ATTEMPTS, 10) || 5;
	connecting = (async () => {
		let lastError;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				const candidate = new MongoStore({ uri, dbName: databaseName(uri), log });
				await candidate.connect();
				store = candidate;
				await ensureIndexes(store);
				log.info(`[MONGO] connected — ${maskUri(uri)}`);
				return store;
			} catch (err) {
				lastError = err;
				const delay = Math.min(attempt * 2000, 15000);
				log.error(`[MONGO] connection attempt ${attempt}/${attempts} failed: ${err.message}`);
				if (attempt < attempts) {
					log.warn(`[MONGO] retrying in ${delay}ms`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
		log.error(`[MONGO] could not connect to ${maskUri(uri)} after ${attempts} attempt(s)`);
		log.error(
			'[ACTION] Atlas → Network Access: allow 0.0.0.0/0 (Pterodactyl hosts have changing IPs), ' +
				'check the user/password, and make sure the URI includes the database name (/ocean)'
		);
		const error = new Error(`MongoDB connection failed: ${lastError && lastError.message}`);
		error.code = 'MONGODB_UNREACHABLE';
		throw error;
	})();

	try {
		return await connecting;
	} finally {
		connecting = null;
	}
}

function getStore() {
	if (!store) throw new Error('MongoDB is not connected yet — call mongoClient.connect() first');
	return store;
}

function isConnected() {
	return !!store;
}

/**
 * Resolves once the connection exists. Modules that query the database while
 * they are being required (the command tree does) call this instead of failing
 * because the boot sequence has not reached `connect()` yet.
 */
async function whenReady(timeoutMs = 30000) {
	if (store) return store;
	if (String(process.env.MONGO_OFFLINE || '').toLowerCase() === 'true') {
		// Verification/CI mode: the code is loaded without a database on purpose.
		const err = new Error('MONGO_OFFLINE=true — database access disabled in this run');
		err.code = 'MONGODB_OFFLINE';
		throw err;
	}
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (store) return store;
		if (connecting) return await connecting;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const err = new Error('MongoDB connection is not ready');
	err.code = 'MONGODB_NOT_READY';
	throw err;
}

async function close() {
	if (!store) return;
	try {
		await store.close();
		log.info('[MONGO] connection closed');
	} finally {
		store = null;
		indexesReady = false;
	}
}

module.exports = {
	connect,
	close,
	getStore,
	isConnected,
	whenReady,
	inspectUri,
	maskUri,
	databaseName,
	readUri,
	coerceForColumn,
};
