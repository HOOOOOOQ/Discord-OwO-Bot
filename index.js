/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */
require('dotenv').config();
if (!process.env.BOT_TOKEN) {
	// eslint-disable-next-line no-console
	console.error('Bot token not found in ~/.env file. Checking secret file instead...');
	require('dotenv').config({ path: './secret/env' });
	if (!process.env.BOT_TOKEN) {
		// eslint-disable-next-line no-console
		console.error('No bot token found. Please edit ./secret/env file and add your token');
		process.exitCode = 1;
		return;
	}
}

// `node index.js --verify` loads every command through the real registry and
// exits. Hosts that can only start the entrypoint (e.g. a Pterodactyl server
// whose startup command is fixed to index.js) use this instead of npm scripts.
if (process.argv.includes('--verify')) {
	const { verify, report } = require('./scripts/verifyCommands.js');
	const ok = report(verify());
	// the registry opens redis/mysql handles, so exit explicitly
	process.exit(ok ? 0 : 1);
}

// `node index.js --doctor` prints a read-only self-check (token, privileged
// intents, shard source, MONGODB_URI reachability) and exits. It
// never starts a shard, so it is safe to run on a live panel.
if (process.argv.includes('--doctor')) {
	// --connect additionally performs a real gateway login (opens a session).
	require('./src/utils/doctor.js')
		.run({ connect: process.argv.includes('--connect') })
		.then((ok) => process.exit(ok ? 0 : 1))
		.catch((err) => {
			// eslint-disable-next-line no-console
			console.error('doctor failed:', err);
			process.exit(1);
		});
	return;
}

// Gateway sockets (ws -> net/tls) do not do Happy Eyeballs, so a host with a
// broken IPv6 route hangs on AAAA while REST keeps working. Set the lookup
// order before anything can open a socket. See src/utils/discordDns.js.
const discordDns = require('./src/utils/discordDns.js');
const dnsResult = discordDns.apply(process.env);

// Config file (environment overrides applied inside the loader)
const config = require('./src/utils/config.js');
const log = require('./src/utils/log.js');
const errors = require('./src/utils/errors.js');

// Structured, redacted logging for the master process too
log.configure({ debug: config.debug, identity: 'master' });
log.installConsoleBridge();
config.validate();
errors.installProcessHandlers();

// Grab tokens and secret files
const debug = config.debug;
// dd-trace is a optional tracing agent: on a 2 GB panel it costs tens of MB of
// RSS for no benefit. Set DD_TRACE_ENABLED=false to skip loading it entirely.
if (!debug && String(process.env.DD_TRACE_ENABLED || 'true').toLowerCase() !== 'false') {
	require('dd-trace').init();
}

const rateLimitUtil = require('./utils/rateLimitUtil.js');
// Eris-Sharder
const Sharder = require('eris-sharder').Master;
const cluster = require('cluster');
const { resolveShardConfig, describe: describeShardConfig } = require('./src/utils/shardConfig.js');
const buildInfo = require('./src/utils/buildInfo.js');
const tokenUtil = require('./src/utils/token.js');
const gatewayProbe = require('./src/utils/gatewayProbe.js');
const gatewayBoot = require('./src/utils/gatewayBoot.js');
const shardAssignment = require('./src/utils/shardAssignment.js');
const diagnostics = require('./src/utils/diagnostics.js');

var shards, firstShardID, lastShardID;

// The sharder server of upstream OwO does not exist for self-hosters. Shards now
// come from SHARDS/SHARD_FIRST/SHARD_LAST, or SHARDER_HOST when configured, or
// Discord's recommendation — see src/utils/shardConfig.js.

/**
 * Worker lifecycle logging + crash-loop detection.
 *
 * eris-sharder re-forks a dead worker by itself, which is good for uptime but
 * hides a worker that dies instantly (bad token, missing secret file, thrown
 * constructor). A repeated exit is reported as a crash loop with the last error
 * hint instead of silently restarting forever.
 */
function watchWorkers() {
	const exits = [];
	const forkedAt = new Map();
	let respawns = 0;
	cluster.on('fork', (worker) => {
		forkedAt.set(worker.id, Date.now());
		respawns++;
		const suffix = respawns > 1 ? ` (respawn #${respawns - 1})` : '';
		log.info(`[CLUSTER] worker ${worker.id} forked${suffix}`);
	});
	cluster.on('online', (worker) => log.info(`[CLUSTER] worker ${worker.id} online`));
	cluster.on('exit', (worker, code, signal) => {
		const now = Date.now();
		const startedAt = forkedAt.get(worker.id);
		forkedAt.delete(worker.id);
		exits.push(now);
		while (exits.length && now - exits[0] > 60000) exits.shift();
		const uptime = startedAt ? `${now - startedAt}ms` : 'unknown time';
		log.warn(
			`[CLUSTER] worker ${worker.id} exited (code ${code}, signal ${
				signal || 'none'
			}) after ${uptime} — eris-sharder restarts it`
		);
		if (startedAt && now - startedAt < 10000) {
			log.error(
				`[ERROR] worker ${worker.id} died ${
					now - startedAt
				}ms after fork — it never had time to reach READY. ` +
					'The failure is above this line (token/intents/secret files/MONGODB_URI), not in the gateway.'
			);
		}
		if (exits.length >= 4) {
			log.error(
				`[ERROR] crash loop: ${exits.length} worker exits in 60s. The cluster never stays up, so the bot cannot be online.`
			);
			log.error('[ACTION] read the error lines above; then run: node index.js --doctor --connect');
		}
	});
}

/**
 * Gateway supervision from the master's side.
 *
 * The worker reports each startup stage over IPC (`oceanStage`), so the panel
 * shows the timeline even if the worker's own stdout is lost. If no worker ever
 * reports connect(), the master says so explicitly: a worker that is "online" is
 * not a bot that is online.
 */
function superviseGateway(workerCount, sharder) {
	const startedAt = Date.now();
	const stages = new Map();
	cluster.on('message', (worker, message) => {
		if (!message || message.name !== 'oceanStage') return;
		if (stages.has(message.stage)) return;
		stages.set(message.stage, { workerId: worker.id, at: message.at, detail: message.detail });
		log.info(
			`[CLUSTER] worker ${worker.id} gateway stage ${message.stage}` +
				(message.detail ? ` — ${message.detail}` : '')
		);
	});

	// ---- shard assignment delivery -----------------------------------------
	// eris-sharder's own queue is the only thing that makes a worker create an
	// Eris client, and a throw inside its async nextTick callback is swallowed.
	// Deliver the same message ourselves for every cluster that has not
	// acknowledged it, verify with the worker's stage beacon, and never send a
	// second copy once a worker is connected.
	const acknowledged = new Set();
	const deliveries = new Map();
	cluster.on('message', (worker, message) => {
		if (!message || message.name !== 'oceanStage') return;
		if (message.stage !== 'ipc_connect_received' && message.stage !== 'connect_called') return;
		const clusterId = Number.isInteger(message.clusterId) ? message.clusterId : null;
		if (clusterId === null || acknowledged.has(clusterId)) return;
		acknowledged.add(clusterId);
		// The worker owns the assignment now: remove eris-sharder's queued copy so it
		// can never be delivered twice (a second connect = a second Eris client).
		if (shardAssignment.dropQueuedAssignment(sharder, clusterId)) {
			log.debug(`[CLUSTER] dropped eris-sharder's duplicate assignment for cluster ${clusterId}`);
		}
	});

	/**
	 * When eris-sharder may be bypassed.
	 *
	 * - nothing has been delivered to any worker  → the library's queue is dead,
	 *   deliver immediately (this is the outage that was reported);
	 * - another cluster is already connected      → eris-sharder is alive and is
	 *   serialising the remaining clusters on purpose (to respect Discord's
	 *   identify concurrency), so only step in when it has been stuck for a while.
	 */
	const mayTakeOver = () => {
		if (acknowledged.size === 0) return true;
		return Date.now() - startedAt > 12000;
	};

	const attempt = () => {
		let report;
		try {
			report = shardAssignment.deliverPending({
				sharder,
				workers: cluster.workers,
				acknowledged,
				filter: mayTakeOver,
			});
		} catch (err) {
			log.error(`[CLUSTER] could not read eris-sharder's cluster plan: ${err.message}`);
			return false;
		}
		for (const entry of report.attempted) {
			const previous = (deliveries.get(entry.clusterId) || 0) + 1;
			deliveries.set(entry.clusterId, previous);
			if (entry.ok) {
				log.warn(
					`[CLUSTER] sent the shard assignment for cluster ${entry.clusterId} (shards ` +
						`${entry.firstShardID}~${entry.lastShardID}) to worker ${entry.workerId} directly — ` +
						`eris-sharder did not deliver it (attempt ${previous})`
				);
			} else {
				log.error(
					`[CLUSTER] could not send the shard assignment to worker ${entry.workerId}: ${entry.error}` +
						(entry.code ? ` (${entry.code})` : '')
				);
			}
		}
		return report.delivered > 0;
	};

	// First attempt as soon as the plan exists, then retries with backoff.
	// 1.5 s is already ~1000x the time eris-sharder's own send needs, so a healthy
	// library is never raced; the later attempts cover a queue that dies later.
	const attempts = [1500, 3000, 6000, 12000, 14000];
	for (const delay of attempts) {
		const t = setTimeout(() => attempt(), delay + 250);
		if (typeof t.unref === 'function') t.unref();
	}

	const timeoutMs = gatewayBoot.connectTimeoutMs(process.env) + 5000;
	const timer = setTimeout(() => {
		if (stages.has('ready_received')) return;
		const table = gatewayBoot.STARTUP_STAGES.map(
			(stage) =>
				`${stage}=${stages.has(stage) ? `${stages.get(stage).at - startedAt}ms` : 'NOT REACHED'}`
		);
		if (!stages.has('connect_called')) {
			log.error('[GATEWAY] CONNECTION NOT STARTED (master view)');
			log.error(
				`[DIAG] ${workerCount} worker(s) forked, none reported connect(); a worker "online" only means ` +
					'the process exists.'
			);
			if (!stages.has('ipc_connect_received')) {
				log.error(
					'[DIAG] No worker received the shard assignment over IPC — eris-sharder never sent "connect", ' +
						'so no Eris client was created anywhere.'
				);
			}
		} else if (!stages.has('websocket_open')) {
			log.error('[GATEWAY] WEBSOCKET NOT OPENED (master view)');
		} else {
			log.error('[GATEWAY] READY TIMEOUT (master view)');
		}
		log.error(`[DIAG] stages: ${table.join(' | ')}`);
		log.error(
			'[ACTION] node index.js --doctor (gateway probe, DNS order, shard plan) on this host'
		);
	}, timeoutMs);
	if (typeof timer.unref === 'function') timer.unref();
}

(async () => {
	try {
		if (cluster.isWorker) {
			// Early worker logs otherwise carry the master identity.
			log.setIdentity('cluster:boot');
			// Must run before eris-sharder creates the client: eris defaults to
			// presence "offline" inside IDENTIFY, and the worker has no listeners
			// until READY. See src/utils/gatewayBoot.js.
			const instrumented = gatewayBoot.install();
			// Watch the shard assignment itself: eris-sharder only creates the Eris
			// client when the master sends the "connect" message over IPC. If that
			// message never arrives the worker used to idle forever with no log at
			// all — indistinguishable from "connected but offline".
			process.prependListener('message', (message) => {
				if (message && message.name === 'connect') {
					gatewayBoot.state.clusterId = message.id;
					gatewayBoot.markStage(
						'ipc_connect_received',
						`cluster ${message.id}, shards ${message.firstShardID}~${message.lastShardID} of ${message.maxShards}`
					);
				}
			});
			gatewayBoot.state.clusterId = 0;
			gatewayBoot.armStartupWatchdog(process.env);
			log.info(
				`[BOOT] worker ${process.pid} mode confirmed (cluster.isWorker=true), ` +
					`gateway instrumentation installed=${instrumented}, ${buildInfo.describe()}`
			);
		}

		// Worker clusters receive their shard range over IPC from the master, so
		// they must not require any shard configuration of their own. (They used
		// to throw here and never connect, which left the bot offline while the
		// master process stayed alive.)
		if (cluster.isMaster) {
			log.info(
				`[BOOT] OCEAN starting — node ${process.version}, pid ${process.pid}, CLUSTERS=${config.clusters}`
			);
			log.info(
				`[BOOT] running ${buildInfo.describe()} (compare this with: node index.js --doctor)`
			);
			log.info(
				`[BOOT] dns lookup order=${dnsResult.order || 'default'}` +
					(dnsResult.reason ? ` (${dnsResult.reason})` : '')
			);
			if ((process.env.GATEWAY_PROBE_ON_BOOT || 'true').toLowerCase() !== 'false') {
				// Proves the WebSocket path to gateway.discord.gg works before any shard
				// exists. It never sends IDENTIFY, so no session is consumed.
				gatewayProbe
					.probe({ env: process.env })
					.then((result) => {
						if (result.ok) log.info(`[GATEWAY] probe: ${gatewayProbe.describe(result)}`);
						else log.error(`[GATEWAY] probe failed: ${gatewayProbe.describe(result)}`);
					})
					.catch((err) => log.debug(`[GATEWAY] probe crashed: ${err.message}`));
			}
			if (debug) {
				shards = 1;
				firstShardID = 0;
				lastShardID = 0;
				config.clusters = 1;
				log.info('shard config: DEBUG mode forces a single shard (0~0 of 1)');
			} else {
				const resolved = await resolveShardConfig({ token: process.env.BOT_TOKEN });
				shards = resolved.shards;
				firstShardID = resolved.firstShardID;
				lastShardID = resolved.lastShardID;
				if (config.clusters > shards) config.clusters = shards;
				log.info('[SHARD] ' + describeShardConfig(resolved));
			}

			log.info(
				`[CONFIG] prefix=${config.prefix} debug=${debug} clusters=${config.clusters} ` +
					`shards=${shards} intents=${config.eris.clientOptions.intents}`
			);

			// Token + privileged-intent check. A disabled MESSAGE CONTENT INTENT used
			// to leave the bot online but deaf; requesting it while disabled makes
			// Discord close the gateway with 4014. This keeps the two in sync.
			const report = await diagnostics.check({ config });
			if (report && report.user) {
				log.info(
					`[DISCORD] authentication successful — ${require('./src/utils/discordApi.js').formatUser(
						report.user
					)}`
				);
			}
			if (report && report.messageContentAllowed === false) {
				log.error(
					'[ERROR] MESSAGE CONTENT INTENT is disabled — the bot will connect but ignore every command'
				);
				log.error(`[ACTION] ${diagnostics.DEV_PORTAL_HINT}`);
			}
		}

		// ------------------------------------------------------------------
		// MongoDB must be reachable BEFORE the gateway connects. eris-sharder
		// calls bot.connect() first and only instantiates src/owo.js on READY,
		// so without this pre-flight a dead database looked exactly like "bot
		// online, every command silent" (and the old MySQL version crashed 2 s
		// after READY). Fail here, loudly, before any socket is opened.
		// ------------------------------------------------------------------
		const mongoClient = require('./src/utils/mongo/client.js');
		try {
			await mongoClient.connect();
		} catch (err) {
			log.error(`[MONGO] ${err.message}`);
			if (err.action) log.error(`[ACTION] ${err.action}`);
			log.error(
				'[FATAL] MongoDB is the only datastore — the bot cannot answer a single command ' +
					'without it. Fix MONGODB_URI and start again (exiting with code 1, no restart loop).'
			);
			process.exit(1);
		}

		if (cluster.isMaster) {
			log.info(
				'Creating shards ' +
					firstShardID +
					'~' +
					lastShardID +
					' out of ' +
					shards +
					' total shards!'
			);
		}

		// Start sharder. A panel value pasted as `Bot <token>` used to become
		// `Bot Bot <token>` and the gateway closed with 4004 — REST checks still
		// passed because discordApi normalised the header, so the bot looked
		// "valid but offline". One prefix, always (src/utils/token.js).
		const tokenInfo = tokenUtil.strip(process.env.BOT_TOKEN);
		// Only the master reports it: eris-sharder constructs its Master in every
		// process, so both would otherwise print the same warning.
		if (tokenInfo.changed && cluster.isMaster) {
			log.warn(
				`[CONFIG] BOT_TOKEN normalised — ${tokenUtil
					.describeChanges(tokenInfo)
					.join(', ')}; replace the panel variable with just the token`
			);
		}
		if (!tokenInfo.token) {
			log.error('[CONFIG] BOT_TOKEN is empty after normalisation — set it in the panel variables');
			if (cluster.isWorker) {
				// A worker that returns here stays alive with no client and no log,
				// which looks exactly like "connected but offline". Exit so the master
				// re-forks it and the crash-loop detector reports the real reason.
				log.error('[FATAL] worker cannot start without a token — exiting (code 1)');
				process.exit(1);
			}
			process.exitCode = 1;
			return;
		}
		let sharder;
		try {
			sharder = new Sharder(tokenUtil.botAuth(process.env.BOT_TOKEN), config.sharder.path, {
				name: config.sharder.name,
				clientOptions: config.eris.clientOptions,
				debug: true,
				shards,
				clusters: config.clusters,
				firstShardID,
				lastShardID,
			});
		} catch (err) {
			log.error(`[FATAL] eris-sharder Master constructor threw: ${err && err.message}`);
			log.error(err);
			// In a worker this used to fall through to an idle process with no Eris
			// client at all — the exact "worker online, gateway never starts"
			// signature. Exit so the master re-forks and the crash loop is reported.
			if (cluster.isWorker) process.exit(1);
			throw err;
		}

		if (cluster.isWorker) {
			gatewayBoot.markStage('sharder_constructed', `path ${config.sharder.path}`);
			log.info(
				'[BOOT] eris-sharder Master constructed in the worker — waiting for the shard assignment over IPC'
			);
		}

		if (cluster.isMaster) {
			watchWorkers();
			superviseGateway(config.clusters, sharder);
			// eris-sharder fills its cluster map inside process.nextTick, so the plan is
			// only complete a moment later.
			const planTimer = setTimeout(() => {
				if (!sharder || !sharder.clusters || !sharder.clusters.size) {
					log.warn('[SHARD] eris-sharder created no clusters');
					return;
				}
				const plan = [...sharder.clusters.entries()]
					.map(([id, info]) => {
						const range =
							info.firstShardID === undefined
								? 'no shard assigned'
								: `${info.firstShardID}~${info.lastShardID}`;
						return `cluster ${id} → worker ${info.workerID}, shards ${range}`;
					})
					.join(', ');
				const queue = shardAssignment.queueState(sharder);
				log.info(
					`[SHARD] plan: ${plan} (eris-sharder queue: ${queue.pending} pending` +
						(queue.pending ? ` [${queue.clusters.join(', ')}]` : '') +
						')'
				);
			}, 500);
			if (typeof planTimer.unref === 'function') planTimer.unref();
			rateLimitUtil.init(sharder.bucket, debug);
			errors.registerShutdownHook(async () => {
				log.info('Master shutting down, letting clusters exit');
			});
		}
	} catch (e) {
		log.error('Failed to start eris sharder');
		log.error(e);
		process.exitCode = 1;
	}
})();
