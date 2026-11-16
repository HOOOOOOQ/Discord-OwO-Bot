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
	const mysqlPort = Number.parseInt(process.env.MYSQL_PORT, 10) || 3306;
	const redisPort = Number.parseInt(process.env.REDIS_PORT, 10) || 6379;
	const [mysql, redis] = await Promise.all([
		probe(process.env.MYSQL_HOST, mysqlPort),
		probe(process.env.REDIS_HOST, redisPort),
	]);

	const summary = `mysql=${mysql.ok ? 'ok' : mysql.reason} redis=${redis.ok ? 'ok' : redis.reason}`;
	if (mysql.ok && redis.ok) {
		console.log(`healthy ${summary}`);
		process.exit(0);
	}
	console.error(`unhealthy ${summary}`);
	process.exit(1);
})();
