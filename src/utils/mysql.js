/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The bot's old MySQL entry point, now backed by MongoDB Atlas.
 *
 * The name of the file is kept on purpose: ~350 call sites across the command
 * tree (`con.query(...)`, `mysql.query(...)`, `mysql.con.query(...)`) and their
 * result shapes (`result[0][0]` for multi-statement strings, `affectedRows`,
 * `insertId`) stay exactly as they were. What changed is where the data lives:
 * every statement is parsed and executed as MongoDB operations by
 * `src/utils/mongo/sql/`. No MySQL server, no `mysql` npm package.
 *
 * `query()` accepts the same argument shapes the mysql driver accepted:
 *
 *   con.query(sql, cb)                 con.query(sql, values, cb)
 *   con.query({ sql, timeout }, values, cb)
 *   await con.query(sql, values)       await con.query({ sql })
 */

const log = require('./log.js');
const client = require('./mongo/client.js');
const sqlLayer = require('./mongo/sql/index.js');
const { loadSchema } = require('./mongo/schema.js');

const queryTimeout = Number.parseInt(process.env.MONGO_QUERY_TIMEOUT_MS, 10) || 30000;

let connectionCounter = 0;

/** Normalises `query(a, b, c)` into `{ sql, values, callback }`. */
function normalizeArgs(args) {
	let sql;
	let values = [];
	let callback;
	const first = args[0];
	if (
		first &&
		typeof first === 'object' &&
		!Array.isArray(first) &&
		typeof first.sql === 'string'
	) {
		sql = first.sql;
	} else {
		sql = first;
	}
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (typeof arg === 'function') callback = arg;
		else if (Array.isArray(arg)) values = arg;
		else if (arg === undefined || arg === null) continue;
		else values = [arg];
	}
	if (typeof sql !== 'string') throw new TypeError('con.query() needs a SQL string');
	return { sql, values: values || [], callback };
}

function withTimeout(promise, timeout, sqlText) {
	if (!timeout || !Number.isFinite(timeout)) return promise;
	let timer;
	const guard = new Promise((resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(new Error(`Query timed out after ${timeout}ms: ${String(sqlText).slice(0, 120)}`)),
			timeout
		);
		if (typeof timer.unref === 'function') timer.unref();
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function run(rawSql, values, options = {}) {
	await client.whenReady();
	const executor = options.executor || sqlLayer.engine();
	return withTimeout(
		executor.execute(rawSql, values || []),
		options.timeout || queryTimeout,
		rawSql
	);
}

function toCallback(promise, callback) {
	if (typeof callback !== 'function') return promise;
	promise.then(
		(result) => callback(null, result, undefined),
		(err) => callback(err)
	);
	return undefined;
}

/* ------------------------------------------------------------------ pool --- */

const pool = {
	threadId: 0,
	/** `con.query(sql[, values][, callback])`, see the header comment. */
	query(...args) {
		const { sql, values, callback } = normalizeArgs(args);
		return toCallback(run(sql, values), callback);
	},
	getConnection(callback) {
		const promise = (async () => {
			await client.whenReady();
			const store = client.getStore();
			let session = null;
			try {
				session = await store.startSession();
			} catch (err) {
				log.warn(`[MONGO] could not open a transaction session: ${err.message}`);
			}
			const threadId = ++connectionCounter;
			const scoped = session ? sqlLayer.withSession(store, session) : null;
			let released = false;
			const handle = {
				threadId,
				session,
				query(...queryArgs) {
					const normalized = normalizeArgs(queryArgs);
					const promise = withTimeout(
						scoped
							? scoped.execute(normalized.sql, normalized.values)
							: run(normalized.sql, normalized.values),
						queryTimeout,
						normalized.sql
					);
					return toCallback(promise, normalized.callback);
				},
				beginTransaction(cb) {
					// The session is already started by startSession()
					if (typeof cb === 'function') return process.nextTick(() => cb(null));
					return Promise.resolve();
				},
				commit(cb) {
					const promise = (async () => {
						if (!session) return false;
						await session.commitTransaction();
						await session.endSession();
						released = true;
						return true;
					})();
					return toCallback(promise, cb);
				},
				rollback(cb) {
					const promise = (async () => {
						if (!session) return false;
						try {
							await session.abortTransaction();
						} finally {
							await session.endSession();
							released = true;
						}
						return false;
					})();
					return toCallback(promise, cb);
				},
				release() {
					if (released) return;
					released = true;
					if (session) session.endSession().catch(() => {});
				},
			};
			return handle;
		})();
		return toCallback(promise, callback);
	},
	end(callback) {
		const promise = client.close();
		return toCallback(promise, callback);
	},
};

/* ---------------------------------------------------------------- exports --- */

exports.con = pool;
exports.pool = pool;
exports.config = {
	driver: 'mongodb',
	database: 'see MONGODB_URI',
	tables: Object.keys(loadSchema()).length,
	queryTimeout,
};
// Kept so old code that only checks for the field does not crash
exports.mysql = undefined;

exports.query = function (sql, values = []) {
	return run(sql, values);
};

exports.close = function () {
	return client.close().catch((err) => log.warn(`[MONGO] close failed: ${err.message}`));
};
