/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Master → worker shard assignment, without trusting eris-sharder's queue.
 *
 * In eris-sharder 1.10.0 the only thing that makes a worker build an Eris client
 * is one IPC message (`src/sharding/cluster.js`, `msg.name === "connect"`). The
 * master produces it here:
 *
 *   start(clusterID)          // assigns firstShardID/lastShardID per cluster
 *     → connectShards()       // queue.queueItem({ item: clusterID, value: {...} })
 *       → queue.emit("execute", item)
 *         → master.workers[cluster.workerID].send(item.value)
 *
 * All of that runs inside an async `process.nextTick` in `launch()`, and
 * eris-sharder only installs an `uncaughtException` handler on the master — so a
 * throw anywhere in that chain (a missing `workers[id]`, a closed channel, a
 * non-serialisable option) becomes a silently swallowed unhandled rejection, and
 * the worker waits forever with no client at all.
 *
 * This module rebuilds the exact same message from the ClusterManager's own
 * public state and delivers it over the cluster channel itself, then relies on
 * the worker's stage beacon (`ipc_connect_received`) as an acknowledgement. It
 * only sends for clusters that have **not** acknowledged, and it drops the stale
 * queue entry afterwards so eris-sharder cannot deliver a second copy (a second
 * `connect` would create a second Eris client — the one thing we must never do).
 */

/** Same payload shape eris-sharder's `connectShards()` builds. */
function buildConnectPayload(sharder, clusterId) {
	if (!sharder || !sharder.clusters) return null;
	const info = sharder.clusters.get(clusterId);
	if (!info || info.firstShardID === undefined || info.lastShardID === undefined) return null;
	return {
		id: clusterId,
		clusterCount: sharder.clusterCount,
		name: 'connect',
		firstShardID: info.firstShardID,
		lastShardID: info.lastShardID,
		maxShards: sharder.shardCount,
		token: sharder.token,
		file: sharder.mainFile,
		clientOptions: sharder.clientOptions,
	};
}

/** Every cluster eris-sharder actually assigned a shard range to. */
function plan(sharder) {
	if (!sharder || !sharder.clusters || typeof sharder.clusters.get !== 'function') return [];
	const entries = [];
	for (const [clusterId, info] of sharder.clusters.entries()) {
		if (info && info.firstShardID !== undefined) {
			entries.push({
				clusterId,
				workerId: info.workerID,
				firstShardID: info.firstShardID,
				lastShardID: info.lastShardID,
			});
		}
	}
	return entries.sort((a, b) => a.clusterId - b.clusterId);
}

/**
 * Sends one assignment. Never throws: returns {ok, error, code} so the caller can
 * report the real reason (a swallowed exception is what caused the outage).
 */
function deliver(worker, payload) {
	if (!payload) return { ok: false, error: 'no shard range assigned for this cluster yet' };
	if (!worker || typeof worker.send !== 'function') {
		return {
			ok: false,
			error: 'the cluster worker object is not available (cluster.workers is empty)',
		};
	}
	if (worker.isDead && worker.isDead()) {
		return { ok: false, error: 'the cluster worker has already exited' };
	}
	try {
		worker.send(payload, (err) => {
			if (err) {
				// Async failure (channel closed between the check and the write).
				// eslint-disable-next-line no-console
				console.error(`[CLUSTER] asynchronous shard assignment delivery failed: ${err.message}`);
			}
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err && err.message ? err.message : String(err),
			code: err && err.code,
		};
	}
}

/**
 * Removes eris-sharder's queued copy for a cluster we already delivered, so the
 * worker can never receive the assignment twice and create a second client.
 * @returns {boolean} true when an entry was removed
 */
function dropQueuedAssignment(sharder, clusterId) {
	if (!sharder || !sharder.queue || !Array.isArray(sharder.queue.queue)) return false;
	const index = sharder.queue.queue.findIndex(
		(item) => item && (item.item === clusterId || (item.value && item.value.id === clusterId))
	);
	if (index === -1) return false;
	sharder.queue.queue.splice(index, 1);
	return true;
}

/**
 * Describes eris-sharder's own delivery attempt for the log: an item still sitting
 * in the queue means its `execute` handler never ran (or threw), an empty queue
 * means it believes the message was sent.
 */
function queueState(sharder) {
	const queue = sharder && sharder.queue && sharder.queue.queue;
	if (!Array.isArray(queue)) return { pending: 0, clusters: [], known: false };
	return {
		pending: queue.length,
		clusters: queue.map((item) => (item && item.value ? item.value.id : item && item.item)),
		known: true,
	};
}

/**
 * One delivery pass over every cluster that has not acknowledged its assignment.
 *
 * @param {Object} options
 * @param {Object} options.sharder     the eris-sharder ClusterManager instance
 * @param {Object} options.workers     `cluster.workers` (id → Worker)
 * @param {Set}    options.acknowledged cluster ids that already reported a stage
 * @returns {{attempted: Array, delivered: Number, pending: Array}}
 */
function deliverPending(options = {}) {
	const sharder = options.sharder;
	const workers = options.workers || {};
	const acknowledged = options.acknowledged || new Set();
	const filter = typeof options.filter === 'function' ? options.filter : () => true;
	const attempted = [];

	for (const entry of plan(sharder)) {
		if (acknowledged.has(entry.clusterId)) continue;
		if (!filter(entry, { acknowledged, pending: acknowledged.size === 0 })) continue;
		const payload = buildConnectPayload(sharder, entry.clusterId);
		const result = deliver(workers[entry.workerId], payload);
		attempted.push(
			Object.assign({}, entry, {
				ok: result.ok,
				error: result.error || null,
				code: result.code || null,
			})
		);
	}

	return {
		attempted,
		delivered: attempted.filter((entry) => entry.ok).length,
		pending: plan(sharder)
			.map((entry) => entry.clusterId)
			.filter((clusterId) => !acknowledged.has(clusterId)),
		acknowledged: acknowledged.size,
	};
}

module.exports = {
	buildConnectPayload,
	plan,
	deliver,
	deliverPending,
	dropQueuedAssignment,
	queueState,
};
