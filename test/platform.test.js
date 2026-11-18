/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * "No extra services" guarantees:
 *
 *   - the optional log sinks (InfluxDB) make no network call when unconfigured,
 *   - nothing opens a socket to 127.0.0.1 / localhost at import time,
 *   - the key/value store waits for MongoDB instead of throwing during boot,
 *   - help/invite carry a real clickable "Join Community" button.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

function mockModule(relativePath, exports) {
	const resolved = require.resolve(path.join(ROOT, relativePath));
	require.cache[resolved] = {
		id: resolved,
		filename: resolved,
		loaded: true,
		exports,
		children: [],
		paths: [],
	};
	return resolved;
}

test('InfluxDB stays silent when INFLUXDB_HOST is not configured', async () => {
	const calls = [];
	mockModule('src/utils/http.js', (...args) => {
		calls.push(args);
	});
	delete process.env.INFLUXDB_HOST;
	delete require.cache[require.resolve(path.join(ROOT, 'src/utils/logger.js'))];
	const logger = require('../src/utils/logger.js');
	assert.strictEqual(logger.influxEnabled(), false);
	logger.command('help', { author: { id: '1' } });
	logger.logstash('help', {
		msg: { author: { id: '1' }, content: 'ohelp', channel: { guild: null } },
	});
	logger.logstashQos('ready', {});
	logger.logstashCaptcha({ user: '1' });
	assert.deepStrictEqual(calls, [], 'no HTTP request may leave the process');
});

test('no module imports a statsd client that talks to localhost', () => {
	const source = fs.readFileSync(path.join(ROOT, 'src/utils/logger.js'), 'utf8');
	assert.ok(!/new SDC\(/.test(source), 'the statsd-client instance must be gone');
	assert.ok(
		!/host:\s*'localhost'/.test(source),
		'no datastore/metrics socket may point at loopback'
	);
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.strictEqual(
		(pkg.dependencies || {})['statsd-client'],
		undefined,
		'statsd-client is unused and must not be a dependency'
	);
});

test('the key/value store waits for MongoDB instead of throwing', async () => {
	const { MemoryStore } = require('../src/utils/mongo/store.js');
	const store = new MemoryStore();
	await store.connect();
	let ready = false;
	mockModule('src/utils/mongo/client.js', {
		getStore() {
			if (!ready) throw new Error('MongoDB is not connected yet');
			return store;
		},
		async whenReady() {
			await new Promise((resolve) => setTimeout(resolve, 20));
			ready = true;
			return store;
		},
		isConnected: () => ready,
	});
	delete require.cache[require.resolve(path.join(ROOT, 'src/utils/kv.js'))];
	const kv = require('../src/utils/kv.js');
	// Called immediately: at this point getStore() still throws.
	const value = await kv.hget('boot', undefined).catch(() => 'no');
	assert.strictEqual(value, null);
	await kv.hset('boot', 'prefix', '!');
	assert.strictEqual(await kv.hget('boot', 'prefix'), '!');
});

const communityLink = require('../src/utils/communityLink.js');

test('the community button is a real link button with the 666family invite', () => {
	const config = { guildlink: 'https://discord.gg/666family' };
	const components = communityLink.components(config);
	assert.ok(Array.isArray(components) && components.length === 1);
	const button = components[0].components[0];
	assert.strictEqual(components[0].type, 1, 'action row');
	assert.strictEqual(button.type, 2, 'button');
	assert.strictEqual(button.style, 5, 'link button (clickable, no interaction)');
	assert.strictEqual(button.url, 'https://discord.gg/666family');
	assert.strictEqual(button.label, 'Join Community');
});

test('a missing or invalid invite sends the embed without components', () => {
	assert.strictEqual(communityLink.inviteUrl(null), communityLink.DEFAULT_LINK);
	assert.strictEqual(communityLink.inviteUrl({ guildlink: 'not a url' }), null);
	assert.strictEqual(communityLink.inviteUrl({ guildlink: 'https://example.com/invite' }), null);
	assert.strictEqual(
		communityLink.components({ guildlink: '' })[0].components[0].url,
		communityLink.DEFAULT_LINK
	);
	assert.strictEqual(communityLink.components({ guildlink: 'javascript:alert(1)' }), undefined);
	const payload = { embed: { title: 'x' } };
	assert.strictEqual(communityLink.attach(payload, { guildlink: 'nope' }), payload);
	assert.strictEqual(payload.components, undefined);
});

test('help and invite actually use the community button', () => {
	const help = fs.readFileSync(path.join(ROOT, 'src/commands/commandList/utils/help.js'), 'utf8');
	const invite = fs.readFileSync(
		path.join(ROOT, 'src/commands/commandList/utils/invite.js'),
		'utf8'
	);
	assert.match(help, /communityLink\.attach\(/);
	assert.match(invite, /communityLink\.attach\(/);
});

test('presence is re-applied on ready and after a resume', () => {
	const ready = fs.readFileSync(path.join(ROOT, 'src/eventHandlers/ready.js'), 'utf8');
	const resume = fs.readFileSync(path.join(ROOT, 'src/eventHandlers/shardResume.js'), 'utf8');
	assert.match(ready, /presence\.apply\(/);
	assert.match(resume, /presence\.apply\(/);
});
