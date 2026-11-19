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
			// A panel only shows "running" while this process lives, so an endless
			// respawn loop hides the failure completely. Stop instead of forking
			// forever: the panel then reports the crash and the reason above.
			if (String(process.env.EXIT_ON_CRASH_LOOP || 'true').toLowerCase() !== 'false') {
				log.error(
					'[FATAL] stopping the master to end the restart loop — fix the error above, then start again ' +
						'(EXIT_ON_CRASH_LOOP=false keeps it respawning)'
				);
				process.exit(1);
			}
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
	// Eris client. Two defects make it unreliable:
	//
	//   1. `Queue#queueItem` only executes while the queue is empty and nothing
	//      ever removes `queue[0]`, so after the first assignment every cluster
	//      *restart* is queued and never sent (worker online, no gateway, no log).
	//   2. A throw inside the async `execute` handler is swallowed.
	//
	// `installQueueFix` repairs (1) in this process (no node_modules edit) and
	// records whether each send actually happened; the fallback below only steps in
	// when the library could not deliver, so a worker can never be sent two
	// assignments (two Eris clients).
	const ackedBy = new Map(); // clusterId -> worker id that acknowledged
	const deliveries = new Map();
	const libraryError = (clusterId) => shardAssignment.libraryDeliveryError(sharder, clusterId);

	cluster.on('message', (worker, message) => {
		if (!message || message.name !== 'oceanStage') return;
		if (message.stage !== 'ipc_connect_received' && message.stage !== 'connect_called') return;
		const clusterId = Number.isInteger(message.clusterId) ? message.clusterId : null;
		if (clusterId === null) return;
		const previous = ackedBy.get(clusterId);
		if (previous === worker.id) return;
		ackedBy.set(clusterId, worker.id);
		if (previous !== undefined && previous !== worker.id) {
			log.info(
				`[CLUSTER] cluster ${clusterId} is served by worker ${worker.id} now ` +
					`(was ${previous}) — its shard assignment was delivered again`
			);
		}
		// Erase any queued duplicate so a second connect can never be delivered.
		if (shardAssignment.dropQueuedAssignment(sharder, clusterId)) {
			log.debug(`[CLUSTER] dropped eris-sharder's duplicate assignment for cluster ${clusterId}`);
		}
	});

	/** A cluster is only "delivered" for the worker that is running right now. */
	const handleFor = (entry) => {
		if (ackedBy.get(entry.clusterId) === entry.workerId) return 'acked';
		return shardAssignment.libraryDelivered(sharder, entry.clusterId) ? 'library' : 'pending';
	};

	const attempt = (why) => {
		let report;
		try {
			report = shardAssignment.deliverPending({
				sharder,
				workers: cluster.workers,
				// Skip when this very worker acknowledged, or when eris-sharder's own
				// send for this cluster succeeded. Everything else is a real gap.
				acknowledgedFor: (entry) => handleFor(entry) !== 'pending',
			});
		} catch (err) {
			log.error(`[CLUSTER] could not read eris-sharder's cluster plan: ${err.message}`);
			return false;
		}
		for (const entry of report.attempted) {
			const previous = (deliveries.get(entry.clusterId) || 0) + 1;
			deliveries.set(entry.clusterId, previous);
			const reason = libraryError(entry.clusterId);
			if (entry.ok) {
				log.warn(
					`[CLUSTER] sent the shard assignment for cluster ${entry.clusterId} (shards ` +
						`${entry.firstShardID}~${entry.lastShardID}) to worker ${entry.workerId} directly — ` +
						`eris-sharder did not deliver it${reason ? ` (${reason})` : ''}` +
						(why ? ` [${why}]` : '') +
						` (attempt ${previous})`
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

	// Every new worker gets its own attempts: a respawn (crash, panel restart of a
	// cluster, OOM) starts with an empty acknowledgement, and the library may or
	// may not have managed the send.
	const forkAttempts = [1200, 3500, 8000];
	cluster.on('fork', () => {
		for (const delay of forkAttempts) {
			const timer = setTimeout(() => attempt('respawn'), delay);
			if (typeof timer.unref === 'function') timer.unref();
		}
	});

	// Plus a slow safety sweep for the first two minutes: if a worker is alive and
	// still has not acknowledged anything, say so with the real reason instead of
	// letting the process sit there looking healthy.
	const sweepUntil = startedAt + 120000;
	let sweeps = 0;
	const sweep = setInterval(() => {
		if (Date.now() > sweepUntil) {
			clearInterval(sweep);
			return;
		}
		const missing = shardAssignment.plan(sharder).filter((entry) => handleFor(entry) === 'pending');
		if (!missing.length) return;
		sweeps += 1;
		attempt('sweep');
		if (sweeps === 3 || sweeps % 6 === 0) {
			log.error(
				`[GATEWAY] no acknowledgement from ${missing
					.map((entry) => `cluster ${entry.clusterId} (worker ${entry.workerId})`)
					.join(', ')} — the worker has no Eris client yet`
			);
			const report = shardAssignment.queueState(sharder);
			log.error(
				`[DIAG] eris-sharder queue: ${report.known ? `${report.pending} pending` : 'unknown'}` +
					(report.pending ? ` [${report.clusters.join(', ')}]` : '') +
					'; assignments are delivered by the master when the library drops them.'
			);
		}
	}, 5000);
	if (typeof sweep.unref === 'function') sweep.unref();

	// First attempt as soon as the plan exists (the fork handler above already
	// covers workers, this covers a plan that appears before any fork event).
	for (const delay of [1500, 6000]) {
		const t = setTimeout(() => attempt('boot'), delay);
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
				// Use the normalised token: a panel value pasted as `Bot <token>` is
				// rejected by GET /gateway/bot (401) and the shard count then silently
				// falls back to 1.
				const resolved = await resolveShardConfig({
					token: tokenUtil.strip(process.env.BOT_TOKEN).token,
				});
				shards = resolved.shards;
				firstShardID = resolved.firstShardID;
				lastShardID = resolved.lastShardID;
				if (config.clusters > shards) config.clusters = shards;
				log.info('[SHARD] ' + describeShardConfig(resolved));
			}

			log.info(
				`[ENV] configuration loaded — prefix=${config.prefix} debug=${debug} ` +
					`clusters=${config.clusters} shards=${shards} intents=${config.eris.clientOptions.intents}`
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
		log.info('[DATABASE] connecting to MongoDB...');
		try {
			await mongoClient.connect();
			log.info('[DATABASE] connected — the bot can read and write its data');
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
				'[DISCORD] connecting to the gateway — shards ' +
					firstShardID +
					'~' +
					lastShardID +
					' of ' +
					shards +
					', ' +
					config.clusters +
					' cluster(s)'
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

		if (cluster.isMaster && shardAssignment.installQueueFix(sharder)) {
			log.info(
				"[CLUSTER] repaired eris-sharder's assignment queue — a restarted cluster gets its " +
					'shard assignment again (the library only delivers the first one)'
			);
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
