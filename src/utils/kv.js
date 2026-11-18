/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The key/value store that replaced Redis.
 *
 * Redis was only ever used for small, hot data: cooldowns, daily counters,
 * per-guild prefix, XP leaderboards and temporary game state. All of it now
 * lives in the same MongoDB Atlas database, in one collection (`_kv`), one
 * document per key:
 *
 *   { _id: 'cd_123', h: { daily: '2026-01-01 10:00:00' }, z: { '42': 120 },
 *     n: 3, s: ['a'], v: 'value', exp: ISODate(...) }
 *
 *   h – hash fields        (HGET/HSET/HINCRBY/HGETALL)
 *   z – sorted set         (ZADD/ZINCRBY/ZSCORE/ZREVRANK/ZREVRANGE)
 *   n – plain counter      (INCRBY)
 *   s – set members        (SADD)
 *   v – plain value        (GET/SET)
 *   exp – expiry, enforced lazily on read and by a TTL index
 *
 * Every mutation is a single atomic MongoDB update (`$inc`, `$set`, `$push`,
 * `$pull`), so two clusters can never lose a counter increment — the exact
 * guarantee Redis gave us.
 *
 * Numbers keep their type (Redis returned strings; every call site in this bot
 * compares or adds numerically, so native numbers are the safer contract) and
 * `zscore`/`hincrby`/`incr` return numbers, as `parseInt(...)`/`< 0` checks in
 * the command code expect.
 */

const client = require('./mongo/client.js');
const log = require('./log.js');

const COLLECTION = '_kv';
const DEFAULT_TTL_SECONDS = 259200; // 3 days, same default as before

/**
 * Wait for the MongoDB connection, then return the collection.
 *
 * `client.getStore()` throws when the client is not connected yet. Redis used
 * to queue commands until it connected, so a prefix lookup that raced with the
 * boot sequence must not blow up a command — `whenReady()` waits for the
 * pending connect() instead (and rejects only when MongoDB is genuinely
 * unavailable, which is reported once by the connection module).
 */
async function collection() {
	await client.whenReady();
	return client.getStore().collection(COLLECTION);
}

function isExpired(doc) {
	if (!doc || !doc.exp) return false;
	const when = doc.exp instanceof Date ? doc.exp.getTime() : new Date(doc.exp).getTime();
	return Number.isFinite(when) && when <= Date.now();
}

async function load(key, options = {}) {
	const doc = await (await collection()).findOne({ _id: String(key) });
	if (!doc) return null;
	if (isExpired(doc)) {
		if (options.purge !== false)
			await (await collection()).deleteMany({ _id: String(key) }).catch(() => {});
		return null;
	}
	return doc;
}

function fieldPath(area, field) {
	return `${area}.${field}`;
}

/* --------------------------------------------------------------- hashes --- */

async function hget(key, field) {
	const doc = await load(key);
	if (!doc || !doc.h) return null;
	const value = doc.h[field];
	return value === undefined ? null : value;
}

async function hset(key, field, value = 1) {
	if (value === undefined) value = null;
	await (
		await collection()
	).updateOne({ _id: String(key) }, { $set: { [fieldPath('h', field)]: value } }, { upsert: true });
	return 1;
}

async function hdel(key, field) {
	const doc = await load(key);
	if (!doc || !doc.h || doc.h[field] === undefined) return 0;
	await (
		await collection()
	).updateOne({ _id: String(key) }, { $unset: { [fieldPath('h', field)]: '' } });
	return 1;
}

async function hmget(key, fields) {
	const doc = await load(key);
	const list = Array.isArray(fields) ? fields : [fields];
	if (!doc || !doc.h) return list.map(() => null);
	return list.map((field) => (doc.h[field] === undefined ? null : doc.h[field]));
}

async function hmset(key, values = {}) {
	const set = {};
	for (const field of Object.keys(values)) set[fieldPath('h', field)] = values[field];
	if (!Object.keys(set).length) return 1;
	await (await collection()).updateOne({ _id: String(key) }, { $set: set }, { upsert: true });
	return 1;
}

async function hgetall(key) {
	const doc = await load(key);
	return (doc && doc.h) || {};
}

async function hincrby(key, field, amount = 1) {
	const doc = await (
		await collection()
	).findOneAndUpdate(
		{ _id: String(key) },
		{ $inc: { [fieldPath('h', field)]: Number(amount) || 0 } },
		{ upsert: true, returnDocument: 'after' }
	);
	if (!doc) return 0;
	const value = doc.h ? doc.h[field] : 0;
	return typeof value === 'number' ? value : Number(value) || 0;
}

/* ------------------------------------------------------------ counters --- */

async function incrby(key, amount = 1) {
	const doc = await (
		await collection()
	).findOneAndUpdate(
		{ _id: String(key) },
		{ $inc: { n: Number(amount) || 0 } },
		{ upsert: true, returnDocument: 'after' }
	);
	return doc && typeof doc.n === 'number' ? doc.n : 0;
}

/* ----------------------------------------------------------- sorted set --- */

/** ZADD / ZINCRBY: adds `amount` to a member's score and returns the new score. */
async function zincrby(key, member, amount = 1) {
	const doc = await (
		await collection()
	).findOneAndUpdate(
		{ _id: String(key) },
		{ $inc: { [fieldPath('z', String(member))]: Number(amount) || 0 } },
		{ upsert: true, returnDocument: 'after' }
	);
	if (!doc || !doc.z) return 0;
	const value = doc.z[String(member)];
	return typeof value === 'number' ? value : Number(value) || 0;
}

async function zscore(key, member) {
	const doc = await load(key);
	if (!doc || !doc.z) return null;
	const value = doc.z[String(member)];
	if (value === undefined) return null;
	return typeof value === 'number' ? value : Number(value) || 0;
}

/** 0-based position in DESC order (Redis ZREVRANK). `null` when not ranked. */
async function zrevrank(key, member) {
	const doc = await load(key);
	if (!doc || !doc.z) return null;
	const members = sortedDesc(doc.z);
	const index = members.findIndex((entry) => entry.member === String(member));
	return index === -1 ? null : index;
}

function sortedDesc(z) {
	return Object.keys(z)
		.map((member) => {
			const raw = z[member];
			return { member, score: typeof raw === 'number' ? raw : Number(raw) || 0 };
		})
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.member < b.member ? -1 : a.member > b.member ? 1 : 0;
		});
}

function flatWithScores(entries) {
	// Redis returns [member, 'score', member, 'score', ...] for WITHSCORES
	const out = [];
	for (const entry of entries) out.push(entry.member, String(entry.score));
	return out;
}

async function zrevrange(key, min, max) {
	const doc = await load(key);
	if (!doc || !doc.z) return [];
	const members = sortedDesc(doc.z);
	const start = Math.max(0, Number(min) || 0);
	const end = Number(max);
	const slice = members.slice(start, Number.isNaN(end) ? undefined : end + 1);
	return flatWithScores(slice);
}

async function zrem(key, member) {
	const doc = await load(key);
	if (!doc || !doc.z || doc.z[String(member)] === undefined) return 0;
	await (
		await collection()
	).updateOne({ _id: String(key) }, { $unset: { [fieldPath('z', String(member))]: '' } });
	return 1;
}

/* ----------------------------------------------------------------- sets --- */

async function sadd(key, member) {
	const doc = await load(key);
	if (doc && Array.isArray(doc.s) && doc.s.includes(String(member))) return 0;
	await (
		await collection()
	).updateOne({ _id: String(key) }, { $addToSet: { s: String(member) } }, { upsert: true });
	return 1;
}

async function sismember(key, member) {
	const doc = await load(key);
	return !!(doc && Array.isArray(doc.s) && doc.s.includes(String(member)));
}

async function smembers(key) {
	const doc = await load(key);
	return (doc && Array.isArray(doc.s) ? doc.s : []).slice();
}

/* ---------------------------------------------------------- plain / keys --- */

async function get(key) {
	const doc = await load(key);
	if (!doc) return null;
	return doc.v === undefined ? null : doc.v;
}

async function set(key, value) {
	await (
		await collection()
	).updateOne({ _id: String(key) }, { $set: { v: value } }, { upsert: true });
	return 'OK';
}

async function del(key) {
	const doc = await load(key);
	if (!doc) return 0;
	await (await collection()).deleteMany({ _id: String(key) });
	return 1;
}

async function exists(key) {
	return (await load(key)) ? 1 : 0;
}

async function expire(key, seconds = DEFAULT_TTL_SECONDS) {
	const doc = await load(key);
	if (!doc) return 0;
	const when = new Date(Date.now() + Number(seconds || DEFAULT_TTL_SECONDS) * 1000);
	await (await collection()).updateOne({ _id: String(key) }, { $set: { exp: when } });
	return 1;
}

/** Removes expired documents that the TTL index has not collected yet. */
async function purgeExpired(limit = 500) {
	try {
		const docs = await (await collection()).find({}, { limit });
		let removed = 0;
		for (const doc of docs) {
			if (!isExpired(doc)) continue;
			await (await collection()).deleteMany({ _id: doc._id });
			removed++;
		}
		if (removed) log.debug(`[KV] purged ${removed} expired key(s)`);
		return removed;
	} catch (err) {
		log.debug(`[KV] purge skipped: ${err.message}`);
		return 0;
	}
}

module.exports = {
	// hashes
	hget,
	hset,
	hdel,
	hmget,
	hmset,
	hgetall,
	hincrby,
	// counters
	incrby,
	// sorted sets
	zincrby,
	zscore,
	zrevrank,
	zrevrange,
	zrem,
	// sets
	sadd,
	sismember,
	smembers,
	// plain
	get,
	set,
	del,
	exists,
	expire,
	purgeExpired,
	COLLECTION,
};
