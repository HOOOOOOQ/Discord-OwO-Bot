/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Container health check.
 *
 * Verifies that the dependencies the bot cannot run without (MySQL and Redis)
 * still accept connections. Exits 0 when healthy, 1 otherwise.
 * The bot token / Discord gateway state is not probed: the sharder owns that
 * connection and a transient gateway reconnect is not unhealthy.
 */

const net = require('node:net');

const TIMEOUT_MS = Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS, 10) || 3000;

function probe(host, port) {
	return new Promise((resolve) => {
		if (!host) return resolve({ ok: false, reason: 'not configured' });
		const socket = net.connect({ host, port });
		const done = (result) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(TIMEOUT_MS);
		socket.once('connect', () => done({ ok: true }));
		socket.once('timeout', () => done({ ok: false, reason: 'timeout' }));
		socket.once('error', (err) => done({ ok: false, reason: err.code || err.message }));
	});
}

(async () => {
	const { resolveMysql, resolveRedis } = require('../src/utils/dbUrl.js');
	// Respects DATABASE_URL / REDIS_URL as well as the legacy variables.
	const mysqlConnection = resolveMysql();
	const redisConnection = resolveRedis();
	const [mysql, redis] = await Promise.all([
		probe(mysqlConnection.host, mysqlConnection.port || 3306),
		probe(redisConnection.host, redisConnection.port || 6379),
	]);

	const summary = `mysql=${mysql.ok ? 'ok' : mysql.reason} redis=${redis.ok ? 'ok' : redis.reason}`;
	if (mysql.ok && redis.ok) {
		console.log(`healthy ${summary}`);
		process.exit(0);
	}
	console.error(`unhealthy ${summary}`);
	process.exit(1);
})();
