const test = require('node:test');
const assert = require('node:assert');

const { freshRequire, withEnv, OWNER_A } = require('./helpers.js');

function loadSandbox(env) {
	return withEnv(env, () => {
		freshRequire('../src/utils/config.js');
		return freshRequire('../src/utils/sandbox.js');
	});
}

test('eval is disabled by default', () => {
	const sandbox = loadSandbox({ ALLOW_EVAL: undefined });
	assert.strictEqual(sandbox.isEnabled(), false);
	assert.throws(() => sandbox.run('1 + 1', {}), /eval is disabled/);
});

test('eval runs when explicitly enabled', () => {
	const sandbox = loadSandbox({ ALLOW_EVAL: 'true', OWNER_IDS: OWNER_A });
	assert.strictEqual(sandbox.isEnabled(), true);
	assert.strictEqual(sandbox.run('1 + 2', {}), 3);
});

test('require/process/module are shadowed inside the evaluation scope', () => {
	const sandbox = loadSandbox({ ALLOW_EVAL: 'true' });
	assert.strictEqual(sandbox.run('typeof require', {}), 'undefined');
	assert.strictEqual(sandbox.run('typeof process', {}), 'undefined');
	assert.strictEqual(sandbox.run('typeof module', {}), 'undefined');
	assert.strictEqual(sandbox.run('typeof globalThis', {}), 'undefined');
});

test('output is redacted and truncated before it reaches Discord', () => {
	withEnv({ OUTPUT_TEST_TOKEN: 'abcdefghij-secret' }, () => {
		const sandbox = loadSandbox({ ALLOW_EVAL: 'true' });
		const formatted = sandbox.formatResult('abcdefghij-secret');
		assert.ok(!formatted.includes('abcdefghij-secret'));
		assert.ok(formatted.startsWith('```js'));

		const long = sandbox.formatResult('x'.repeat(5000));
		assert.ok(long.includes('(truncated)'));

		assert.strictEqual(sandbox.formatResult(undefined).includes('undefined'), true);
		assert.strictEqual(sandbox.formatResult(new Error('boom')).includes('Error: boom'), true);
		assert.strictEqual(sandbox.formatResult({ a: 1 }).includes('"a": 1'), true);
	});
});
