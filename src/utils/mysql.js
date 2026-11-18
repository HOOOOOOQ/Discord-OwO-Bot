/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const log = require('./log.js');
const { resolveMysql } = require('./dbUrl.js');
const mysql = require('mysql');

// DATABASE_URL/MYSQL_URL wins over the legacy MYSQL_* variables.
const connection = resolveMysql();

const config = {
	host: connection.host,
	port: connection.port,
	user: connection.user,
	password: connection.password,
	database: connection.database,
	supportBigNumbers: true,
	// Several existing battle/team queries send more than one statement in a
	// single call (battle/ab.js, battle/db.js, zoo/sacrifice.js, teamUtil.js), so
	// this cannot be switched off without rewriting those features. It is kept
	// configurable and the codebase is hardened with parameterized queries
	// instead. Set MYSQL_MULTIPLE_STATEMENTS=false only after those call sites
	// are migrated to `transaction.query()` calls.
	multipleStatements: process.env.MYSQL_MULTIPLE_STATEMENTS !== 'false',
	charset: 'utf8mb4',
	connectionLimit: Number.parseInt(process.env.MYSQL_CONNECTION_LIMIT, 10) || 10,
	connectTimeout: Number.parseInt(process.env.MYSQL_CONNECT_TIMEOUT_MS, 10) || 10000,
	// Recycle idle connections so stale sockets do not turn into query errors
	maxIdle: Number.parseInt(process.env.MYSQL_MAX_IDLE, 10) || 10,
	idleTimeout: Number.parseInt(process.env.MYSQL_IDLE_TIMEOUT_MS, 10) || 60000,
};

if (!config.host) {
	log.error('[DATABASE] no MySQL host configured — every database feature will fail');
	log.error(
		'[ACTION] set DATABASE_URL=mysql://user:pass@HOST:3306/owo (Pterodactyl → Startup/Variables). ' +
			'Inside the container 127.0.0.1 is the bot itself, not the database host.'
	);
} else {
	log.info(
		`[DATABASE] connecting to ${config.host}:${config.port || 3306}/${config.database || '?'} as ${
			config.user || '(no user)'
		}`
	);
}
log.info(
	`[DATABASE] pool limit=${config.connectionLimit} connectTimeout=${config.connectTimeout}ms`
);

const pool = mysql.createPool(config);

/*
 * A pool level error (dropped connection, server restart, auth failure) is an
 * EventEmitter 'error' event. Without a listener Node treats it as an uncaught
 * exception and kills the cluster, so it is handled here.
 */
pool.on('error', (err) => {
	log.error(`[DATABASE] pool error: ${err.code || err.name}: ${err.message}`);
	if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENOTFOUND') {
		log.error(
			`[ACTION] ${config.host}:${config.port || 3306} is not reachable from this container — ` +
				'use the database host/IP as seen from inside Pterodactyl (often 172.18.0.1 or a service name)'
		);
	}
	if (err.code === 'ER_ACCESS_DENIED_ERROR') {
		log.error(
			'[ACTION] MySQL rejected the credentials — check MYSQL_USER/MYSQL_PASS or DATABASE_URL'
		);
	}
});
pool.on('connection', () => {
	log.debug('mysql: new connection established');
});

exports.con = pool;
exports.pool = pool;
exports.mysql = mysql;
exports.config = config;

exports.close = function () {
	return new Promise((resolve) => {
		try {
			pool.end((err) => {
				if (err) log.warn(`mysql pool did not close cleanly: ${err.message}`);
				resolve();
			});
		} catch (err) {
			log.warn(`mysql pool close failed: ${err.message}`);
			resolve();
		}
	});
};
