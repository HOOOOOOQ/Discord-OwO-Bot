/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Gateway reachability probe.
 *
 * Opens a plain WebSocket to Discord's gateway, waits for **HELLO (op 10)** and
 * closes. It never sends IDENTIFY, so no session is created and the identify
 * budget (`/gateway/bot`) is not spent — it is safe to run on a live panel.
 *
 * It answers the one question REST cannot: `[DISCORD] authentication successful`
 * only proves that `discord.com` is reachable over HTTPS. The gateway is a
 * different host (`gateway.discord.gg`), a different socket implementation
 * (`ws` → `net`/`tls`, no Happy Eyeballs) and therefore a different failure
 * surface (broken IPv6 route, blocked 443 WebSocket upgrade, hanging DNS, proxy
 * that only allows plain HTTPS).
 */

const ERIS_VERSION_PROBE_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

function defaultUrl(env = process.env) {
	return env.GATEWAY_PROBE_URL || ERIS_VERSION_PROBE_URL;
}

function loadWebSocket() {
	try {
		// `ws` is eris' own dependency and is installed next to it.
		return require('ws');
	} catch (err) {
		return null;
	}
}

/**
 * @returns {Promise<{ok: boolean, url: String, ms: Number, heartbeat?:
 *   Number, error?: String, hint?: String}>}
 */
function probe(options = {}) {
	const env = options.env || process.env;
	const url = options.url || defaultUrl(env);
	const timeoutMs = options.timeoutMs || 10000;
	const startedAt = Date.now();

	const WebSocket = options.WebSocket || loadWebSocket();
	if (!WebSocket) {
		return Promise.resolve({
			ok: false,
			url,
			ms: 0,
			error: 'the "ws" module is not installed (it ships with eris)',
		});
	}

	return new Promise((resolve) => {
		let settled = false;
		let socket;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				if (socket) socket.terminate ? socket.terminate() : socket.close();
			} catch (err) {
				/* already gone */
			}
			resolve(Object.assign({ url, ms: Date.now() - startedAt }, result));
		};

		const timer = setTimeout(() => {
			finish({
				ok: false,
				timedOut: true,
				error: `no HELLO inside ${Math.round(timeoutMs / 1000)}s`,
				hint:
					'the TCP/TLS/WebSocket path to gateway.discord.gg is blocked or hanging — ' +
					'check the host firewall/egress rules and try GATEWAY_IPV4_FIRST=true',
			});
		}, timeoutMs);
		// Deliberately NOT unref'd: the probe must keep its own promise alive until
		// it settles (a hang must turn into a reported timeout, never into silence).

		try {
			socket = new WebSocket(url, {
				handshakeTimeout: Math.min(timeoutMs, 15000),
				perMessageDeflate: false,
			});
		} catch (err) {
			finish({ ok: false, error: `could not start the socket: ${err.message}` });
			return;
		}

		socket.on('message', (raw) => {
			let packet;
			try {
				packet = JSON.parse(String(raw));
			} catch (err) {
				return;
			}
			if (packet && packet.op === 10) {
				finish({
					ok: true,
					heartbeat: packet.d && packet.d.heartbeat_interval,
					helloAt: Date.now() - startedAt,
				});
			}
		});
		socket.on('error', (err) => {
			finish({
				ok: false,
				error: err && err.message ? err.message : String(err),
				code: err && err.code,
			});
		});
		socket.on('close', (code, reason) => {
			finish({
				ok: false,
				error: `socket closed before HELLO (code ${code}${
					reason && reason.length ? `, ${String(reason)}` : ''
				})`,
			});
		});
	});
}

function describe(result) {
	if (result.ok) {
		return `HELLO in ${result.helloAt || result.ms}ms (heartbeat ${
			result.heartbeat
		}ms) — the gateway is reachable`;
	}
	return `${result.error}${result.hint ? ` — ${result.hint}` : ''}`;
}

module.exports = { probe, describe, defaultUrl };
