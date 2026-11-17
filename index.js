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
// intents, shard source, DATABASE_URL/REDIS_URL reachability) and exits. It
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
	cluster.on('fork', (worker) => log.info(`[CLUSTER] worker ${worker.id} forked`));
	cluster.on('online', (worker) => log.info(`[CLUSTER] worker ${worker.id} online`));
	cluster.on('exit', (worker, code, signal) => {
		const now = Date.now();
		exits.push(now);
		while (exits.length && now - exits[0] > 60000) exits.shift();
		log.warn(
			`[CLUSTER] worker ${worker.id} exited (code ${code}, signal ${
				signal || 'none'
			}) — eris-sharder restarts it`
		);
		if (exits.length >= 4) {
			log.error(
				`[ERROR] crash loop: ${exits.length} worker exits in 60s. The cluster never stays up, so the bot cannot be online.`
			);
			log.error('[ACTION] read the error lines above; then run: node index.js --doctor --connect');
		}
	});
}

(async () => {
	try {
		if (cluster.isWorker) {
			// Early worker logs otherwise carry the master identity.
			log.setIdentity('cluster:boot');
			// Must run before eris-sharder creates the client: eris defaults to
			// presence "offline" inside IDENTIFY, and the worker has no listeners
			// until READY. See src/utils/gatewayBoot.js.
			require('./src/utils/gatewayBoot.js').install();
		}

		// Worker clusters receive their shard range over IPC from the master, so
		// they must not require any shard configuration of their own. (They used
		// to throw here and never connect, which left the bot offline while the
		// master process stayed alive.)
		if (cluster.isMaster) {
			log.info(
				`[BOOT] OCEAN starting — node ${process.version}, pid ${process.pid}, CLUSTERS=${config.clusters}`
			);
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

		// Start sharder
		const sharder = new Sharder('Bot ' + process.env.BOT_TOKEN, config.sharder.path, {
			name: config.sharder.name,
			clientOptions: config.eris.clientOptions,
			debug: true,
			shards,
			clusters: config.clusters,
			firstShardID,
			lastShardID,
		});

		if (cluster.isMaster) {
			watchWorkers();
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
