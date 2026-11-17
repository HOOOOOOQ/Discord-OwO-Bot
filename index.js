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

(async () => {
	try {
		// Worker clusters receive their shard range over IPC from the master, so
		// they must not require any shard configuration of their own. (They used
		// to throw here and never connect, which left the bot offline while the
		// master process stayed alive.)
		if (cluster.isMaster) {
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
				log.info('shard config: ' + describeShardConfig(resolved));
			}

			// Token + privileged-intent check. A disabled MESSAGE CONTENT INTENT used
			// to leave the bot online but deaf; requesting it while disabled makes
			// Discord close the gateway with 4014. This keeps the two in sync.
			await diagnostics.check({ config });
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
