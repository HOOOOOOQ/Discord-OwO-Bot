/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The bot used to be reported as "online" from process liveness alone. These
 * tests pin the opposite contract: a gateway state is only ever recorded when
 * the corresponding packet/event was actually observed, and a close code is
 * always decoded from the real close frame.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const gatewayBoot = require('../src/utils/gatewayBoot.js');
const buildInfo = require('../src/utils/buildInfo.js');

// The module keeps process-wide state; every test starts from a clean slate.
function resetState() {
	gatewayBoot.state.phases.length = 0;
	gatewayBoot.state.readySeenAt = null;
	gatewayBoot.state.presenceSyncedAt = null;
	gatewayBoot.state.shards.clear();
	gatewayBoot.state.lastCloseCode = null;
}

/** Minimal stand-in for an eris shard: rawWS + sendWS on the prototype. */
class FakeShard extends EventEmitter {
	constructor(id) {
		super();
		this.id = id;
	}
	sendWS() {
		return true;
	}
	// Silence the logger during the assertions.
	debug() {}
	info() {}
	warn() {}
	error() {}
}

test('closeCodeOf decodes the eris "4004: reason" error string', () => {
	assert.strictEqual(gatewayBoot.closeCodeOf(new Error('4004: Authentication failed.')), 4004);
	assert.strictEqual(gatewayBoot.closeCodeOf(new Error('4014: Disallowed intents')), 4014);
	assert.strictEqual(gatewayBoot.closeCodeOf(new Error('socket hang up')), null);
	assert.strictEqual(gatewayBoot.closeCodeOf({ code: 1000 }), 1000);
	assert.strictEqual(gatewayBoot.closeCodeOf(4007), 4007);
	assert.strictEqual(gatewayBoot.closeCodeOf(null), null);
});

test('phases are only recorded when the packets arrive, in order', () => {
	resetState();
	assert.strictEqual(gatewayBoot.phaseSummary(), 'no gateway events observed');

	const shard = new FakeShard(0);
	gatewayBoot.instrumentShard(shard);

	shard.emit('rawWS', { op: 10, d: { heartbeat_interval: 41250 } });
	shard.emit('rawWS', { op: 11 });
	shard.emit('rawWS', {
		op: 0,
		t: 'READY',
		d: {
			user: { username: 'OCEAN', discriminator: '0' },
			guilds: [{ id: '1' }],
			session_id: 'abcdef123456',
		},
	});

	const stages = gatewayBoot.state.phases.map((entry) => entry.stage);
	assert.deepStrictEqual(stages, ['HELLO_RECEIVED', 'HEARTBEAT_ACKNOWLEDGED', 'READY_RECEIVED']);
	assert.ok(gatewayBoot.state.readySeenAt, 'READY timestamp must be recorded');
	assert.ok(
		!gatewayBoot.state.presenceSyncedAt,
		'presence is NOT synced just because READY arrived'
	);
	assert.match(gatewayBoot.state.phases[0].detail, /heartbeat_interval=41250ms/);
	assert.match(gatewayBoot.state.phases[2].detail, /guilds=1/);
});

test('IDENTIFY is recorded from sendWS, including its presence and intents', () => {
	resetState();
	const shard = new FakeShard(0);
	gatewayBoot.instrumentShard(shard);

	shard.sendWS(2, {
		token: 'never-logged',
		intents: 130813,
		shard: [0, 1],
		presence: { status: 'online', activities: [{ name: 'o help', type: 0 }] },
	});

	const identify = gatewayBoot.state.phases.find((entry) => entry.stage === 'IDENTIFY_SENT');
	assert.ok(identify, 'IDENTIFY must be visible without any eris debug output');
	assert.match(identify.detail, /intents=130813/);
	assert.match(identify.detail, /presence=online/);
	assert.match(identify.detail, /shard=\[0\/1\]/);
	assert.ok(
		!JSON.stringify(gatewayBoot.state.phases).includes('never-logged'),
		'the token must never be traced'
	);
});

test('a resume is reported as a resume, not as a fresh identify', () => {
	resetState();
	const shard = new FakeShard(1);
	gatewayBoot.instrumentShard(shard);
	shard.sendWS(6, { token: 'x', session_id: 'y', seq: 3 });
	assert.deepStrictEqual(
		gatewayBoot.state.phases.map((entry) => entry.stage),
		['RESUME_SENT']
	);
});

test('instrumenting the same shard twice does not duplicate listeners', () => {
	resetState();
	const shard = new FakeShard(0);
	gatewayBoot.instrumentShard(shard);
	gatewayBoot.instrumentShard(shard);
	shard.emit('rawWS', { op: 10, d: { heartbeat_interval: 1000 } });
	assert.strictEqual(
		gatewayBoot.state.phases.filter((entry) => entry.stage === 'HELLO_RECEIVED').length,
		1
	);
});

test('READY from one shard never claims that the bot is online', () => {
	resetState();
	const shard = new FakeShard(0);
	gatewayBoot.instrumentShard(shard);
	shard.emit('rawWS', { op: 0, t: 'READY', d: { user: {}, guilds: [] } });
	assert.strictEqual(gatewayBoot.state.readySeenAt !== null, true);
	assert.ok(
		!gatewayBoot.state.phases.some((entry) => entry.stage === 'BOT_ONLINE'),
		'BOT_ONLINE belongs to the client "ready" event (all shards), not to one shard READY'
	);
});

test('build fingerprint is stable and reports missing files', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-build-'));
	try {
		fs.writeFileSync(path.join(root, 'index.js'), 'console.log(1);\n');
		const first = buildInfo.fingerprint({ root, files: ['index.js'] });
		const second = buildInfo.fingerprint({ root, files: ['index.js'] });
		assert.strictEqual(first, second);
		assert.strictEqual(first.length, 12);

		fs.writeFileSync(path.join(root, 'index.js'), 'console.log(2);\n');
		assert.notStrictEqual(buildInfo.fingerprint({ root, files: ['index.js'] }), first);

		const missing = buildInfo.snapshot({ root, files: ['nope.js'] });
		assert.strictEqual(missing[0].hash, 'MISSING');
		assert.match(buildInfo.describe({ root, files: ['nope.js'] }), /missing: nope\.js/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the tracked build files cover the gateway critical path', () => {
	for (const file of ['index.js', 'src/utils/gatewayBoot.js', 'src/utils/presence.js']) {
		assert.ok(buildInfo.TRACKED_FILES.includes(file), `${file} must be part of the fingerprint`);
	}
});
