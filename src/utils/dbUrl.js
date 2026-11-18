/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Connection-string (URL) support for MySQL/MariaDB and Redis.
 *
 * A deployment then only needs two secrets instead of nine:
 *
 *   DATABASE_URL=mysql://owo:secret@172.18.0.1:3306/owo
 *   REDIS_URL=redis://:secret@172.18.0.1:6379/0
 *
 * The legacy variables (MYSQL_HOST/MYSQL_USER/MYSQL_PASS/MYSQL_DATABASE and
 * REDIS_HOST/REDIS_PASS) keep working, so existing installs do not change.
 * A URL always wins when both are present.
 *
 * Secrets are never logged: parse errors report the variable name and reason
 * only, and the URL itself is never echoed.
 */

const log = require('./log.js');

const MYSQL_SCHEMES = ['mysql:', 'mariadb:', 'mysql2:'];
const REDIS_SCHEMES = ['redis:', 'rediss:'];

const DEFAULT_MYSQL_PORT = 3306;
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_MYSQL_DATABASE = 'owo';

function decode(value) {
	if (!value) return value;
	try {
		return decodeURIComponent(value);
	} catch (err) {
		return value;
	}
}

function firstEnv(env, names) {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined && value !== null && String(value).trim() !== '') {
			return { name, value: String(value).trim() };
		}
	}
	return null;
}

/**
 * @param {string} value e.g. mysql://user:pass@host:3306/db
 * @param {string} [defaultDatabase]
 * @returns {{host: string, port: number, user: string, password: string, database: string}}
 */
exports.parseMysqlUrl = function (value, defaultDatabase = DEFAULT_MYSQL_DATABASE) {
	let url;
	try {
		url = new URL(String(value));
	} catch (err) {
		throw new Error('not a valid URL');
	}
	if (!MYSQL_SCHEMES.includes(url.protocol)) {
		throw new Error(`unsupported scheme "${url.protocol}" (use mysql://)`);
	}
	if (!url.hostname) throw new Error('missing host');

	let port = DEFAULT_MYSQL_PORT;
	if (url.port) {
		port = Number.parseInt(url.port, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error('invalid port');
		}
	}

	const database = decode(url.pathname.replace(/^\//, '')) || defaultDatabase;
	return {
		host: url.hostname,
		port,
		user: decode(url.username) || 'root',
		password: decode(url.password) || '',
		database,
	};
};

/**
 * @param {string} value e.g. redis://:pass@host:6379/0 or rediss://host:6380
 * @returns {{host: string, port: number, password?: string, db?: number, tls: boolean}}
 */
exports.parseRedisUrl = function (value) {
	let url;
	try {
		url = new URL(String(value));
	} catch (err) {
		throw new Error('not a valid URL');
	}
	if (!REDIS_SCHEMES.includes(url.protocol)) {
		throw new Error(`unsupported scheme "${url.protocol}" (use redis:// or rediss://)`);
	}
	if (!url.hostname) throw new Error('missing host');

	let port = DEFAULT_REDIS_PORT;
	if (url.port) {
		port = Number.parseInt(url.port, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error('invalid port');
		}
	}

	// redis://:secret@host/3 — password only, database index at the end
	const dbPath = url.pathname.replace(/^\//, '');
	const db = dbPath === '' ? undefined : Number.parseInt(dbPath, 10);
	if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
		throw new Error('invalid database index');
	}

	return {
		host: url.hostname,
		port,
		password: decode(url.password) || undefined,
		db,
		tls: url.protocol === 'rediss:',
	};
};

/**
 * MySQL config resolution: DATABASE_URL / MYSQL_URL first, legacy vars second.
 */
exports.resolveMysql = function (env = process.env) {
	const source = firstEnv(env, ['DATABASE_URL', 'MYSQL_URL']);
	if (source) {
		try {
			const parsed = exports.parseMysqlUrl(
				source.value,
				env.MYSQL_DATABASE || DEFAULT_MYSQL_DATABASE
			);
			log.info(`mysql: using connection string from ${source.name}`);
			return parsed;
		} catch (err) {
			// Never log the value itself: it contains the password.
			log.error(
				`[DATABASE] ${source.name} is invalid (${err.message}); falling back to MYSQL_HOST/MYSQL_USER/MYSQL_PASS/MYSQL_DATABASE`
			);
			if (/mongodb/i.test(String(source.value).slice(0, 12))) {
				log.error(
					'[ACTION] that is a MongoDB URL — this bot uses MySQL/MariaDB. Replace ' +
						'DATABASE_URL with mysql://USER:PASSWORD@HOST:3306/owo'
				);
			}
		}
	}
	const port = Number.parseInt(env.MYSQL_PORT, 10);
	return {
		host: env.MYSQL_HOST,
		port: Number.isInteger(port) ? port : undefined,
		user: env.MYSQL_USER,
		password: env.MYSQL_PASS,
		database: env.MYSQL_DATABASE || DEFAULT_MYSQL_DATABASE,
	};
};

/**
 * Redis config resolution: REDIS_URL first, legacy vars second.
 */
exports.resolveRedis = function (env = process.env) {
	const source = firstEnv(env, ['REDIS_URL']);
	if (source) {
		try {
			const parsed = exports.parseRedisUrl(source.value);
			log.info(`redis: using connection string from ${source.name}`);
			return parsed;
		} catch (err) {
			log.error(
				`redis: ${source.name} is invalid (${err.message}); falling back to REDIS_HOST/REDIS_PASS`
			);
		}
	}
	const port = Number.parseInt(env.REDIS_PORT, 10);
	return {
		host: env.REDIS_HOST,
		port: Number.isInteger(port) ? port : undefined,
		password: env.REDIS_PASS || undefined,
		db: undefined,
		tls: env.REDIS_TLS === 'true',
	};
};
