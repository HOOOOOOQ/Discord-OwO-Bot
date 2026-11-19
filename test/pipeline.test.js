/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * End-to-end command pipeline without Discord and without MongoDB.
 *
 * The reported symptom was "`ohelp` and `o help` do nothing". This test walks
 * the exact chain the bot uses for a chat message:
 *
 *   message → Command#execute → checkPrefix → command lookup → rules gate →
 *   initParam → executeCommand → ban/cooldown → CommandInterface#execute →
 *   p.send(...)
 *
 * The real `src/commands/command.js` and all 285 command modules are loaded, so
 * a broken alias, a missing module, a null `main` field or a wrong prefix all
 * make it fail. The database layer is the real MongoDB adapter running on the
 * in-memory store (`MemoryStore`), and the reply is captured instead of sent.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { MemoryStore } = require('../src/utils/mongo/store.js');

function stub(relativePath, exports) {
	const resolved = require.resolve(path.join(ROOT, relativePath));
	require.cache[resolved] = {
		id: resolved,
		filename: resolved,
		loaded: true,
		exports,
		children: [],
		paths: [],
	};
}

function stubBare(name, exports) {
	try {
		const resolved = require.resolve(name);
		require.cache[resolved] = {
			id: resolved,
			filename: resolved,
			loaded: true,
			exports,
			children: [],
			paths: [],
		};
	} catch (err) {
		require.cache[name] = { id: name, filename: name, loaded: true, exports };
	}
}

function canvasStub() {
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
	stubBare('canvas', new Proxy(function canvasStubFn() {}, handler));
}

const store = new MemoryStore();

test.before(() => {
	store.connect();
	canvasStub();
	// The bot's MongoDB client, backed by the in-memory store (no network).
	stub('src/utils/mongo/client.js', {
		getStore: () => store,
		isConnected: () => true,
		whenReady: async () => store,
		connect: async () => store,
		close: async () => {},
		maskUri: () => 'mongodb://***',
		readUri: () => 'mongodb://stub',
		databaseName: () => 'stub',
	});
});

function buildBot(prefix = 'o') {
	const sent = [];
	const bot = {
		user: { id: '111111111111111111', username: 'OCEAN' },
		// what `o ping` and the shard helpers read from a live client
		guildShardMap: {},
		shards: new Map([[0, { id: 0, latency: 42, ready: true, status: 'ready' }]]),
		ping: 42,
		latency: 42,
		guilds: new Map([['444', { id: '444' }]]),
		users: new Map([['222222222222222222', { id: '222222222222222222' }]]),
		uptime: 1000,
		createMessage: async () => ({ id: '1' }),
	};
	const main = {
		bot,
		prefix,
		config: {
			prefix,
			debug: false,
			debugWhitelist: [],
			embed_color: 6315775,
			guildlink: 'https://discord.gg/666family',
			emoji: { invalid: '🚫' },
		},
		debug: false,
		optOut: {},
		redis: require('../src/utils/redis.js'),
		// the real MySQL→MongoDB facade, backed by the in-memory store
		mysql: require('../src/utils/mysql.js'),
		mysqlhandler: {
			query: (sql, vars) => require('../src/utils/mysql.js').query(sql, vars),
			startTransaction: async () => ({}),
		},
		query: (sql, vars) => require('../src/utils/mysql.js').query(sql, vars),
		animalUtil: {},
		dbl: {},
		macro: { check: () => true, verify: async () => false },
		// The real helper module, with the Discord-client lookups stubbed: the
		// formatters (toFancyNum, toSmallNum, parseTime ...) are what commands
		// such as `o stats` actually use.
		global: Object.assign({}, require('../src/utils/global.js'), {
			getName: () => 'tester',
			getUniqueName: () => '@tester',
			getTag: () => '<@1>',
			getShardString: () => '0',
			delay: async () => {},
		}),
		event: {},
		fetch: { getUser: async () => null },
		dateUtil: {},
		cache: {},
		patreonUtil: {},
		giveaway: {},
		neo4j: { give() {}, battle() {} },
		pubsub: { publish: async () => {} },
		DataResolver: {},
		EmojiAdder: {},
		badwords: [],
		questHandler: { increment: async () => {} },
		reactionCollector: {},
		interactionCollector: {},
		PagedMessage: {},
		// Mirrors the real sender signatures: send(content), reply(emoji, content),
		// error(emoji)(content). The captured value is what a user would read.
		sender: {
			send: () => async (content) => {
				sent.push(content);
				return { id: String(sent.length) };
			},
			reply: () => async (emoji, content) => {
				sent.push(typeof content === 'string' ? `${emoji} ${content}` : emoji);
				return { id: String(sent.length) };
			},
			error: () => async (content) => {
				sent.push(content);
				return { id: String(sent.length) };
			},
		},
		cooldown: { check: async () => true, setCooldown: () => {} },
		ban: { check: async () => true },
		logger: {
			command() {},
			logstash() {},
			logstashQos() {},
			incr: async () => 1,
			decr: async () => 1,
		},
	};
	main.command = new (require('../src/commands/command.js'))(main);
	return { main, sent };
}

function message(content, extras = {}) {
	const author = {
		id: '222222222222222222',
		username: 'tester',
		discriminator: '0001',
		bot: false,
		acceptedRules: true,
		...extras.author,
	};
	return {
		id: '999',
		content,
		author,
		member: author,
		mentions: [],
		attachments: [],
		channel: {
			id: extras.channelId || '333',
			mention: `<#${extras.channelId || '333'}>`,
			guild:
				extras.guild === null
					? undefined
					: { id: '444', prefix: extras.guildPrefix, members: new Map() },
			createMessage: async () => ({}),
		},
	};
}

let helpBot;
test('the registry is complete before anything is dispatched', () => {
	helpBot = buildBot();
	const commands = helpBot.main.command.commands;
	assert.ok(Object.keys(commands).length >= 280, `only ${Object.keys(commands).length} commands`);
	for (const name of [
		'help',
		'ping',
		'stats',
		'invite',
		'prefix',
		'profile',
		'cowoncy',
		'daily',
		'hunt',
		'battle',
	]) {
		assert.ok(commands[name], `command "${name}" is registered`);
	}
});

async function dispatch(content, extras) {
	const { main, sent } = helpBot;
	sent.length = 0;
	await main.command.execute(message(content, extras), undefined);
	return sent;
}

test('`ohelp` reaches the help command', async () => {
	const sent = await dispatch('ohelp');
	assert.strictEqual(sent.length, 1, 'exactly one reply');
	const payload = sent[0];
	const embed = payload.embed || payload;
	assert.strictEqual(embed.author && embed.author.name, 'Command List');
	assert.match(embed.description, /list of commands/i);
	assert.ok(Array.isArray(payload.components), 'the Join Community button is attached');
	assert.strictEqual(payload.components[0].components[0].url, 'https://discord.gg/666family');
});

test('`o help` (with a space) reaches the same command', async () => {
	const sent = await dispatch('o help');
	assert.strictEqual(sent.length, 1);
	const embed = sent[0].embed || sent[0];
	assert.strictEqual(embed.author.name, 'Command List');
});

test('the prefix is case-insensitive: `OHELP` and `O HELP`', async () => {
	for (const content of ['OHELP', 'O HELP', 'OhElP']) {
		const sent = await dispatch(content);
		assert.strictEqual(sent.length, 1, `${content} produced no reply`);
		const embed = sent[0].embed || sent[0];
		assert.strictEqual(embed.author.name, 'Command List', `${content} parsed wrong`);
	}
});

test('`o ping` answers through the real ping command', async () => {
	const sent = await dispatch('o ping');
	assert.ok(sent.length >= 1, 'ping produced a reply');
	const flat = JSON.stringify(sent);
	assert.match(flat, /ping|latency|ms/i);
});

test('a wrong prefix is ignored, a bare "owo" still records points', async () => {
	const ignored = await dispatch('thelp');
	assert.deepStrictEqual(ignored, [], 'thelp must not run any command');

	// `points` writes to the database instead of replying, so the proof is the
	// row it creates through the MongoDB adapter (the old SQL path). A fresh
	// author is used because the anti-spam limiter is keyed per user and earlier
	// commands in this file already spent that budget.
	const authorId = '777777777777777777';
	await dispatch('owo', { author: { id: authorId } });
	const users = await store.collection('user').find({});
	const row = users.find((doc) => String(doc.id) === authorId);
	assert.ok(row, 'the points command inserted the user row');
	assert.ok(Number(row.count) >= 1, `user count was not incremented (${row.count})`);
});

test('`o stats`, `o invite` and `o prefix` all answer through their real modules', async () => {
	// Each dispatch uses its own channel and author: the anti-spam limiter is
	// per channel and per user, and this test is about the commands, not it.
	let n = 0;
	for (const [content, needle] of [
		['o stats', /shard|guild|server|latency|memory|uptime/i],
		['o invite', /invite|discord\.gg/i],
		['o prefix', /prefix/i],
	]) {
		n += 1;
		const sent = await dispatch(content, {
			channelId: `3000${n}`,
			author: { id: `99900000000000000${n}` },
		});
		assert.ok(sent.length >= 1, `${content} produced no reply`);
		assert.match(JSON.stringify(sent), needle, `${content} replied with something unexpected`);
		assert.doesNotMatch(
			JSON.stringify(sent),
			/something went wrong while running that command/i,
			`${content} threw inside the command body`
		);
	}
});

test('`oprofile` and `o profile` both reach the profile command', async () => {
	// The two forms the user asked for explicitly, on a real command module.
	let n = 0;
	for (const content of ['oprofile', 'o profile']) {
		n += 1;
		const sent = await dispatch(content, {
			channelId: `3200${n}`,
			author: { id: `88800000000000000${n}` },
		});
		assert.ok(sent.length >= 1, `${content} produced no reply`);
		assert.doesNotMatch(
			JSON.stringify(sent),
			/something went wrong while running that command/i,
			`${content} threw inside the command body`
		);
	}
});

test('a per-guild prefix from MongoDB overrides the default', async () => {
	const { redis } = helpBot.main;
	await redis.hset('444', 'prefix', '!');
	const custom = await dispatch('!help', { guildPrefix: undefined });
	assert.strictEqual(custom.length, 1, 'the guild prefix must be honoured');
	const embed = custom[0].embed || custom[0];
	assert.strictEqual(embed.author.name, 'Command List');
	await redis.hdel('444', 'prefix');
});

test('an unknown command after a valid prefix is answered once, then throttled', async () => {
	// Reported symptom: `o hlep` did nothing at all, which looks like a dead bot.
	const author = { id: '888888888888888888' };
	const first = await dispatch('o notacommand', { author });
	assert.strictEqual(first.length, 1, 'a typo must be answered');
	const text = JSON.stringify(first);
	assert.match(text, /notacommand/, 'the reply names the unknown command');
	assert.match(text, /help/i, 'the reply points at the help command');

	// ... but a spammer must not get an answer for every message.
	const second = await dispatch('o notacommand', { author });
	assert.deepStrictEqual(second, [], 'the second identical typo is throttled');

	// A bare prefix is not a command and must stay silent.
	const empty = await dispatch('o');
	assert.deepStrictEqual(empty, []);
});

/*
 * Command modules install long-lived timers (the bot process is expected to keep
 * running); finish explicitly once the assertions are done so `npm test` cannot
 * hang. A failed assertion still sets the exit code.
 */
test.after(() => {
	setTimeout(() => process.exit(process.exitCode || 0), 100);
});
