const test = require('node:test');
const assert = require('node:assert');

const CommandInterface = require('../src/commands/CommandInterface.js');

function params(overrides = {}) {
	const calls = { error: 0, executed: 0 };
	const p = {
		msg: {
			channel: {
				type: 0,
				nsfw: false,
				permissionsOf: () => ({ has: (perm) => !overrides.missingPerms?.includes(perm) }),
			},
		},
		errorMsg: () => calls.error++,
		logger: { incr: () => {} },
		...overrides.params,
	};
	return { p, calls };
}

test('permission check blocks execution and reports once', async () => {
	const calls = { error: 0, executed: 0 };
	const command = new CommandInterface({
		alias: ['demo'],
		permissions: ['embedLinks'],
		execute: () => calls.executed++,
	});
	await command.execute({
		// bot can speak in the channel, but is missing embedLinks
		msg: {
			channel: { type: 0, permissionsOf: () => ({ has: (perm) => perm !== 'embedLinks' }) },
		},
		client: { user: { id: '408785106942164992' } },
		errorMsg: () => calls.error++,
		logger: { incr: () => {} },
	});
	assert.strictEqual(calls.executed, 0);
	assert.strictEqual(calls.error, 1);
});

test('nsfw-only commands are refused outside nsfw channels', async () => {
	const calls = { error: 0, executed: 0 };
	const command = new CommandInterface({
		alias: ['lewd'],
		nsfw: true,
		execute: () => calls.executed++,
	});
	await command.execute({
		msg: { channel: { type: 0, nsfw: false } },
		errorMsg: () => calls.error++,
	});
	assert.strictEqual(calls.executed, 0);
	assert.strictEqual(calls.error, 1);
});

test('execute is bound to the command parameter object', async () => {
	let received;
	const command = new CommandInterface({
		alias: ['bind'],
		execute: async function (p) {
			received = { same: this === p, p };
		},
	});
	const { p } = params();
	await command.execute(p);
	assert.strictEqual(received.same, true);
	assert.strictEqual(received.p, p);
});

test('executeCommand alias is stored separately from the interface', () => {
	const command = new CommandInterface({ alias: ['x'], execute: () => {} });
	assert.strictEqual(typeof command.executeCommand, 'function');
	assert.strictEqual(command.execute, CommandInterface.prototype.execute);
});

test('all API calls to execute rejections are contained by runCommandSafely', async () => {
	const errors = require('../src/utils/errors.js');
	let errorMessages = 0;
	const p = { command: 'explode', msg: { author: { id: '1' } }, errorMsg: () => errorMessages++ };
	await errors.runCommandSafely(p, async () => {
		throw new Error('kaboom');
	});
	await errors.runCommandSafely(p, async () => {
		throw new Error('kaboom again');
	});
	assert.strictEqual(errorMessages, 1, 'user is told exactly once per invocation');
});
