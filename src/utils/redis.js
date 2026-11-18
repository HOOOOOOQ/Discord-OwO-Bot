/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Kept under the old name and with the old function names so the ~460 call
 * sites (`p.redis.hget(...)`, `redis.hincrby(...)`, `levels.getTop(...)`) do
 * not change. The implementation is now MongoDB (`src/utils/kv.js`) — there is
 * no Redis server, no `redis` npm package and no `REDIS_URL`.
 *
 * Semantics that commands rely on are preserved exactly:
 *   - `hget`        → value or null
 *   - `hgetall`     → plain object
 *   - `hincrby`     → the new number (was a string from Redis, now a number)
 *   - `incr`        → ZINCRBY on a sorted set, returns the new score
 *   - `getTop`      → [member, 'score', member, 'score', ...] in DESC order
 *   - `getRank`     → 0-based DESC position (Redis ZREVRANK)
 *   - `expire`      → sets a TTL (default 3 days, as before)
 */

const kv = require('./kv.js');

exports.hget = (key, field) => kv.hget(key, field);
exports.hset = (key, field, value = 1) => kv.hset(key, field, value);
exports.hdel = (key, field) => kv.hdel(key, field);
exports.hmget = (key, fields) => kv.hmget(key, fields);
exports.hmset = (key, values) => kv.hmset(key, values);
exports.hgetall = (key) => kv.hgetall(key);
exports.hincrby = (key, field, amount = 1) => kv.hincrby(key, field, amount);

/* Sorted sets / leaderboards */
exports.incr = (table, member, amount = 1) => kv.zincrby(table, member, amount);
exports.zscore = (table, member) => kv.zscore(table, member);
exports.getXP = (table, member) => kv.zscore(table, member);
exports.getRank = (table, member) => kv.zrevrank(table, member);
exports.getTop = (table, count = 5) => kv.zrevrange(table, 0, count - 1);
exports.getRange = (table, min, max) => kv.zrevrange(table, min, max);
exports.zrem = (table, member) => kv.zrem(table, member);

/* Sets, keys, TTL */
exports.sadd = (table, value) => kv.sadd(table, value);
exports.del = (key) => kv.del(key);
exports.expire = (key, seconds = 259200) => kv.expire(key, seconds);
exports.get = (key) => kv.get(key);
exports.set = (key, value) => kv.set(key, value);
exports.exists = (key) => kv.exists(key);

exports.close = function () {
	// The MongoDB connection is owned by src/utils/mongo/client.js
	return Promise.resolve();
};

/** Housekeeping: drop expired keys (called by the bot on an interval). */
exports.purgeExpired = () => kv.purgeExpired();
