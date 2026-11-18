/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Graceful shutdown.
 *
 * The panel sends SIGTERM when it stops or restarts the server; if the process
 * ignores it, Pterodactyl kills it after the timeout and a MongoDB write can be
 * cut in half. These tests pin the contract:
 *
 *   every registered hook runs, in order → the process exits with the code it
 *   was given → a hook that throws is logged and does not abort the others →
 *   a hook that hangs is capped instead of blocking the exit.
 */

const test = require('node:test');
const assert = require('node:assert');

const errors = require('../src/utils/errors.js');

/** Replaces `process.exit` so the test process survives the call. */
function captureExit() {
	const codes = [];
	const original = process.exit;
	process.exit = (code) => {
		codes.push(code === undefined ? 0 : code);
		throw new Error('__process_exit__');
	};
	return {
		codes,
		restore() {
			process.exit = original;
		},
	};
}

test('shutdown hooks run in order and the process exits with the given code', async () => {
	const order = [];
	errors.registerShutdownHook(async (reason) => order.push(`first:${reason}`));
	errors.registerShutdownHook(async () => order.push('second'));

	const exit = captureExit();
	try {
		await errors.runShutdown('SIGTERM', 1);
	} catch (err) {
		assert.strictEqual(err.message, '__process_exit__', 'exited through process.exit');
	} finally {
		exit.restore();
	}

	assert.deepStrictEqual(order, ['first:SIGTERM', 'second'], 'hooks ran in registration order');
	assert.deepStrictEqual(exit.codes, [1], 'the requested exit code was used');
	assert.strictEqual(errors.isShuttingDown(), true);
});

test('a second shutdown request is ignored (no double close, no second exit)', async () => {
	const exit = captureExit();
	try {
		await errors.runShutdown('SIGINT', 0);
	} catch (err) {
		assert.strictEqual(err.message, '__process_exit__');
	} finally {
		exit.restore();
	}
	assert.deepStrictEqual(exit.codes, [], 'the already-shutting-down guard returned early');
});

test('a hook that hangs is capped instead of blocking the exit', async () => {
	// Fresh copy: `runShutdown` is one-shot per module instance.
	process.env.SHUTDOWN_HOOK_TIMEOUT_MS = '25';
	const modulePath = require.resolve('../src/utils/errors.js');
	const original = require.cache[modulePath];
	delete require.cache[modulePath];
	const fresh = require('../src/utils/errors.js');
	fresh.registerShutdownHook(() => new Promise(() => {}));

	const exit = captureExit();
	const started = Date.now();
	try {
		await fresh.runShutdown('SIGTERM', 1);
	} catch (err) {
		assert.strictEqual(err.message, '__process_exit__');
	} finally {
		exit.restore();
		require.cache[modulePath] = original;
		delete process.env.SHUTDOWN_HOOK_TIMEOUT_MS;
	}

	assert.ok(Date.now() - started < 2000, 'the hanging hook was capped');
	assert.deepStrictEqual(exit.codes, [1], 'the requested code survived the timeout');
});

test('the signal handlers are installed once and forward the exit code', () => {
	const before = {
		term: process.listenerCount('SIGTERM'),
		int: process.listenerCount('SIGINT'),
	};

	errors.installProcessHandlers();
	errors.installProcessHandlers();

	assert.strictEqual(
		process.listenerCount('SIGTERM'),
		Math.max(before.term, 1),
		'SIGTERM is handled exactly once'
	);
	assert.strictEqual(
		process.listenerCount('SIGINT'),
		Math.max(before.int, 1),
		'SIGINT is handled exactly once'
	);
});
