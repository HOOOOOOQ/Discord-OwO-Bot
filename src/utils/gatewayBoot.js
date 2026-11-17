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

// Startup stages a worker must pass through before Discord can see it. Every
// one of them is set by a real signal (IPC message, patched connect, socket
// event, gateway packet) — never by a timer or by process liveness.
const STARTUP_STAGES = [
	'process_started',
	'sharder_constructed',
	'ipc_connect_received',
	'connect_called',
	'websocket_open',
	'hello_received',
	'identify_sent',
	'ready_received',
];

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

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
	// ---- startup supervisor (worker) -------------------------------------
	stages: new Map(),
	startedAt: Date.now(),
	connectCalled: false,
	websocketOpened: false,
	lastPacket: null,
	lastError: null,
	clusterId: null,
	watchdogArmed: false,
	watchdogReported: false,
};

/** Records and logs one observed gateway transition. */
function markPhase(stage, detail) {
	const entry = { stage, at: Date.now(), detail: detail || null };
	state.lastPacket = stage;
	const stageOfPhase = {
		HELLO_RECEIVED: 'hello_received',
		IDENTIFY_SENT: 'identify_sent',
		READY_RECEIVED: 'ready_received',
	};
	state.phases.push(entry);
	if (state.phases.length > 200) state.phases.shift();
	if (stage === 'READY_RECEIVED') state.readySeenAt = entry.at;
	if (stage === 'PRESENCE_SYNCHRONIZED') state.presenceSyncedAt = entry.at;
	log.info(`[STATE] ${stage}${detail ? ` — ${detail}` : ''}`);
	if (stageOfPhase[stage]) markStage(stageOfPhase[stage], detail);
	return entry;
}

function phaseSummary() {
	if (!state.phases.length) return 'no gateway events observed';
	return state.phases.map((entry) => entry.stage).join(' → ');
}

function connectTimeoutMs(env = process.env) {
	const parsed = Number.parseInt(env.GATEWAY_CONNECT_TIMEOUT_MS, 10);
	if (Number.isInteger(parsed) && parsed > 0) return parsed;
	return DEFAULT_CONNECT_TIMEOUT_MS;
}

function hasStage(stage) {
	return state.stages.has(stage);
}

/** First stage that was never reached, or null when the worker got to READY. */
function firstMissingStage() {
	for (const stage of STARTUP_STAGES) {
		if (!state.stages.has(stage)) return stage;
	}
	return null;
}

function stageTable() {
	return STARTUP_STAGES.map((stage) => {
		const entry = state.stages.get(stage);
		return `${stage}=${entry ? `${entry.at - state.startedAt}ms` : 'NOT REACHED'}`;
	});
}

/**
 * Records one observed startup stage. `detail` is short, never contains the
 * token. Forwarded to the master as an IPC beacon so the panel shows the worker
 * timeline even when the worker's own stdout is lost.
 */
function markStage(stage, detail) {
	if (!stage || state.stages.has(stage)) return;
	state.stages.set(stage, { at: Date.now(), detail: detail || null });
	if (stage === 'connect_called') state.connectCalled = true;
	if (stage === 'websocket_open') state.websocketOpened = true;
	log.info(`[GATEWAY] stage ${stage}${detail ? ` — ${detail}` : ''}`);
	reportStage(stage, detail);
}

function reportStage(stage, detail) {
	try {
		if (process.send && (process.env.OCEAN_STAGE_BEACONS || 'true').toLowerCase() !== 'false') {
			process.send({
				name: 'oceanStage',
				stage,
				detail: detail || null,
				pid: process.pid,
				at: Date.now(),
			});
		}
	} catch (err) {
		/* master gone: the local watchdog still reports */
	}
}

/** Human-readable dump used by the startup watchdog and by --doctor. */
function diagnosticSnapshot(extra = {}) {
	return {
		pid: process.pid,
		clusterId:
			extra.clusterId === undefined
				? state.clusterId === null || state.clusterId === undefined
					? '?'
					: state.clusterId
				: extra.clusterId,
		shard:
			extra.shard === undefined
				? state.lastPacket === null
					? '?'
					: state.lastPacket
				: extra.shard,
		stages: stageTable(),
		firstMissing: firstMissingStage(),
		connectCalled: state.connectCalled,
		websocketOpened: state.websocketOpened,
		clients: state.clients,
		lastPacket: state.lastPacket,
		lastError: state.lastError,
		elapsedMs: Date.now() - state.startedAt,
		phases: phaseSummary(),
	};
}

function formatDiagnostics(snapshot) {
	return [
		`[DIAG] worker pid=${snapshot.pid} cluster=${snapshot.clusterId} elapsed=${Math.round(
			snapshot.elapsedMs / 1000
		)}s`,
		`[DIAG] client created=${
			snapshot.connectCalled ? 'yes' : 'unknown/not yet'
		}; connect() called=${snapshot.connectCalled}`,
		`[DIAG] websocket open=${snapshot.websocketOpened}; last gateway packet=${
			snapshot.lastPacket || 'none'
		}`,
		`[DIAG] stages: ${snapshot.stages.join(' | ')}`,
		`[DIAG] last error: ${snapshot.lastError || 'none'}`,
	];
}

/**
 * The watchdog the user asked for: if the worker is alive but never starts a
 * gateway connection, say exactly that — with the stage table — instead of
 * sitting silent forever.
 */
function armStartupWatchdog(env = process.env, options = {}) {
	if (state.watchdogArmed) return;
	state.watchdogArmed = true;
	const timeoutMs = options.timeoutMs || connectTimeoutMs(env);
	const timer = setTimeout(() => {
		if (state.readySeenAt || state.watchdogReported) return;
		state.watchdogReported = true;
		const snapshot = diagnosticSnapshot();
		snapshot.elapsedMs = Date.now() - state.startedAt;
		if (!state.connectCalled) {
			log.error('[GATEWAY] CONNECTION NOT STARTED');
			log.error('[DIAG] Worker is alive but no Gateway connection was initiated.');
			log.error('[DIAG] Check Eris client initialization and connect() execution.');
			if (!state.stages.has('ipc_connect_received')) {
				log.error(
					'[DIAG] The shard assignment (IPC "connect" message) was never received from the master — ' +
						'eris-sharder never created an Eris client in this worker.'
				);
			} else if (!state.stages.has('sharder_constructed')) {
				log.error(
					'[DIAG] The shard assignment arrived but eris-sharder did not finish initialising.'
				);
			} else {
				log.error(
					'[DIAG] The shard assignment arrived but Eris Client#connect() was never invoked — ' +
						'the failure is inside Cluster.connect(), not in the gateway.'
				);
			}
		} else if (!state.websocketOpened) {
			log.error('[GATEWAY] WEBSOCKET NOT OPENED');
			log.error(
				'[DIAG] connect() ran but no socket reached Discord — DNS/IPv6, blocked egress on 443 or a ' +
					'proxy are the usual causes; run node index.js --doctor for the gateway probe.'
			);
		} else {
			log.error('[GATEWAY] READY TIMEOUT');
			log.error(
				'[DIAG] The socket opened but Discord did not complete IDENTIFY/READY — see the close code ' +
					'above (4004 token, 4014 privileged intent, 4010/4011 shard config).'
			);
		}
		for (const line of formatDiagnostics(snapshot)) log.error(line);
		log.error(
			'[ACTION] run: node index.js --doctor (and --connect with the server stopped) on this host, ' +
				'then compare [info] source build with the [BOOT] running build line'
		);
		reportStage('watchdog_fired', `first_missing=${snapshot.firstMissing}`);
	}, timeoutMs);
	if (typeof timer.unref === 'function') timer.unref();
	log.debug(`[GATEWAY] startup watchdog armed (${timeoutMs}ms)`);
	return timer;
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
		state.websocketOpened = true;
		markStage('websocket_open', `shard ${id}`);
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
		state.lastError = state.lastErrorMessage;
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
	state.startedAt = state.startedAt || Date.now();
	if (!state.stages.size) {
		// Armed in every process; the worker is the one that must reach READY.
		markStage('process_started', `pid ${process.pid} isWorker=${require('cluster').isWorker}`);
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
		markStage(
			'connect_called',
			`${this.constructor ? this.constructor.name : 'Client'} at ${Date.now() - state.startedAt}ms`
		);
		let connected;
		try {
			connected = originalConnect.apply(this, args);
		} catch (err) {
			state.lastError = err && err.message;
			log.error(`[GATEWAY] connect() threw synchronously: ${state.lastError}`);
			return Promise.reject(err);
		}
		// connect() spawns the shards; rawWS is emitted on the shard, never on the
		// client, so the shards can only be traced once they exist. A rejected
		// connect() (e.g. /gateway unreachable through the synced REST handler) used
		// to disappear as an unhandled rejection.
		Promise.resolve(connected)
			.then(() => instrumentClientShards(this))
			.catch((err) => {
				state.lastError = (err && err.message) || String(err);
				log.error(`[GATEWAY] connect() rejected: ${state.lastError}`);
				log.error(
					'[DIAG] eris could not even resolve the gateway URL / start the shard manager — ' +
						'this is usually REST (/gateway) or the SyncedRequestHandler, not the socket'
				);
				markStage('connect_failed', state.lastError);
			});
		return connected;
	};
	proto.__oceanGatewayPatched = true;
	installed = true;
	log.debug('[GATEWAY] instrumentation installed (presence in IDENTIFY + lifecycle logging)');
	return true;
}

module.exports = {
	GATEWAY_OPCODES,
	STARTUP_STAGES,
	install,
	identifyPresence,
	attachLogging,
	instrumentShard,
	instrumentClientShards,
	markPhase,
	phaseSummary,
	closeCodeOf,
	readyTimeoutMs,
	//
	markStage,
	hasStage,
	firstMissingStage,
	stageTable,
	diagnosticSnapshot,
	formatDiagnostics,
	armStartupWatchdog,
	connectTimeoutMs,
	reportStage,
	state,
};
