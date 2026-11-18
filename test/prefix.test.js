/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The outage this pins: the bot was ONLINE and in the guild, but `ohelp` and
 * `o help` never answered. Prefix parsing must accept both spellings, must
 * ignore other prefixes, and must survive a Redis outage while it looks up a
 * guild prefix.
 */

const test = require('node:test');
const assert = require('node:assert');

const { checkPrefix } = require('../src/utils/prefix.js');

function message(content, options = {}) {
	const msg = { content, channel: {} };
	if (options.guild !== false) {
		msg.channel.guild = { id: '123', prefix: options.guildPrefix };
	}
	return msg;
}

function main(prefix, redis) {
	return { prefix, redis: redis || { hget: async () => null } };
}

test('`ohelp` parses with the default prefix', async () => {
	const result = await checkPrefix(main('o'), message('ohelp'));
	assert.deepStrictEqual(result.args, ['help']);
	assert.strictEqual(result.prefix, 'o');
	assert.strictEqual(result.source, 'default');
});

test('`o help` parses exactly like `ohelp`', async () => {
	const spaced = await checkPrefix(main('o'), message('o help'));
	const joined = await checkPrefix(main('o'), message('ohelp'));
	assert.deepStrictEqual(spaced.args, ['help']);
	assert.deepStrictEqual(spaced.args, joined.args);
});

test('`o daily` keeps its arguments', async () => {
	const result = await checkPrefix(main('o'), message('o daily'));
	assert.deepStrictEqual(result.args, ['daily']);
});

test('commands with arguments are split on whitespace', async () => {
	const result = await checkPrefix(main('o'), message('o  ban   @someone'));
	assert.deepStrictEqual(result.args, ['ban', '@someone']);
});

test('the prefix is case insensitive', async () => {
	const result = await checkPrefix(main('o'), message('O HELP'));
	assert.deepStrictEqual(result.args, ['help']);
});

test('`thelp` is not processed when the prefix is `o`', async () => {
	const result = await checkPrefix(main('o'), message('thelp'));
	assert.deepStrictEqual(result, {});
});

test('another prefix only works when it is configured', async () => {
	const msg = message('thelp');
	assert.deepStrictEqual(await checkPrefix(main('o'), msg), {});
	const configured = await checkPrefix(main('t'), message('thelp'));
	assert.deepStrictEqual(configured.args, ['help']);
});

test('a message that merely contains the prefix is ignored', async () => {
	const result = await checkPrefix(main('o'), message('so help me'));
	assert.deepStrictEqual(result, {});
});

test('a guild prefix is read from redis and used', async () => {
	const redis = { hget: async (id, field) => (field === 'prefix' ? '!' : null) };
	const result = await checkPrefix(main('o', redis), message('!help', { guildPrefix: undefined }));
	assert.deepStrictEqual(result.args, ['help']);
	assert.strictEqual(result.source, 'guild');
	assert.strictEqual(result.prefix, '!');
});

test('a cached guild prefix is not fetched again', async () => {
	let calls = 0;
	const redis = {
		hget: async () => {
			calls++;
			return '!';
		},
	};
	const msg = message('!help', { guildPrefix: '!' });
	await checkPrefix(main('o', redis), msg);
	assert.strictEqual(calls, 0);
});

test('a redis outage falls back to the default prefix instead of dropping the message', async () => {
	const redis = {
		hget: async () => {
			throw new Error('redis down');
		},
	};
	const result = await checkPrefix(main('o', redis), message('ohelp'));
	assert.deepStrictEqual(result.args, ['help']);

	const other = message('ohelp');
	other.channel.guild.prefix = undefined;
	const afterFailure = await checkPrefix(main('o', redis), other);
	assert.deepStrictEqual(afterFailure.args, ['help']);
});

test('a direct message has no guild prefix lookup', async () => {
	const redis = {
		hget: async () => {
			throw new Error('must not be called in DMs');
		},
	};
	const result = await checkPrefix(main('o', redis), message('thelp', { guild: false }));
	assert.deepStrictEqual(result, {});
});
