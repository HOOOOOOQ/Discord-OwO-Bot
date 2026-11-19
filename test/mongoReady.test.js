/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * `MONGODB_NOT_READY` used to be thrown at the first message that arrived while
 * the cluster was still connecting — the user saw a broken command instead of a
 * working bot. `whenReady()` now keeps retrying (a database that is slow to come
 * up is not a fatal error) and only gives up after its timeout, with the real
 * reason attached.
 */

const assert = require('node:assert');
const { test } = require('node:test');

process.env.MONGO_OFFLINE = 'false';
process.env.MONGODB_URI = 'mysql://not-a-mongo-uri/ocean';

const client = require('../src/utils/mongo/client.js');

test('getStore() refuses to invent a connection', () => {
	assert.throws(() => client.getStore(), /not connected yet/);
	assert.strictEqual(client.isConnected(), false);
});

test('whenReady retries instead of failing on the first attempt', async () => {
	const started = Date.now();
	await assert.rejects(
		() => client.whenReady(600),
		(err) => {
			assert.strictEqual(err.code, 'MONGODB_NOT_READY');
			assert.match(err.message, /not ready/i);
			assert.match(err.message, /last error:.*mysql/i, 'the real reason is attached');
			assert.ok(err.cause, 'the underlying failure is preserved as `cause`');
			return true;
		}
	);
	assert.ok(Date.now() - started >= 500, 'it kept trying until the timeout, not just once');
});

test('MONGO_OFFLINE keeps verification runs fast and explicit', async () => {
	process.env.MONGO_OFFLINE = 'true';
	await assert.rejects(
		() => client.whenReady(50),
		(err) => err.code === 'MONGODB_OFFLINE'
	);
	process.env.MONGO_OFFLINE = 'false';
});
