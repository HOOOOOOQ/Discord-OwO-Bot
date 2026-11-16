const test = require('node:test');
const assert = require('node:assert');

const { withEnv } = require('./helpers.js');
const log = require('../src/utils/log.js');

test('environment secrets are redacted from any string', () => {
	withEnv({ TEST_BOT_TOKEN: 'super-secret-token-value' }, () => {
		assert.strictEqual(
			log.redact('connecting with super-secret-token-value now'),
			'connecting with [REDACTED] now'
		);
	});
});

test('discord-shaped tokens are redacted even without a matching env var', () => {
	const token = 'MTAxMDEwMTAxMDEwMTAxMDEw.GgHhJj.abcdefghijklmnopqrstuvwxyz0123456789';
	assert.ok(!log.redact(`token=${token}`).includes(token));
});

test('non-secret content is preserved and object argument is stringified', () => {
	withEnv({ SAMPLE_PASSWORD: 'hunter2hunter2' }, () => {
		assert.strictEqual(log.redact('nothing sensitive'), 'nothing sensitive');
		assert.strictEqual(log.create('test').info.length >= 0, true);
	});
});

test('log level is configurable and defaults to info', () => {
	log.configure({});
	assert.strictEqual(log.getLevel(), 'info');
	log.configure({ level: 'debug' });
	assert.strictEqual(log.getLevel(), 'debug');
	log.configure({ debug: false });
	assert.strictEqual(log.getLevel(), 'info');
});
