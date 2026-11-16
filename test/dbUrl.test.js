const test = require('node:test');
const assert = require('node:assert');

const { freshRequire, withEnv } = require('./helpers.js');

function loadDbUrl(env = {}) {
	return withEnv({ LOG_LEVEL: 'error', ...env }, () => {
		freshRequire('../src/utils/log.js');
		return freshRequire('../src/utils/dbUrl.js');
	});
}

const dbUrl = require('../src/utils/dbUrl.js');

// --- MySQL URL ------------------------------------------------------------

test('mysql url is parsed into a pool config', () => {
	const parsed = dbUrl.parseMysqlUrl('mysql://owo:s3cret@172.18.0.1:3307/owodb');
	assert.deepStrictEqual(parsed, {
		host: '172.18.0.1',
		port: 3307,
		user: 'owo',
		password: 's3cret',
		database: 'owodb',
	});
});

test('mysql url defaults: port 3306, root user and the "owo" database', () => {
	assert.deepStrictEqual(dbUrl.parseMysqlUrl('mysql://db.local'), {
		host: 'db.local',
		port: 3306,
		user: 'root',
		password: '',
		database: 'owo',
	});
	assert.strictEqual(dbUrl.parseMysqlUrl('mariadb://u@h/mydb').database, 'mydb');
	assert.strictEqual(dbUrl.parseMysqlUrl('mysql2://u@h').port, 3306);
});

test('mysql url decodes percent-encoded credentials', () => {
	const parsed = dbUrl.parseMysqlUrl('mysql://owo:p%40ss%3Aword@h:3306/owo');
	assert.strictEqual(parsed.password, 'p@ss:word');
});

test('mysql url rejects other schemes, junk and bad ports', () => {
	assert.throws(() => dbUrl.parseMysqlUrl('postgres://u:p@h/db'), /unsupported scheme/);
	assert.throws(() => dbUrl.parseMysqlUrl('mongodb://u:p@h/db'), /unsupported scheme/);
	assert.throws(() => dbUrl.parseMysqlUrl('not a url'), /not a valid URL/);
	// WHATWG URL already rejects out-of-range ports
	assert.throws(
		() => dbUrl.parseMysqlUrl('mysql://u:p@h:99999/db'),
		/not a valid URL|invalid port/
	);
	// error messages never contain the credentials
	try {
		dbUrl.parseMysqlUrl('postgres://user:supersecret@h/db');
	} catch (err) {
		assert.ok(!err.message.includes('supersecret'));
	}
});

// --- Redis URL ------------------------------------------------------------

test('redis url is parsed with password, database index and tls', () => {
	assert.deepStrictEqual(dbUrl.parseRedisUrl('redis://:rpass@172.18.0.1:6380/3'), {
		host: '172.18.0.1',
		port: 6380,
		password: 'rpass',
		db: 3,
		tls: false,
	});
	const secure = dbUrl.parseRedisUrl('rediss://:rpass@cache.local');
	assert.deepStrictEqual(secure, {
		host: 'cache.local',
		port: 6379,
		password: 'rpass',
		db: undefined,
		tls: true,
	});
	assert.deepStrictEqual(dbUrl.parseRedisUrl('redis://localhost'), {
		host: 'localhost',
		port: 6379,
		password: undefined,
		db: undefined,
		tls: false,
	});
});

test('redis url rejects wrong scheme and junk', () => {
	assert.throws(() => dbUrl.parseRedisUrl('mysql://h:3306'), /unsupported scheme/);
	assert.throws(() => dbUrl.parseRedisUrl('nonsense'), /not a valid URL/);
});

// --- resolution / precedence ---------------------------------------------

test('DATABASE_URL wins over the legacy MYSQL_* variables', () => {
	const parsed = loadDbUrl().resolveMysql({
		DATABASE_URL: 'mysql://urluser:urlpass@urlhost:3306/urldb',
		MYSQL_HOST: 'legacyhost',
		MYSQL_USER: 'legacyuser',
		MYSQL_PASS: 'legacypass',
	});
	assert.strictEqual(parsed.host, 'urlhost');
	assert.strictEqual(parsed.user, 'urluser');
	assert.strictEqual(parsed.database, 'urldb');
});

test('MYSQL_URL works as an alias and legacy variables are the fallback', () => {
	const alias = loadDbUrl().resolveMysql({ MYSQL_URL: 'mysql://u:p@alias-host/db2' });
	assert.strictEqual(alias.host, 'alias-host');
	assert.strictEqual(alias.database, 'db2');

	const legacy = loadDbUrl().resolveMysql({
		MYSQL_HOST: 'legacy',
		MYSQL_PORT: '3307',
		MYSQL_USER: 'lu',
		MYSQL_PASS: 'lp',
		MYSQL_DATABASE: 'legacydb',
	});
	assert.deepStrictEqual(legacy, {
		host: 'legacy',
		port: 3307,
		user: 'lu',
		password: 'lp',
		database: 'legacydb',
	});
	assert.strictEqual(loadDbUrl().resolveMysql({}).database, 'owo');
});

test('an invalid connection string falls back to the legacy variables', () => {
	const parsed = loadDbUrl().resolveMysql({
		DATABASE_URL: 'postgres://bad:secret@h/db',
		MYSQL_HOST: 'fallback-host',
		MYSQL_USER: 'u',
	});
	assert.strictEqual(parsed.host, 'fallback-host');
	assert.strictEqual(parsed.database, 'owo');
});

test('REDIS_URL wins, legacy REDIS_* is the fallback', () => {
	const fromUrl = loadDbUrl().resolveRedis({
		REDIS_URL: 'redis://:urlpass@urlredis:6380/1',
		REDIS_HOST: 'legacyredis',
		REDIS_PASS: 'legacypass',
	});
	assert.strictEqual(fromUrl.host, 'urlredis');
	assert.strictEqual(fromUrl.password, 'urlpass');
	assert.strictEqual(fromUrl.db, 1);

	const legacy = loadDbUrl().resolveRedis({
		REDIS_HOST: 'legacyredis',
		REDIS_PORT: '6381',
		REDIS_PASS: 'legacypass',
		REDIS_TLS: 'true',
	});
	assert.deepStrictEqual(legacy, {
		host: 'legacyredis',
		port: 6381,
		password: 'legacypass',
		db: undefined,
		tls: true,
	});
});
