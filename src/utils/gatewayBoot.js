/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Gateway boot instrumentation.
 *
 * Two problems it solves, both verified against eris 0.17.2:
 *
 * 1. **eris identifies with `presence.status = "offline"` by default.**
 *    `Client` initialises `this.presence = { activities: null, afk: false,
 *    since: null, status: "offline" }` (lib/Client.js) and `Shard#identify`
 *    copies the whole object into the IDENTIFY payload
 *    (`if (this.presence.status) identify.presence = this.presence`,
 *    lib/gateway/Shard.js). Upstream OwO only ever changed that status through
 *    its private sharder server, so a self-hosted bot connected, reached READY
 *    and still showed as **offline** in Discord. The resolved status/activity is
 *    now written before `connect()` so IDENTIFY itself carries "online".
 *
 * 2. Everything before READY is invisible: eris-sharder's worker creates the
 *    client and calls `bot.connect()` without listeners, and it only loads
 *    `src/owo.js` *inside* the client's own `ready` handler, so the bot's own
 *    handlers cannot report a pre-READY failure. This module attaches the
 *    lifecycle logging, a READY watchdog and reconnect counters in the worker
 *    before that happens.
 */

const log = require('./log.js');
const presence = require('./presence.js');
const gatewayCodes = require('./gatewayCodes.js');

const DEFAULT_READY_TIMEOUT_MS = 45000;

let installed = false;
const state = {
	clients: 0,
	readyEvents: 0,
	resumes: 0,
	lastCloseCode: null,
	lastErrorMessage: null,
	lastStallLogAt: 0,
};

function readyTimeoutMs(env = process.env) {
	const parsed = Number.parseInt(env.GATEWAY_READY_TIMEOUT_MS, 10);
	if (Number.isInteger(parsed) && parsed > 0) return parsed;
	return DEFAULT_READY_TIMEOUT_MS;
}

/**
 * The presence object eris sends inside IDENTIFY (and keeps in memory).
 * Guild/user counts are unknown this early, so templates render with zeroes and
 * are corrected by the ready handler once the counts are known.
 */
function identifyPresence(env = process.env, counts = {}) {
	const resolved = presence.resolve(env);
	const activity = presence.buildActivity(resolved, counts);
	return {
		presence: {
			status: resolved.status,
			afk: false,
			since: 0,
			activities: activity ? [activity] : [],
		},
		resolved,
		activity,
	};
}

function attachLogging(client, options = {}) {
	const env = options.env || process.env;
	const startedAt = Date.now();
	let readySeen = false;

	const timer = setTimeout(() => {
		if (readySeen) return;
		// Reconnects repeat this; keep the panel readable.
		const now = Date.now();
		const loud = now - state.lastStallLogAt > 60000;
		if (loud) state.lastStallLogAt = now;
		const write = loud ? log.error.bind(log) : log.debug.bind(log);
		write(
			`[GATEWAY] no READY after ${Math.round(
				readyTimeoutMs(env) / 1000
			)}s — the identify never completed`
		);
		if (!loud) return;
		if (state.lastCloseCode !== null) {
			log.error(`[ERROR] last gateway close: ${gatewayCodes.describe(state.lastCloseCode)}`);
		}
		if (state.lastErrorMessage) {
			log.error(`[ERROR] last gateway error: ${state.lastErrorMessage}`);
		}
		log.error(
			'[ACTION] stop the server and run: node index.js --doctor --connect — it names the exact cause ' +
				'(4004 = bad BOT_TOKEN, 4014 = privileged intent disabled in the Developer Portal)'
		);
	}, readyTimeoutMs(env));
	if (typeof timer.unref === 'function') timer.unref();

	client.on('connect', (id) => {
		log.info(`[GATEWAY] shard ${id} socket open — sent IDENTIFY, waiting for READY`);
	});

	client.on('shardReady', (id) => {
		log.info(`[SHARD] shard ${id} READY after ${Date.now() - startedAt}ms`);
	});

	client.on('ready', () => {
		readySeen = true;
		state.readyEvents++;
		clearTimeout(timer);
		const shards = client.shards ? client.shards.size : 1;
		const guilds = client.guilds ? client.guilds.size : 0;
		log.info(`[GATEWAY] all shards READY — ${shards} shard(s), ${guilds} guild(s)`);
	});

	client.on('shardResume', (id) => {
		state.resumes++;
		log.info(`[GATEWAY] shard ${id} resumed (reconnect #${state.resumes})`);
	});

	client.on('shardDisconnect', (err, id) => {
		const code = err && err.code;
		if (code !== undefined && code !== null) state.lastCloseCode = code;
		log.warn(`[GATEWAY] shard ${id} disconnected: ${gatewayCodes.describe(code)}`);
		if (gatewayCodes.isFatalAuthCode(code)) {
			log.error(
				`[ERROR] this connection will not recover on its own — fix the cause above, then restart`
			);
		}
	});

	client.on('warn', (message) => {
		log.warn(`[GATEWAY] ${message}`);
	});

	client.on('error', (err) => {
		state.lastErrorMessage = (err && err.message) || String(err);
		const code = err && (err.code || err.closeCode);
		if (code !== undefined && code !== null) state.lastCloseCode = code;
		log.error(`[GATEWAY] error: ${state.lastErrorMessage}`);
	});

	client.on('disconnect', (err) => {
		const code = err && err.code;
		if (code !== undefined && code !== null) state.lastCloseCode = code;
		if (code === 1000 || code === 1001) {
			log.info(`[GATEWAY] client closed normally: ${gatewayCodes.describe(code)}`);
			return;
		}
		log.warn(`[GATEWAY] client disconnected: ${gatewayCodes.describe(code)}`);
	});

	return () => clearTimeout(timer);
}

/**
 * Patches `Eris.Client.prototype.connect` once per process so the presence is
 * correct in IDENTIFY and the lifecycle is logged before eris-sharder connects.
 */
function install(options = {}) {
	// Tests inject a fake eris; the per-prototype guard still prevents double
	// wrapping in production.
	if (installed && !options.Eris) return true;
	let Eris = options.Eris;
	try {
		Eris = Eris || require('eris');
	} catch (err) {
		log.warn(`[GATEWAY] instrumentation skipped: eris is not installed (${err.message})`);
		return false;
	}
	const proto = Eris.Client && Eris.Client.prototype;
	if (!proto || typeof proto.connect !== 'function') {
		log.warn('[GATEWAY] instrumentation skipped: unsupported eris build');
		return false;
	}
	if (proto.__oceanGatewayPatched) {
		installed = true;
		return true;
	}

	const originalConnect = proto.connect;
	proto.connect = function patchedConnect(...args) {
		const env = options.env || process.env;
		try {
			const { presence: initial, resolved, activity } = identifyPresence(env);
			state.clients++;
			this.presence = initial;
			log.info(
				`[GATEWAY] connecting with presence ${resolved.status}` +
					(activity ? ` — ${presence.describe(activity)}` : '') +
					(state.clients > 0 ? ` (attempt ${state.clients})` : '')
			);
		} catch (err) {
			log.warn(`[GATEWAY] could not prepare presence (${err.message}); using the eris default`);
		}
		try {
			attachLogging(this, { env });
		} catch (err) {
			log.warn(`[GATEWAY] lifecycle logging unavailable (${err.message})`);
		}
		return originalConnect.apply(this, args);
	};
	proto.__oceanGatewayPatched = true;
	installed = true;
	log.debug('[GATEWAY] instrumentation installed (presence in IDENTIFY + lifecycle logging)');
	return true;
}

module.exports = {
	install,
	identifyPresence,
	attachLogging,
	readyTimeoutMs,
	state,
};
