/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Decides which shards this process should run.
 *
 * Upstream OwO read that from its own private "sharder server" (SHARDER_HOST),
 * which does not exist for self-hosters, so a stock checkout could not boot at
 * all. Resolution order:
 *
 *   1. SHARDS / SHARD_FIRST / SHARD_LAST environment overrides
 *   2. SHARDER_HOST, when the operator really does run that service
 *   3. Discord's recommended shard count (GET /gateway/bot)
 *   4. a single shard, if Discord is unreachable
 *
 * Never throws: a broken upstream must not stop the bot from starting.
 */

const log = require('./log.js');
const discordApi = require('./discordApi.js');

const MAX_SHARDS = 1000;

function toInt(value) {
	if (value === undefined || value === null || value === '') return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) ? parsed : null;
}

function validate(candidate, source) {
	const shards = toInt(candidate && candidate.shards);
	const firstShardID = toInt(candidate && candidate.firstShardID);
	const lastShardID = toInt(candidate && candidate.lastShardID);

	if (!shards || shards < 1 || shards > MAX_SHARDS) return null;
	const first = firstShardID === null ? 0 : firstShardID;
	const last = lastShardID === null ? shards - 1 : lastShardID;
	if (first < 0 || last < first || last >= shards) return null;

	return { shards, firstShardID: first, lastShardID: last, source, count: last - first + 1 };
}

function fromEnv(env) {
	const shards = toInt(env.SHARDS);
	const first = toInt(env.SHARD_FIRST);
	const last = toInt(env.SHARD_LAST);
	if (shards === null && first === null && last === null) return null;
	// Deriving the total from the range keeps `SHARD_FIRST=0 SHARD_LAST=0` valid.
	const total = shards === null ? (last === null ? 1 : last + 1) : shards;
	return validate({ shards: total, firstShardID: first, lastShardID: last }, 'env');
}

async function fromSharderServer(env, fetchSharder) {
	if (!env.SHARDER_HOST) return null;
	const result = await fetchSharder(env);
	return validate(
		{
			shards: result && result.shards,
			firstShardID: result && result.firstShardID,
			lastShardID: result && result.lastShardID,
		},
		'sharder'
	);
}

async function fromDiscord(token, fetchGateway) {
	const result = await fetchGateway(token);
	if (!result || result.ok === false) {
		throw new Error((result && result.error) || 'gateway lookup failed');
	}
	const recommended = toInt(result.data && result.data.shards);
	return validate({ shards: recommended }, 'discord');
}

function defaultSharderFetch(env) {
	// Reuses the existing HTTP client so timeouts/logging stay in one place.
	const sharder = require('../../utils/request.js');
	return sharder.fetchInit(env);
}

/**
 * @param {Object} options
 * @param {String} [options.token] bot token, used for the Discord fallback
 * @param {Object} [options.env] environment (defaults to process.env)
 * @param {Function} [options.fetchGateway] injectable Discord gateway lookup
 * @param {Function} [options.fetchSharder] injectable sharder-server lookup
 * @param {Object} [options.logger] injectable logger
 */
async function resolveShardConfig(options = {}) {
	const env = options.env || process.env;
	const logger = options.logger || log;
	const fetchGateway = options.fetchGateway || ((token) => discordApi.getBotGateway(token));
	const fetchSharder = options.fetchSharder || defaultSharderFetch;
	const notes = [];

	const candidates = [
		() => fromEnv(env),
		() => fromSharderServer(env, fetchSharder),
		() => fromDiscord(options.token || env.BOT_TOKEN, fetchGateway),
	];

	for (const candidate of candidates) {
		try {
			const config = await candidate();
			if (config) return { ...config, notes };
		} catch (err) {
			notes.push(err && err.message ? err.message : String(err));
			logger.warn(`shard config: ${err && err.message ? err.message : err}`);
		}
	}

	notes.push('falling back to a single shard');
	logger.warn('shard config: falling back to a single shard (0~0)');
	return { shards: 1, firstShardID: 0, lastShardID: 0, source: 'fallback', count: 1, notes };
}

function describe(config) {
	if (!config) return 'unknown';
	const origin =
		{
			env: 'SHARDS env',
			sharder: 'SHARDER_HOST',
			discord: "Discord's recommendation",
			fallback: 'fallback',
		}[config.source] || config.source;
	return `shards ${config.firstShardID}~${config.lastShardID} of ${config.shards} (${origin})`;
}

module.exports = { resolveShardConfig, describe, validate, fromEnv, MAX_SHARDS };
