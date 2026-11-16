const test = require('node:test');
const assert = require('node:assert');

const intents = require('../src/utils/intents.js');
const { INTENT_MESSAGE_CONTENT, ALL_NON_PRIVILEGED } = intents;

const TABLE = { allNonPrivileged: ALL_NON_PRIVILEGED, guildMessages: 1 << 9 };

test('message content is requested by default', () => {
	const result = intents.resolveIntents({ env: {}, table: TABLE });
	assert.strictEqual(result.value, ALL_NON_PRIVILEGED | INTENT_MESSAGE_CONTENT);
	assert.strictEqual(result.messageContent, true);
});

test('ERIS_MESSAGE_CONTENT=off keeps the bot online but deaf', () => {
	const result = intents.resolveIntents({ env: { ERIS_MESSAGE_CONTENT: 'off' }, table: TABLE });
	assert.strictEqual(result.value & INTENT_MESSAGE_CONTENT, 0);
	assert.strictEqual(result.messageContent, false);
});

test('auto mode drops the bit when the portal toggle is disabled', () => {
	const result = intents.resolveIntents({
		env: { ERIS_MESSAGE_CONTENT: 'auto' },
		table: TABLE,
		messageContentAllowed: false,
	});
	assert.strictEqual(result.value & INTENT_MESSAGE_CONTENT, 0);
});

test('auto mode keeps the bit when the portal toggle is enabled', () => {
	const result = intents.resolveIntents({
		env: {},
		table: TABLE,
		messageContentAllowed: true,
	});
	assert.notStrictEqual(result.value & INTENT_MESSAGE_CONTENT, 0);
});

test('ERIS_MESSAGE_CONTENT=on ignores the detected flags', () => {
	const result = intents.resolveIntents({
		env: { ERIS_MESSAGE_CONTENT: 'on' },
		table: TABLE,
		messageContentAllowed: false,
	});
	assert.notStrictEqual(result.value & INTENT_MESSAGE_CONTENT, 0);
});

test('ERIS_INTENTS accepts names, numbers and mixes', () => {
	assert.strictEqual(
		intents.parseIntentSpec('guildMessages,messageContent', TABLE).value,
		(1 << 9) | INTENT_MESSAGE_CONTENT
	);
	assert.strictEqual(intents.parseIntentSpec('32768', TABLE).value, INTENT_MESSAGE_CONTENT);
	assert.deepStrictEqual(intents.parseIntentSpec('nonsense', TABLE).unknown, ['nonsense']);

	const resolved = intents.resolveIntents({
		env: { ERIS_INTENTS: 'allNonPrivileged' },
		table: TABLE,
	});
	assert.strictEqual(resolved.source, 'ERIS_INTENTS');
	assert.strictEqual(resolved.value, ALL_NON_PRIVILEGED);
});

test('messageContent is a known name even though eris 0.17 omits it', () => {
	assert.strictEqual(
		intents.parseIntentSpec('messageContent', TABLE).value,
		INTENT_MESSAGE_CONTENT
	);
});

test('describe lists the resolved intents', () => {
	const text = intents.describe(ALL_NON_PRIVILEGED | INTENT_MESSAGE_CONTENT);
	assert.match(text, /messageContent/);
	assert.match(text, /guildMessages/);
});
