/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Container health check.
 *
 * The bot needs exactly two external things: a Discord token (the sharder owns
 * that socket, and a transient gateway reconnect is not unhealthy) and the
 * MongoDB Atlas connection. This script checks the MongoDB URI syntax and, when
 * the cluster host is directly reachable, opens a TCP connection to it.
 * Exits 0 when healthy, 1 otherwise.
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
	const mongoClient = require('../src/utils/mongo/client.js');
	const uri = mongoClient.readUri();
	const info = mongoClient.inspectUri(uri);
	if (!info.ok) {
		console.error(`unhealthy mongodb=${info.reason}`);
		process.exit(1);
	}

	// `mongodb+srv://` hides the real hosts behind DNS SRV records, so a TCP
	// probe is only done when the URI lists an explicit host:port.
	if (info.scheme === 'mongodb+srv') {
		console.log(`healthy mongodb=srv:${info.host}/${info.database}`);
		process.exit(0);
	}

	const [hostPart, portPart] = String(info.host).split(',')[0].split(':');
	const result = await probe(hostPart, Number.parseInt(portPart, 10) || 27017);
	if (result.ok) {
		console.log(`healthy mongodb=${hostPart}:${portPart || 27017}/${info.database}`);
		process.exit(0);
	}
	console.error(`unhealthy mongodb=${result.reason}`);
	process.exit(1);
})();
