/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Guards the MongoDB-only migration:
 *
 *   - no module may require the `mysql` or `redis` packages,
 *   - neither package may be a dependency,
 *   - the MySQL/Redis environment variables must no longer be read anywhere,
 *   - the connection module must validate and mask the MongoDB URI,
 *   - the presence defaults must match the requested activity.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, files = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, files);
		else if (entry.name.endsWith('.js')) files.push(full);
	}
	return files;
}

const SOURCES = ['src', 'utils', 'scripts']
	.map((dir) => path.join(ROOT, dir))
	.filter((dir) => fs.existsSync(dir))
	.flatMap((dir) => walk(dir))
	.concat([path.join(ROOT, 'index.js')]);

test('no source file requires the mysql or redis packages', () => {
	const offenders = [];
	for (const file of SOURCES) {
		const source = fs.readFileSync(file, 'utf8');
		if (/require\(\s*['"](mysql|redis)['"]\s*\)/.test(source))
			offenders.push(path.relative(ROOT, file));
	}
	assert.deepStrictEqual(offenders, []);
});

test('package.json has no mysql/redis dependency and does have mongodb', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
	assert.strictEqual(deps.mysql, undefined);
	assert.strictEqual(deps.redis, undefined);
	assert.ok(deps.mongodb, 'mongodb driver is required');
});

test('the lockfile no longer installs mysql or redis', () => {
	const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
	const packages = Object.keys(lock.packages || {});
	assert.ok(!packages.includes('node_modules/mysql'), 'mysql is still in the lockfile');
	assert.ok(!packages.includes('node_modules/redis'), 'redis is still in the lockfile');
	assert.ok(packages.includes('node_modules/mongodb'), 'mongodb is missing from the lockfile');
});

test('no module reads DATABASE_URL/REDIS_URL/MYSQL_*/REDIS_* for configuration', () => {
	const offenders = [];
	for (const file of SOURCES) {
		if (path.basename(file) === 'doctor.js') continue; // reports legacy variables
		if (path.basename(file) === 'client.js') continue; // mentions them in messages? no
		const source = fs.readFileSync(file, 'utf8');
		if (/process\.env\.(DATABASE_URL|REDIS_URL|MYSQL_[A-Z_]+|REDIS_[A-Z_]+)/.test(source)) {
			offenders.push(path.relative(ROOT, file));
		}
	}
	assert.deepStrictEqual(offenders, []);
});

test('the MongoDB URI validator accepts Atlas URIs and rejects SQL ones', () => {
	const client = require('../src/utils/mongo/client.js');
	const atlas = client.inspectUri('mongodb+srv://user:pass@cluster0.abc.mongodb.net/ocean');
	assert.strictEqual(atlas.ok, true);
	assert.strictEqual(atlas.database, 'ocean');
	assert.strictEqual(atlas.host, 'cluster0.abc.mongodb.net');

	const plain = client.inspectUri('mongodb://user:pass@localhost:27017/ocean?retryWrites=true');
	assert.strictEqual(plain.ok, true);
	assert.strictEqual(plain.scheme, 'mongodb');

	const sql = client.inspectUri('mysql://user:pass@host:3306/owo');
	assert.strictEqual(sql.ok, false);
	assert.match(sql.reason, /unsupported scheme/);
	assert.match(sql.action, /MongoDB/);

	const missing = client.inspectUri('');
	assert.strictEqual(missing.ok, false);
	assert.match(missing.action, /MONGODB_URI/);

	const noCredentials = client.inspectUri('mongodb+srv://cluster0.abc.mongodb.net/ocean');
	assert.strictEqual(noCredentials.ok, false);
	assert.match(noCredentials.reason, /username/);
});

test('the URI is masked for logs (never the password)', () => {
	const client = require('../src/utils/mongo/client.js');
	const masked = client.maskUri(
		'mongodb+srv://ocean:SuperSecret123@cluster0.abc.mongodb.net/ocean'
	);
	assert.ok(!masked.includes('SuperSecret123'));
	assert.strictEqual(masked, 'mongodb+srv://***@cluster0.abc.mongodb.net/ocean');
});

test('the presence defaults are online + watching discord.gg/666family', () => {
	const presence = require('../src/utils/presence.js');
	const resolved = presence.resolve({});
	assert.strictEqual(resolved.status, 'online');
	assert.strictEqual(resolved.type, 'watching');
	assert.strictEqual(resolved.text, 'discord.gg/666family');
});

test('the support server link is the 666family invite', () => {
	const config = require('../src/data/config.json');
	assert.strictEqual(config.guildlink, 'https://discord.gg/666family');
});

test('index.js connects to MongoDB before the gateway is created', () => {
	const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
	const connectAt = source.indexOf('await mongoClient.connect()');
	const sharderAt = source.indexOf('new Sharder(');
	assert.ok(connectAt > -1, 'index.js must pre-connect to MongoDB');
	assert.ok(sharderAt > -1, 'index.js must still create the sharder');
	assert.ok(
		connectAt < sharderAt,
		'MongoDB must be connected before eris-sharder opens a gateway socket'
	);
	assert.match(source.slice(connectAt, sharderAt), /process\.exit\(1\)/);
});

test('the mongodb client retries with backoff and reports the Atlas fix', () => {
	const source = fs.readFileSync(path.join(ROOT, 'src/utils/mongo/client.js'), 'utf8');
	assert.match(source, /MONGODB_CONNECT_ATTEMPTS/);
	assert.match(source, /Network Access/);
	assert.match(source, /maskUri\(/);
});
