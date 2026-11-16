const test = require('node:test');
const assert = require('node:assert');

const mysqlHandler = require('../src/botHandlers/mysqlHandler.js');
const mysqlPool = require('../src/utils/mysql.js');

test.after(async () => {
	await mysqlPool.close();
});

function fakeConnection(overrides = {}) {
	const state = { released: 0, committed: 0, rolledBack: 0, queries: [] };
	const acon = {
		threadId: 1,
		release() {
			state.released++;
		},
		commit(cb) {
			overrides.commitError ? cb(overrides.commitError) : (state.committed++, cb());
		},
		rollback(cb) {
			state.rolledBack++;
			cb();
		},
		query(options, values, cb) {
			state.queries.push({ options, values });
			cb(null, [{ ok: 1 }]);
		},
	};
	return { acon, state };
}

test('query() passes an object with a timeout and resolves rows', async () => {
	let captured;
	mysqlHandler.setConnection({
		query(options, values, cb) {
			captured = { options, values };
			cb(null, [{ id: 1 }]);
		},
	});
	const rows = await mysqlHandler.query('SELECT * FROM user WHERE id = ?', [42]);
	assert.deepStrictEqual(rows, [{ id: 1 }]);
	assert.strictEqual(captured.options.sql, 'SELECT * FROM user WHERE id = ?');
	assert.strictEqual(typeof captured.options.timeout, 'number');
	assert.deepStrictEqual(captured.values, [42]);
});

test('query() rejects with the driver error', async () => {
	mysqlHandler.setConnection({
		query(options, values, cb) {
			cb(new Error('boom'));
		},
	});
	await assert.rejects(mysqlHandler.query('SELECT 1'), /boom/);
});

test('commit releases the connection exactly once and is idempotent', async () => {
	const { acon, state } = fakeConnection();
	const tx = mysqlHandler.buildTransaction(acon, { timeLimit: 1000 });
	assert.strictEqual(await tx.commit(), true);
	assert.strictEqual(state.committed, 1);
	assert.strictEqual(state.released, 1);
	assert.strictEqual(await tx.commit(), false);
	assert.strictEqual(state.released, 1);
	assert.strictEqual(await tx.rollback(), false);
	assert.strictEqual(state.released, 1);
});

test('rollback releases once and rejects later queries', async () => {
	const { acon, state } = fakeConnection();
	const tx = mysqlHandler.buildTransaction(acon, { timeLimit: 1000 });
	await tx.rollback();
	assert.strictEqual(state.rolledBack, 1);
	assert.strictEqual(state.released, 1);
	await assert.rejects(tx.query('SELECT 1'), /already closed/);
});

test('a failing commit rolls back and releases before rejecting', async () => {
	const { acon, state } = fakeConnection({ commitError: new Error('deadlock') });
	const tx = mysqlHandler.buildTransaction(acon, { timeLimit: 1000 });
	await assert.rejects(tx.commit(), /deadlock/);
	assert.strictEqual(state.rolledBack, 1);
	assert.strictEqual(state.released, 1);
});

test('queries inside an open transaction are forwarded with parameters', async () => {
	const { acon, state } = fakeConnection();
	const tx = mysqlHandler.buildTransaction(acon, { timeLimit: 1000 });
	const rows = await tx.query('UPDATE x SET y = ? WHERE id = ?', ['a', 1]);
	assert.deepStrictEqual(rows, [{ ok: 1 }]);
	assert.strictEqual(state.queries.length, 1);
	assert.deepStrictEqual(state.queries[0].values, ['a', 1]);
	await tx.commit();
});

test('an abandoned lease is rolled back by the watchdog', async () => {
	const { acon, state } = fakeConnection();
	mysqlHandler.buildTransaction(acon, { timeLimit: 20 });
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.strictEqual(state.rolledBack, 1);
	assert.strictEqual(state.released, 1);
});

test('startTransaction waits for beginTransaction and never throws from the callback', async () => {
	mysqlHandler.setConnection({
		getConnection(cb) {
			cb(null, {
				threadId: 2,
				beginTransaction(inner) {
					inner(new Error('cannot start'));
				},
				release() {
					this.released = true;
				},
			});
		},
	});
	await assert.rejects(mysqlHandler.startTransaction(), /cannot start/);
});
