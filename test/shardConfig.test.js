const test = require('node:test');
const assert = require('node:assert');

const { resolveShardConfig, describe, validate } = require('../src/utils/shardConfig.js');

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

test('SHARDS/SHARD_FIRST/SHARD_LAST win over everything else', async () => {
	const config = await resolveShardConfig({
		env: { SHARDS: '8', SHARD_FIRST: '2', SHARD_LAST: '3' },
		fetchGateway: () => assert.fail('should not call Discord'),
		fetchSharder: () => assert.fail('should not call the sharder server'),
		logger: silentLogger,
	});
	assert.deepStrictEqual(
		{
			shards: config.shards,
			first: config.firstShardID,
			last: config.lastShardID,
			source: config.source,
		},
		{ shards: 8, first: 2, last: 3, source: 'env' }
	);
});

test('only SHARD_LAST given derives the total shard count', async () => {
	const config = await resolveShardConfig({
		env: { SHARD_LAST: '0' },
		logger: silentLogger,
	});
	assert.strictEqual(config.shards, 1);
	assert.strictEqual(config.firstShardID, 0);
	assert.strictEqual(config.lastShardID, 0);
});

test('SHARDER_HOST is used when it answers', async () => {
	const config = await resolveShardConfig({
		env: { SHARDER_HOST: 'http://sharder:3000', SHARDER_SERVER: 'ocean' },
		fetchSharder: async () => ({ shards: 4, firstShardID: 0, lastShardID: 3 }),
		fetchGateway: () => assert.fail('should not call Discord'),
		logger: silentLogger,
	});
	assert.strictEqual(config.source, 'sharder');
	assert.strictEqual(config.count, 4);
});

test('without a sharder server the Discord recommendation is used', async () => {
	const seen = [];
	const config = await resolveShardConfig({
		env: {},
		token: 'token',
		fetchGateway: async (token) => {
			seen.push(token);
			return { ok: true, data: { shards: 2 } };
		},
		logger: silentLogger,
	});
	assert.deepStrictEqual(seen, ['token']);
	assert.strictEqual(config.source, 'discord');
	assert.deepStrictEqual([config.firstShardID, config.lastShardID], [0, 1]);
});

test('a broken sharder server falls back to a single shard instead of failing', async () => {
	const config = await resolveShardConfig({
		env: { SHARDER_HOST: 'http://down:3000' },
		fetchSharder: async () => {
			throw new Error('connect ECONNREFUSED');
		},
		fetchGateway: async () => ({ ok: false, error: 'fetch failed' }),
		logger: silentLogger,
	});
	assert.strictEqual(config.source, 'fallback');
	assert.strictEqual(config.shards, 1);
	assert.ok(config.notes.some((note) => /ECONNREFUSED/.test(note)));
});

test('invalid shard ranges are rejected', () => {
	assert.strictEqual(validate({ shards: 2, firstShardID: 2, lastShardID: 2 }, 'env'), null);
	assert.strictEqual(validate({ shards: 2, firstShardID: 1, lastShardID: 0 }, 'env'), null);
	assert.strictEqual(validate({ shards: 0 }, 'env'), null);
	assert.strictEqual(validate({ shards: 5000 }, 'env'), null);
	assert.deepStrictEqual(validate({ shards: 4, firstShardID: 1, lastShardID: 2 }, 'env'), {
		shards: 4,
		firstShardID: 1,
		lastShardID: 2,
		source: 'env',
		count: 2,
	});
});

test('describe names the origin of the shard range', () => {
	assert.match(
		describe({ shards: 2, firstShardID: 0, lastShardID: 1, source: 'discord' }),
		/0~1 of 2/
	);
	assert.match(
		describe({ shards: 2, firstShardID: 0, lastShardID: 1, source: 'discord' }),
		/Discord/
	);
});
