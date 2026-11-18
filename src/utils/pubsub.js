/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Cluster-to-cluster messaging, previously Redis pub/sub.
 *
 * Every message is a document in the `_pubsub` collection. Each cluster polls
 * that collection once a second for messages newer than the last one it saw and
 * dispatches them to the matching handler in `./pubsubHandlers`, so the
 * behaviour of `p.pubsub.publish('endProcess')` and friends is unchanged.
 *
 * Polling is enough here: the channels are rare control messages (shutdown,
 * pause, patreon refresh, captcha, shard info), not a chat stream. It also means
 * one less service to run — the bot needs MongoDB only.
 */

const requireDir = require('require-dir');
const client = require('./mongo/client.js');
const log = require('./log.js');

const COLLECTION = '_pubsub';
const POLL_INTERVAL = Number.parseInt(process.env.PUBSUB_POLL_MS, 10) || 1000;
const RETENTION_MS = 60000;

const dir = requireDir('./pubsubHandlers');

/** Publish a message to every cluster (including this one, like Redis). */
async function publish(channel, message = true) {
	const payload = typeof message === 'object' ? JSON.stringify(message) : String(message);
	try {
		const collection = client.getStore().collection(COLLECTION);
		await collection.insertOne({ channel, message: payload, at: new Date() });
	} catch (err) {
		log.error(`[PUBSUB] could not publish "${channel}": ${err.message}`);
	}
	return 1;
}

class PubSub {
	constructor(main) {
		this.main = main;
		this.channels = {};
		for (const listener of Object.keys(dir)) {
			// `_selftest` style helpers and non-handlers are skipped
			if (!dir[listener] || typeof dir[listener].handle !== 'function') continue;
			this.channels[listener] = dir[listener];
		}
		this.lastSeen = new Date(Date.now() - 1000);
		this.seen = new Set();
		this.polling = true;
		this.timer = null;
		this.start();
	}

	start() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.poll().catch((err) => log.debug(`[PUBSUB] poll failed: ${err.message}`));
		}, POLL_INTERVAL);
		if (typeof this.timer.unref === 'function') this.timer.unref();
	}

	async poll() {
		if (!this.polling) return;
		let docs;
		try {
			if (!client.isConnected()) return;
			const collection = client.getStore().collection(COLLECTION);
			docs = await collection.find(
				{ at: { $gte: this.lastSeen } },
				{ limit: 100, sort: { at: 1 } }
			);
			if (docs.length) {
				this.lastSeen = new Date(docs[docs.length - 1].at);
			}
			// Keep the collection small: messages are only useful for a minute
			if (Math.random() < 0.05) {
				const cutoff = new Date(Date.now() - RETENTION_MS);
				await collection.deleteMany({ at: { $lt: cutoff } });
			}
		} catch (err) {
			log.debug(`[PUBSUB] read failed: ${err.message}`);
			return;
		}
		for (const doc of docs) {
			const id = String(doc._id);
			if (this.seen.has(id)) continue;
			this.seen.add(id);
			if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-500));
			const handler = this.channels[doc.channel];
			if (!handler) continue;
			try {
				await handler.handle(this.main, doc.message);
			} catch (err) {
				log.error(`[PUBSUB] handler "${doc.channel}" failed: ${err.message}`);
			}
		}
	}

	async publish(channel, message = true) {
		return publish(channel, message);
	}

	stop() {
		this.polling = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

PubSub.publish = publish;

module.exports = PubSub;
module.exports.publish = publish;
