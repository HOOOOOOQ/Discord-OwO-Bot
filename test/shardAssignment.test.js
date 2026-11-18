/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The outage this pins: the master logged `[SHARD] plan: cluster 0 → worker 1,
 * shards 0~0`, the worker logged `[BOOT] eris-sharder Master constructed …` and
 * then nothing — no `ipc_connect_received`, no client, no socket.
 *
 * In eris-sharder 1.10.0 that message is produced by `connectShards()` →
 * `queue.emit("execute")` → `master.workers[id].send(...)` inside an async
 * `process.nextTick`, where a throw is swallowed (only `uncaughtException` is
 * handled on the master) and the queue item is simply never delivered.
 *
 * `src/utils/shardAssignment.js` rebuilds the identical message and delivers it
 * over the cluster channel itself. These tests use a live `eris-sharder` Queue so
 * the payload and the "queue never delivered it" situation are the real ones.
 */

const assert = require('assert');
const path = require('path');
const { test } = require('node:test');

const shardAssignment = require('../src/utils/shardAssignment.js');

const Queue = require(path.join(
	path.dirname(require.resolve('eris-sharder')),
	'utils',
	'queue.js'
));

/** A stand-in for a forked worker that records what it receives. */
class FakeWorker {
	constructor(id, options = {}) {
		this.id = id;
		this.received = [];
		this.dead = Boolean(options.dead);
	}
	send(payload, callback) {
		if (this.dead)
			throw Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
		this.received.push(payload);
		if (typeof callback === 'function') callback(null);
		return true;
	}
	isDead() {
		return this.dead;
	}
}

/** Mirror of the ClusterManager fields the assignment message is built from. */
function fakeSharder(options = {}) {
	const queue = options.queue || new Queue();
	return {
		clusterCount: options.clusterCount || 1,
		shardCount: options.shardCount || 1,
		token: 'Bot TOKEN-NEVER-LOGGED',
		mainFile: '/src/owo.js',
		clientOptions: { intents: 130813, restMode: true, ws: { handshakeTimeout: 20000 } },
		clusters: new Map(options.clusters || [[0, { workerID: 1, firstShardID: 0, lastShardID: 0 }]]),
		queue,
	};
}

test('the rebuilt message matches eris-sharder 1.10.0 exactly', () => {
	const sharder = fakeSharder();
	const payload = shardAssignment.buildConnectPayload(sharder, 0);
	assert.deepStrictEqual(Object.keys(payload).sort(), [
		'clientOptions',
		'clusterCount',
		'file',
		'firstShardID',
		'id',
		'lastShardID',
		'maxShards',
		'name',
		'token',
	]);
	assert.strictEqual(payload.name, 'connect');
	assert.strictEqual(payload.id, 0);
	assert.strictEqual(payload.file, '/src/owo.js');
	assert.strictEqual(payload.maxShards, 1);
	assert.strictEqual(payload.clientOptions.intents, 130813);
});

test('a cluster with no shard range yields no payload (nothing is invented)', () => {
	const sharder = fakeSharder({ clusters: [[0, { workerID: 1 }]] });
	assert.strictEqual(shardAssignment.buildConnectPayload(sharder, 0), null);
	assert.deepStrictEqual(shardAssignment.plan(sharder), []);
	assert.deepStrictEqual(shardAssignment.deliverPending({ sharder, workers: {} }).attempted, []);
});

test('REGRESSION: the queue never delivers, the master does', () => {
	// This is eris-sharder's real queue, with nobody listening to "execute" —
	// exactly the state that produced the outage (queued, never sent).
	const queue = new Queue();
	const sharder = fakeSharder({ queue });
	const worker = new FakeWorker(1);

	queue.queueItem({ item: 0, value: { name: 'connect', id: 0 } });
	assert.strictEqual(queue.queue.length, 1, 'the item is stuck in eris-sharder queue');
	assert.strictEqual(worker.received.length, 0, 'nothing reached the worker');

	const report = shardAssignment.deliverPending({
		sharder,
		workers: { 1: worker },
		acknowledged: new Set(),
	});

	assert.strictEqual(report.delivered, 1);
	assert.strictEqual(worker.received.length, 1);
	assert.strictEqual(worker.received[0].name, 'connect');
	assert.strictEqual(worker.received[0].firstShardID, 0);
	assert.strictEqual(worker.received[0].lastShardID, 0);
});

test('an acknowledged cluster is never sent a second assignment', () => {
	const sharder = fakeSharder();
	const worker = new FakeWorker(1);
	const report = shardAssignment.deliverPending({
		sharder,
		workers: { 1: worker },
		acknowledged: new Set([0]),
	});
	assert.strictEqual(report.delivered, 0);
	assert.strictEqual(worker.received.length, 0);
	assert.deepStrictEqual(report.pending, []);
});

test('a delivery failure is reported, not swallowed', () => {
	// (a) the worker already exited
	const deadReport = shardAssignment.deliverPending({
		sharder: fakeSharder(),
		workers: { 1: new FakeWorker(1, { dead: true }) },
		acknowledged: new Set(),
	});
	assert.strictEqual(deadReport.delivered, 0);
	assert.match(deadReport.attempted[0].error, /already exited/);

	// (b) send() itself throws (closed IPC channel)
	const throwingWorker = {
		id: 1,
		isDead: () => false,
		send: () => {
			throw Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
		},
	};
	const report = shardAssignment.deliverPending({
		sharder: fakeSharder(),
		workers: { 1: throwingWorker },
		acknowledged: new Set(),
	});
	assert.strictEqual(report.delivered, 0);
	assert.strictEqual(report.attempted[0].ok, false);
	assert.match(report.attempted[0].error, /channel closed/);
	assert.strictEqual(report.attempted[0].code, 'ERR_IPC_CHANNEL_CLOSED');
});

test('a missing worker object is reported with the real reason', () => {
	const sharder = fakeSharder();
	const report = shardAssignment.deliverPending({ sharder, workers: {}, acknowledged: new Set() });
	assert.strictEqual(report.delivered, 0);
	assert.match(report.attempted[0].error, /not available/);
});

test('the stale queue item is dropped so eris-sharder cannot send it twice', () => {
	const queue = new Queue();
	const sharder = fakeSharder({ queue });
	queue.queueItem({ item: 0, value: { name: 'connect', id: 0 } });
	assert.strictEqual(shardAssignment.queueState(sharder).pending, 1);

	assert.strictEqual(shardAssignment.dropQueuedAssignment(sharder, 0), true);
	assert.strictEqual(shardAssignment.queueState(sharder).pending, 0);
	assert.strictEqual(shardAssignment.dropQueuedAssignment(sharder, 0), false);
});

test('the queue state distinguishes "never sent" from "sent"', () => {
	const pendingQueue = new Queue();
	const pendingSharder = fakeSharder({ queue: pendingQueue });
	pendingQueue.queueItem({ item: 0, value: { name: 'connect', id: 0 } });
	assert.deepStrictEqual(shardAssignment.queueState(pendingSharder), {
		pending: 1,
		clusters: [0],
		known: true,
	});

	const emptySharder = fakeSharder();
	assert.deepStrictEqual(shardAssignment.queueState(emptySharder), {
		pending: 0,
		clusters: [],
		known: true,
	});
});

test('two clusters each receive their own range', () => {
	const sharder = fakeSharder({
		clusterCount: 2,
		shardCount: 4,
		clusters: [
			[0, { workerID: 1, firstShardID: 0, lastShardID: 1 }],
			[1, { workerID: 2, firstShardID: 2, lastShardID: 3 }],
		],
	});
	const workers = { 1: new FakeWorker(1), 2: new FakeWorker(2) };
	const report = shardAssignment.deliverPending({ sharder, workers, acknowledged: new Set([1]) });

	assert.deepStrictEqual(report.pending, [0]);
	assert.strictEqual(workers[1].received.length, 1);
	assert.deepStrictEqual(
		[workers[1].received[0].firstShardID, workers[1].received[0].lastShardID],
		[0, 1]
	);
	assert.strictEqual(workers[2].received.length, 0, 'an acknowledged cluster gets nothing');
	assert.strictEqual(workers[1].received[0].clusterCount, 2);
});

test('the worker stage beacon carries the cluster id used for the ack', () => {
	const gatewayBoot = require('../src/utils/gatewayBoot.js');
	gatewayBoot.state.clusterId = 3;
	const sent = [];
	const previousSend = process.send;
	process.send = (message) => sent.push(message);
	try {
		gatewayBoot.reportStage('ipc_connect_received', 'shards 0~0 of 1');
	} finally {
		process.send = previousSend;
		gatewayBoot.state.clusterId = null;
	}
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].name, 'oceanStage');
	assert.strictEqual(sent[0].stage, 'ipc_connect_received');
	assert.strictEqual(sent[0].clusterId, 3);
});

test('a second connect() for the same shard range is refused (no duplicate session)', async () => {
	const gatewayBoot = require('../src/utils/gatewayBoot.js');
	gatewayBoot.state.activeClient = null;
	gatewayBoot.state.activeRange = null;

	class FakeClient {
		constructor() {
			this.options = { firstShardID: 0, lastShardID: 0 };
		}
		connect() {
			return Promise.resolve();
		}
	}
	const fakeEris = { Client: FakeClient };
	// The prototype guard is per Eris build; a fresh object mirrors a fresh worker.
	assert.strictEqual(gatewayBoot.install({ Eris: fakeEris }), true);

	const first = new FakeClient();
	const second = new FakeClient();
	await first.connect();
	await second.connect();

	assert.strictEqual(gatewayBoot.state.activeClient, first);
	assert.strictEqual(gatewayBoot.duplicates(), 1);
	gatewayBoot.state.activeClient = null;
	gatewayBoot.state.activeRange = null;
});
