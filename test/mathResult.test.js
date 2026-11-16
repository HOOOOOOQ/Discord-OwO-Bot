const test = require('node:test');
const assert = require('node:assert');

const { classifyMathError } = require('../src/utils/mathResult.js');

test('workerpool timeout messages are classified as timeout', () => {
	assert.strictEqual(classifyMathError({ message: 'Promise timed out after 3000 ms' }), 'timeout');
	assert.strictEqual(classifyMathError({ code: 'WORKERPOOL_TIMEOUT' }), 'timeout');
	assert.strictEqual(classifyMathError({ name: 'TimeoutError', message: 'nope' }), 'timeout');
});

test('regression: the old hardcoded 1000ms string is no longer required', () => {
	// The command used to compare against "Promise timed out after 1000 ms"
	// while configuring a 3000ms budget, so the message never matched.
	const configured = 3000;
	assert.strictEqual(
		classifyMathError({ message: `Promise timed out after ${configured} ms` }),
		'timeout'
	);
});

test('real evaluation errors stay invalid', () => {
	assert.strictEqual(classifyMathError(new Error('Unexpected end of expression')), 'invalid');
	assert.strictEqual(classifyMathError(undefined), 'invalid');
});
