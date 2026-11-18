/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const test = require('node:test');
const assert = require('node:assert');

const trace = require('../src/utils/commandTrace.js');

test('tracing is off by default', () => {
	assert.strictEqual(trace.isEnabled({}), false);
});

test('COMMAND_DEBUG=true turns tracing on', () => {
	assert.strictEqual(trace.isEnabled({ COMMAND_DEBUG: 'true' }), true);
	assert.strictEqual(trace.isEnabled({ COMMAND_DEBUG: '1' }), true);
});

test('COMMAND_DEBUG=false wins over DEBUG=true', () => {
	assert.strictEqual(trace.isEnabled({ COMMAND_DEBUG: 'false', DEBUG: 'true' }), false);
});

test('DEBUG mode traces the command pipeline by default', () => {
	assert.strictEqual(trace.isEnabled({ DEBUG: 'true' }), true);
	assert.strictEqual(trace.isEnabled({ DEBUG: 'false' }), false);
});

test('message previews are truncated and flattened', () => {
	assert.strictEqual(trace.preview('o   help\n\nme'), 'o help me');
	const long = trace.preview('o ' + 'x'.repeat(500));
	assert.ok(long.length < 90, `preview must stay short, got ${long.length}`);
	assert.ok(long.endsWith('…'));
	assert.strictEqual(trace.preview(undefined), '');
});

test('tracing never throws when disabled or when fields are missing', () => {
	assert.doesNotThrow(() => trace.trace('message_received', { at: 'guild=1' }));
	assert.doesNotThrow(() => trace.rejected('prefix_not_matched', null, { expected: 'o' }));
	assert.doesNotThrow(() => trace.parsed({ author: {}, channel: {} }, 'help', true));
});
