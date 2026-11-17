const test = require('node:test');
const assert = require('node:assert');

const readyState = require('../src/utils/readyState.js');

test('a cluster loaded after READY needs one replay', () => {
	const main = {};
	assert.strictEqual(readyState.needsReplay(main, { ready: true }), true);
});

test('a cluster loaded before READY must not replay', () => {
	assert.strictEqual(readyState.needsReplay({}, { ready: false }), false);
	assert.strictEqual(readyState.needsReplay({}, null), false);
	assert.strictEqual(readyState.needsReplay(null, { ready: true }), false);
});

test('the replay happens exactly once', () => {
	const main = {};
	const bot = { ready: true };
	assert.strictEqual(readyState.needsReplay(main, bot), true);
	readyState.markReplayed(main);
	assert.strictEqual(readyState.needsReplay(main, bot), false);
	assert.strictEqual(main.__readyReplayed, true);
});
