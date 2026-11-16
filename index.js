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
if (!debug) require('dd-trace').init();

const rateLimitUtil = require('./utils/rateLimitUtil.js');
const request = require('./utils/request.js');
// Eris-Sharder
const Sharder = require('eris-sharder').Master;
var result, shards, firstShardID, lastShardID;
const cluster = require('cluster');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchInitWithRetry() {
	let lastError;
	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		try {
			return await request.fetchInit();
		} catch (err) {
			lastError = err;
			log.warn(
				`Could not reach the sharder server (attempt ${attempt}/${RETRY_ATTEMPTS}): ${
					err?.message || err
				}`
			);
			if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
		}
	}
	throw lastError;
}

(async () => {
	try {
		//determine how many shards we will need for this manager
		if (!debug && cluster.isMaster) {
			result = await fetchInitWithRetry();
			log.info('Sharder server response:', result);
			shards = parseInt(result['shards']);
			firstShardID = parseInt(result['firstShardID']);
			lastShardID = parseInt(result['lastShardID']);
		}
		if (debug) {
			shards = 1;
			firstShardID = 0;
			lastShardID = 0;
			config.clusters = 1;
		}

		if (!Number.isInteger(firstShardID) || !Number.isInteger(lastShardID) || !shards) {
			throw new Error('Sharder server returned an invalid shard configuration');
		}

		log.info(
			'Creating shards ' + firstShardID + '~' + lastShardID + ' out of ' + shards + ' total shards!'
		);

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
