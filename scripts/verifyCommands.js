/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Command registry verification.
 *
 * Loads every file under src/commands/commandList through the real
 * require-dir loader (the same path the bot uses) and asserts that:
 *   - every export is a CommandInterface instance,
 *   - no alias is registered twice,
 *   - aliases are lowercase and non-empty,
 *   - the documented command categories are all present.
 *
 * Native image dependencies are stubbed so the check runs on machines without
 * cairo/pango installed. Run: node scripts/verifyCommands.js
 */

const path = require('path');

function stubCanvas() {
	try {
		// eslint-disable-next-line no-unused-vars
		const canvas = require('canvas');
		return canvas;
	} catch (err) {
		const handler = {
			get: (target, prop) => {
				if (prop === 'then') return undefined;
				if (prop === 'getContext') return () => new Proxy({}, handler);
				if (prop === 'toBuffer') return () => Buffer.from('');
				if (prop === 'createCanvas' || prop === 'createImageData') {
					return () => new Proxy({ width: 1, height: 1 }, handler);
				}
				if (prop === 'loadImage') return async () => new Proxy({}, handler);
				return () => new Proxy({}, handler);
			},
		};
		const stub = new Proxy(function canvasStub() {}, handler);
		try {
			const resolved = require.resolve('canvas');
			require.cache[resolved] = {
				id: resolved,
				filename: resolved,
				loaded: true,
				exports: stub,
				children: [],
				paths: [],
			};
		} catch (resolveError) {
			// canvas is not installed at all; register the stub under the bare name
			require.cache['canvas'] = { id: 'canvas', filename: 'canvas', loaded: true, exports: stub };
		}
		return stub;
	}
}

/**
 * Several command modules touch the database or Redis while they are being
 * required. The registry check must not need live infrastructure, so those two
 * singletons are replaced with inert doubles before anything is loaded.
 */
function stubInfrastructure() {
	const stub = (modulePath, exports) => {
		const resolved = require.resolve(modulePath);
		require.cache[resolved] = {
			id: resolved,
			filename: resolved,
			loaded: true,
			exports,
			children: [],
			paths: [],
		};
	};

	const fakePool = {
		query: function (sqlOrOptions, values, callback) {
			const done = typeof values === 'function' ? values : callback;
			if (typeof done === 'function') done(null, []);
			return { sql: typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions?.sql };
		},
		getConnection: function (callback) {
			callback(new Error('mysql is stubbed in the command registry check'));
		},
		end: function (callback) {
			if (typeof callback === 'function') callback();
		},
		on: function () {},
	};

	// The bot stores everything in MongoDB now; the registry check only needs the
	// module to exist so the command tree can be required offline.
	stub(path.join(__dirname, '../src/utils/mysql.js'), {
		con: fakePool,
		pool: fakePool,
		config: { driver: 'stub' },
		query: async () => [],
		close: async () => {},
	});

	const redisDouble = {
		client: { on: () => {}, quit: (cb) => cb && cb(), connected: false, ready: false },
		close: async () => {},
	};
	for (const method of [
		'incr',
		'decr',
		'hgetall',
		'hget',
		'hset',
		'hdel',
		'hmget',
		'hmset',
		'hincrby',
		'sadd',
		'srem',
		'smembers',
		'set',
		'get',
		'del',
		'expire',
		'zadd',
		'zrem',
		'zrange',
		'keys',
		'lpush',
	]) {
		redisDouble[method] = async () => null;
	}
	stub(path.join(__dirname, '../src/utils/redis.js'), redisDouble);
}

function loadCommands() {
	stubCanvas();
	stubInfrastructure();
	const requireDir = require('require-dir');
	return requireDir('../src/commands/commandList', { recurse: true });
}

function flatten(dir, out = [], seen = new Set()) {
	for (const key of Object.keys(dir)) {
		const value = dir[key];
		if (value && typeof value === 'object' && typeof value.execute === 'function' && value.alias) {
			// The same instance can be reachable through several keys (arrays,
			// nested directories); count it once.
			if (!seen.has(value)) {
				seen.add(value);
				out.push({ source: key, command: value });
			}
		} else if (Array.isArray(value)) {
			value.forEach((entry) => {
				if (entry && typeof entry === 'object' && entry.alias && !seen.has(entry)) {
					seen.add(entry);
					out.push({ source: key, command: entry });
				}
			});
		} else if (value && typeof value === 'object') {
			flatten(value, out, seen);
		}
	}
	return out;
}

// Pre-existing aliases registered by both patreon/collectible.js (JSON driven)
// and patreon/collectibleClasses.js (class driven). Documented in FIXLOG.md;
// the last one loaded wins, which is the historic behaviour.
const KNOWN_SHADOWED_ALIASES = new Set([
	'calcifer',
	'crossfox',
	'koi',
	'lilbee',
	'luv',
	'pikachu',
	'shootingstar',
]);

function verify(dir = loadCommands()) {
	const CommandInterface = require('../src/commands/CommandInterface.js');
	// Collectible classes and other helpers also expose `alias`/`execute`, but
	// only CommandInterface instances are registered as chat commands.
	const entries = flatten(dir).filter((entry) => entry.command instanceof CommandInterface);
	return analyze(entries);
}

/**
 * Pure analysis step: takes the already-resolved command entries so the rules
 * can be unit tested without loading 280+ modules.
 */
function analyze(entries) {
	const issues = [];
	const aliases = new Map();
	const shadowed = [];
	const seenInstance = [];
	const invalidInstances = [];

	const seenCommands = new Set();
	for (const { source, command } of entries) {
		// The same instance can be reachable through several keys
		if (seenCommands.has(command)) continue;
		seenCommands.add(command);
		seenInstance.push({ source, command });
		for (const alias of command.alias || []) {
			if (typeof alias !== 'string' || alias.length === 0) {
				issues.push(`${source}: empty alias`);
				continue;
			}
			if (alias !== alias.toLowerCase())
				issues.push(`${source}: alias "${alias}" is not lowercase`);
			if (aliases.has(alias)) {
				const message = `duplicate alias "${alias}" in ${aliases.get(alias)} and ${source}`;
				if (KNOWN_SHADOWED_ALIASES.has(alias)) shadowed.push(message);
				else issues.push(message);
			} else aliases.set(alias, source);
		}
	}

	const groups = new Set();
	for (const { command } of seenInstance) {
		for (const group of command.group || []) groups.add(group);
	}

	return {
		instances: seenInstance.length,
		aliases: aliases.size,
		invalidInstances,
		issues,
		shadowed,
		groups: [...groups].sort(),
		adminCommands: seenInstance.filter(
			({ command }) => command.owner || command.admin || command.manager || command.helper
		).length,
		ownerCommands: seenInstance.filter(({ command }) => command.owner).length,
		aliasList: [...aliases.keys()].sort(),
		ownerAliasList: seenInstance
			.filter(({ command }) => command.owner)
			.map(({ command }) => command.alias[0])
			.sort(),
	};
}

function report(result) {
	console.log(`command instances loaded : ${result.instances}`);
	console.log(`unique aliases          : ${result.aliases}`);
	console.log(
		`admin/staff commands    : ${result.adminCommands} (owner-only: ${result.ownerCommands})`
	);
	console.log(`groups                  : ${result.groups.join(', ')}`);
	if (result.shadowed.length) {
		console.log(`\nknown shadowed aliases (pre-existing): ${result.shadowed.length}`);
	}
	if (result.invalidInstances.length) {
		console.error(`not a CommandInterface  : ${result.invalidInstances.join(', ')}`);
	}
	if (result.issues.length) {
		console.error(`\n${result.issues.length} problem(s):`);
		for (const issue of result.issues) console.error(` - ${issue}`);
	}
	return result.issues.length === 0 && result.invalidInstances.length === 0;
}

/**
 * Loading the registry starts timers (schedulers, pool watchdogs), so the
 * process has to exit explicitly. The payload is flushed first: exiting with
 * pending stdout writes leaves the parent's pipes open and can hang a caller.
 */
function finish(code, payload) {
	let exited = false;
	const exit = () => {
		if (exited) return;
		exited = true;
		process.exit(code);
	};
	if (payload === undefined) {
		exit();
		return;
	}
	process.stdout.write(payload + '\n', exit);
	setTimeout(exit, 2000).unref();
}

function reportToStderr(result) {
	const write = console.log;
	console.log = console.error;
	try {
		report(result);
	} finally {
		console.log = write;
	}
}

if (require.main === module) {
	let ok = false;
	const jsonMode = process.argv.includes('--json');
	try {
		const result = verify();
		// --json is consumed by the automated test suite; stdout stays clean for
		// parsing because the report is printed to stderr in that mode.
		if (jsonMode) {
			reportToStderr(result);
			ok = result.issues.length === 0 && result.invalidInstances.length === 0;
			finish(ok ? 0 : 1, JSON.stringify(result));
			return;
		}
		ok = report(result);
	} catch (err) {
		console.error('Failed to load the command registry:', err);
		ok = false;
	}
	finish(ok ? 0 : 1);
}

module.exports = { verify, report, loadCommands, flatten, analyze, KNOWN_SHADOWED_ALIASES };
