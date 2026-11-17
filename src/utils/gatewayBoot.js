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
 *    handlers cannot report a pre-READY failure.
 *
 * This module therefore also traces the gateway at packet level, using APIs that
 * exist in eris 0.17.2:
 *
 *   - `Shard#sendWS(op, data)` (lib/gateway/Shard.js:583) → IDENTIFY/RESUME/HEARTBEAT
 *   - `Shard#on('rawWS', packet, id)` (lib/gateway/Shard.js:396) → HELLO,
 *     HEARTBEAT_ACK, DISPATCH READY/RESUMED, INVALID_SESSION, RECONNECT
 *
 * `rawWS` is only emitted on the shard (never forwarded to the client), so the
 * shards are instrumented right after `connect()` spawns them. Nothing is
 * reported as a state that was not actually observed.
 */

const log = require('./log.js');
const presence = require('./presence.js');
const gatewayCodes = require('./gatewayCodes.js');

const DEFAULT_READY_TIMEOUT_MS = 45000;

let installed = false;
const GATEWAY_OPCODES = {
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	RESUME: 6,
	RECONNECT: 7,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11,
};

const state = {
	clients: 0,
	readyEvents: 0,
	resumes: 0,
	lastCloseCode: null,
	lastErrorMessage: null,
	lastStallLogAt: 0,
	// Ordered list of transitions that were really observed: no synthetic entries.
	phases: [],
	readySeenAt: null,
	presenceSyncedAt: null,
	shards: new Set(),
};

/** Records and logs one observed gateway transition. */
function markPhase(stage, detail) {
	const entry = { stage, at: Date.now(), detail: detail || null };
	state.phases.push(entry);
	if (state.phases.length > 200) state.phases.shift();
	if (stage === 'READY_RECEIVED') state.readySeenAt = entry.at;
	if (stage === 'PRESENCE_SYNCHRONIZED') state.presenceSyncedAt = entry.at;
	log.info(`[STATE] ${stage}${detail ? ` — ${detail}` : ''}`);
	return entry;
}

function phaseSummary() {
	if (!state.phases.length) return 'no gateway events observed';
	return state.phases.map((entry) => entry.stage).join(' → ');
}

/** eris turns a close frame into `new Error("4004: Authentication failed")`. */
function closeCodeOf(err) {
	if (!err) return null;
	if (typeof err === 'number') return err;
	if (err.code !== undefined && err.code !== null) return err.code;
	const match = /^(\d{4}):/.exec(String(err.message || ''));
	return match ? Number(match[1]) : null;
}

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

/**
 * Packet-level tracing for one shard. Idempotent: the prototype patch is shared,
 * listeners are attached once per shard instance.
 */
function instrumentShard(shard) {
	if (!shard || typeof shard.on !== 'function') return;
	const id = shard.id;
	if (state.shards.has(id)) {
		// Still ensure the listener exists (new instance after a cluster respawn).
		if (shard.__oceanTraced) return;
	}
	state.shards.add(id);

	const proto = Object.getPrototypeOf(shard);
	if (proto && !proto.__oceanSendWSPatched) {
		const originalSendWS = proto.sendWS;
		proto.sendWS = function patchedSendWS(op, data, priority) {
			try {
				if (op === GATEWAY_OPCODES.IDENTIFY) {
					const payload = data || {};
					markPhase(
						'IDENTIFY_SENT',
						`shard=${this.id} intents=${payload.intents} presence=${
							(payload.presence && payload.presence.status) || 'none'
						}${payload.shard ? ` shard=[${payload.shard.join('/')}]` : ''}`
					);
				} else if (op === GATEWAY_OPCODES.RESUME) {
					markPhase('RESUME_SENT', `shard=${this.id}`);
				} else if (op === GATEWAY_OPCODES.HEARTBEAT) {
					log.debug(`[STATE] HEARTBEAT_SENT shard=${this.id}`);
				}
			} catch (err) {
				log.debug(`[STATE] sendWS trace failed: ${err.message}`);
			}
			return originalSendWS.call(this, op, data, priority);
		};
		proto.__oceanSendWSPatched = true;
	}

	if (shard.__oceanTraced) return;
	shard.__oceanTraced = true;

	shard.on('rawWS', (packet) => {
		try {
			const op = packet && packet.op;
			const type = packet && packet.t;
			if (op === GATEWAY_OPCODES.HELLO) {
				const interval = packet.d && packet.d.heartbeat_interval;
				markPhase('HELLO_RECEIVED', `shard=${id} heartbeat_interval=${interval}ms`);
			} else if (op === GATEWAY_OPCODES.HEARTBEAT_ACK) {
				log.debug(`[STATE] HEARTBEAT_ACK shard=${id}`);
				if (!state.phases.some((entry) => entry.stage === 'HEARTBEAT_ACKNOWLEDGED')) {
					markPhase('HEARTBEAT_ACKNOWLEDGED', `shard=${id}`);
				}
			} else if (op === GATEWAY_OPCODES.DISPATCH && type === 'READY') {
				const data = packet.d || {};
				const user = data.user || {};
				markPhase(
					'READY_RECEIVED',
					`shard=${id} ${user.username || '?'}${
						user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : ''
					} guilds=${(data.guilds || []).length} session=${String(data.session_id || '').slice(
						0,
						8
					)}…`
				);
			} else if (op === GATEWAY_OPCODES.DISPATCH && type === 'RESUMED') {
				markPhase('RESUMED', `shard=${id}`);
			} else if (op === GATEWAY_OPCODES.INVALID_SESSION) {
				markPhase('INVALID_SESSION', `shard=${id} resumable=${packet.d}`);
			} else if (op === GATEWAY_OPCODES.RECONNECT) {
				markPhase('RECONNECT_REQUESTED', `shard=${id}`);
			}
		} catch (err) {
			log.debug(`[STATE] rawWS trace failed: ${err.message}`);
		}
	});

	shard.on('debug', (message) => log.debug(`[GATEWAY] shard ${id} debug: ${message}`));
}

function instrumentClientShards(client) {
	try {
		if (!client.shards || typeof client.shards.forEach !== 'function') return 0;
		let count = 0;
		client.shards.forEach((shard) => {
			instrumentShard(shard);
			count++;
		});
		return count;
	} catch (err) {
		log.debug(`[GATEWAY] shard instrumentation failed: ${err.message}`);
		return 0;
	}
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
		instrumentClientShards(client);
	});

	client.on('ready', () => {
		readySeen = true;
		state.readyEvents++;
		clearTimeout(timer);
		const shards = client.shards ? client.shards.size : 1;
		const guilds = client.guilds ? client.guilds.size : 0;
		log.info(`[GATEWAY] all shards READY — ${shards} shard(s), ${guilds} guild(s)`);
		markPhase('BOT_ONLINE', `${shards} shard(s), ${guilds} guild(s)`);
	});

	client.on('shardResume', (id) => {
		state.resumes++;
		log.info(`[GATEWAY] shard ${id} resumed (reconnect #${state.resumes})`);
	});

	client.on('shardDisconnect', (err, id) => {
		const code = closeCodeOf(err);
		if (code !== null) state.lastCloseCode = code;
		const reason = err && err.message ? ` (${err.message})` : '';
		log.warn(`[GATEWAY] shard ${id} disconnected: ${gatewayCodes.describe(code)}${reason}`);
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
		const code = closeCodeOf(err);
		if (code !== null) state.lastCloseCode = code;
		log.error(`[GATEWAY] error: ${state.lastErrorMessage}`);
	});

	client.on('disconnect', (err) => {
		const code = closeCodeOf(err);
		if (code !== null) state.lastCloseCode = code;
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
		const connected = originalConnect.apply(this, args);
		// connect() spawns the shards; rawWS is emitted on the shard, never on the
		// client, so the shards can only be traced once they exist.
		Promise.resolve(connected)
			.then(() => instrumentClientShards(this))
			.catch(() => {});
		return connected;
	};
	proto.__oceanGatewayPatched = true;
	installed = true;
	log.debug('[GATEWAY] instrumentation installed (presence in IDENTIFY + lifecycle logging)');
	return true;
}

module.exports = {
	GATEWAY_OPCODES,
	install,
	identifyPresence,
	attachLogging,
	instrumentShard,
	instrumentClientShards,
	markPhase,
	phaseSummary,
	closeCodeOf,
	readyTimeoutMs,
	state,
};
