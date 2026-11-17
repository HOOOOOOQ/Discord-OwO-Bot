/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Regression tests for the "token is valid but the bot never comes online"
 * failure: a panel variable pasted as `Bot <token>` reached the gateway as
 * `Bot Bot <token>`, because index.js prepended the prefix unconditionally while
 * the REST helpers normalised it. The socket answered 4004 and the bot stayed
 * offline with a perfectly good token.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const tokenUtil = require('../src/utils/token.js');

test('a bare token is used unchanged', () => {
	const result = tokenUtil.strip('MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz');
	assert.strictEqual(result.changed, false);
	assert.strictEqual(result.prefixes, 0);
	assert.strictEqual(
		tokenUtil.botAuth('MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz'),
		'Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz'
	);
});

test('a "Bot " prefixed value does not become "Bot Bot …"', () => {
	const pasted = 'Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.secret';
	assert.strictEqual(tokenUtil.botAuth(pasted), 'Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.secret');
	assert.strictEqual(tokenUtil.strip(pasted).hadPrefix, true);
	assert.deepStrictEqual(tokenUtil.describeChanges(tokenUtil.strip(pasted)), [
		'removed a duplicated "Bot " prefix',
	]);
});

test('double prefixes and surrounding whitespace are collapsed', () => {
	const messy = '  Bot   Bot\tMTIz.GaBc.secret\n';
	const result = tokenUtil.strip(messy);
	assert.strictEqual(result.token, 'MTIz.GaBc.secret');
	assert.strictEqual(result.prefixes, 2);
	assert.strictEqual(tokenUtil.botAuth(messy), 'Bot MTIz.GaBc.secret');
});

test('quoted values from a yaml/env copy-paste are handled', () => {
	for (const quote of ['"', "'"]) {
		const value = `${quote}Bot MTIz.quoted.secret${quote}`;
		const result = tokenUtil.strip(value);
		assert.strictEqual(result.token, 'MTIz.quoted.secret');
		assert.strictEqual(result.hadQuotes, true);
	}
});

test('an empty or missing token stays empty (never "Bot Bot")', () => {
	for (const value of [undefined, null, '', '   ', 'Bot ']) {
		assert.strictEqual(tokenUtil.strip(value).token, '');
		assert.strictEqual(tokenUtil.botAuth(value), 'Bot ');
	}
});

test('changes are described without exposing the token', () => {
	const value = 'Bot MTIz.super.secret';
	const described = tokenUtil.describeChanges(tokenUtil.strip(value)).join(' ');
	assert.match(described, /duplicated "Bot " prefix/);
	assert.ok(!described.includes('secret'), 'the description must never contain the token');
	assert.ok(!described.includes('MTIz'), 'the description must never contain the token');
});

test('index.js builds the sharder token through the shared helper', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
	assert.match(source, /tokenUtil\.botAuth\(process\.env\.BOT_TOKEN\)/);
	assert.ok(
		!/new Sharder\('Bot ' \+ process\.env\.BOT_TOKEN/.test(source),
		'the unconditional prefix that caused 4004 must not come back'
	);
});

test('the doctor gateway probe normalises the token too', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'doctor.js'), 'utf8');
	assert.match(source, /new Eris\(tokenUtil\.botAuth\(token\)/);
});
