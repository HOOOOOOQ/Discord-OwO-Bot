/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The Redis replacement: hashes, counters, sorted sets, sets and expiry, all
 * stored in MongoDB. `src/utils/redis.js` is a thin alias layer on top, so these
 * cases cover both modules — the ~460 `p.redis.*` call sites in the bot.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { MemoryStore } = require('../src/utils/mongo/store.js');

function installStore() {
	const store = new MemoryStore();
	store.connect();
	const resolved = require.resolve(path.join(__dirname, '../src/utils/mongo/client.js'));
	require.cache[resolved] = {
		id: resolved,
		filename: resolved,
		loaded: true,
		exports: {
			getStore: () => store,
			isConnected: () => true,
			whenReady: async () => store,
			connect: async () => store,
			close: async () => {},
		},
		children: [],
		paths: [],
	};
	delete require.cache[require.resolve(path.join(__dirname, '../src/utils/kv.js'))];
	delete require.cache[require.resolve(path.join(__dirname, '../src/utils/redis.js'))];
	return { store, kv: require('../src/utils/kv.js'), redis: require('../src/utils/redis.js') };
}

test('hash fields round-trip, including numbers', async () => {
	const { kv } = installStore();
	await kv.hset('cd_1', 'daily', '2026-01-01 00:00:00');
	await kv.hset('cd_1', 'streak', 5);
	assert.strictEqual(await kv.hget('cd_1', 'daily'), '2026-01-01 00:00:00');
	assert.strictEqual(await kv.hget('cd_1', 'streak'), 5);
	assert.strictEqual(await kv.hget('cd_1', 'missing'), null);
	assert.deepStrictEqual(Object.keys(await kv.hgetall('cd_1')).sort(), ['daily', 'streak']);
});

test('hincrby returns the new value and stays atomic', async () => {
	const { kv } = installStore();
	assert.strictEqual(await kv.hincrby('data_1', 'hunt', 1), 1);
	assert.strictEqual(await kv.hincrby('data_1', 'hunt', 4), 5);
	await Promise.all(Array.from({ length: 20 }, () => kv.hincrby('data_1', 'hunt', 1)));
	assert.strictEqual(await kv.hget('data_1', 'hunt'), 25);
});

test('hmget/hmset/hdel behave like the Redis calls they replace', async () => {
	const { kv } = installStore();
	await kv.hmset('data_1', { emblem: 2, emblem_reset: 1 });
	assert.deepStrictEqual(await kv.hmget('data_1', ['emblem', 'emblem_reset', 'nope']), [
		2,
		1,
		null,
	]);
	assert.strictEqual(await kv.hdel('data_1', 'emblem'), 1);
	assert.strictEqual(await kv.hget('data_1', 'emblem'), null);
	assert.strictEqual(await kv.hdel('data_1', 'emblem'), 0);
});

test('sorted sets: increment, score, rank, top and range', async () => {
	const { kv } = installStore();
	await kv.zincrby('user_xp', '1', 50);
	await kv.zincrby('user_xp', '2', 120);
	await kv.zincrby('user_xp', '3', 80);
	assert.strictEqual(await kv.zscore('user_xp', '2'), 120);
	assert.strictEqual(await kv.zrevrank('user_xp', '2'), 0, 'highest score ranks first');
	assert.strictEqual(await kv.zrevrank('user_xp', '1'), 2);
	const top = await kv.zrevrange('user_xp', 0, 1);
	assert.deepStrictEqual(top, ['2', '120', '3', '80']);
	const page = await kv.zrevrange('user_xp', 1, 2);
	assert.deepStrictEqual(page, ['3', '80', '1', '50']);
	assert.strictEqual(await kv.zrem('user_xp', '2'), 1);
	assert.strictEqual(await kv.zscore('user_xp', '2'), null);
});

test('the redis alias exposes the same results the commands expect', async () => {
	const { redis } = installStore();
	await redis.incr('user_xp', '42', 30);
	assert.strictEqual(await redis.getXP('user_xp', '42'), 30);
	assert.strictEqual(await redis.getRank('user_xp', '42'), 0);
	assert.deepStrictEqual(await redis.getTop('user_xp', 5), ['42', '30']);
	await redis.hset('123', 'prefix', '!');
	assert.strictEqual(await redis.hget('123', 'prefix'), '!');
	await redis.hdel('123', 'prefix');
	assert.strictEqual(await redis.hget('123', 'prefix'), null);
});

test('sets and plain keys', async () => {
	const { kv } = installStore();
	assert.strictEqual(await kv.sadd('optOut', '1'), 1);
	assert.strictEqual(await kv.sadd('optOut', '1'), 0);
	assert.ok(await kv.sismember('optOut', '1'));
	assert.deepStrictEqual(await kv.smembers('optOut'), ['1']);
	await kv.set('flag', 'on');
	assert.strictEqual(await kv.get('flag'), 'on');
	assert.strictEqual(await kv.exists('flag'), 1);
	assert.strictEqual(await kv.del('flag'), 1);
	assert.strictEqual(await kv.del('flag'), 0);
});

test('an expired key is invisible and gets purged', async () => {
	const { kv, store } = installStore();
	await kv.hset('session', 'token', 'abc');
	await kv.expire('session', -1);
	assert.strictEqual(await kv.hget('session', 'token'), null);
	const remaining = await store.collection('_kv').find({});
	assert.strictEqual(remaining.length, 0);
});

test('purgeExpired removes stale documents', async () => {
	const { kv, store } = installStore();
	await kv.hset('live', 'a', 1);
	await kv.hset('stale', 'a', 1);
	await store
		.collection('_kv')
		.updateOne({ _id: 'stale' }, { $set: { exp: new Date(Date.now() - 1000) } });
	const removed = await kv.purgeExpired();
	assert.strictEqual(removed, 1);
	assert.strictEqual(await kv.hget('live', 'a'), 1);
});

test('prefix data survives a "restart" (new module instance, same store)', async () => {
	const store = new MemoryStore();
	await store.connect();
	const resolved = require.resolve(path.join(__dirname, '../src/utils/mongo/client.js'));
	require.cache[resolved] = {
		id: resolved,
		filename: resolved,
		loaded: true,
		exports: { getStore: () => store, isConnected: () => true, whenReady: async () => store },
		children: [],
		paths: [],
	};
	const kvPath = require.resolve(path.join(__dirname, '../src/utils/kv.js'));
	delete require.cache[kvPath];
	const first = require(kvPath);
	await first.hset('555', 'prefix', '!');

	delete require.cache[kvPath];
	const second = require(kvPath);
	assert.strictEqual(await second.hget('555', 'prefix'), '!');
});
