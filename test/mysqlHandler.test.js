/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The SQL handler now runs on MongoDB. These tests pin the contract the command
 * code relies on:
 *
 *   - `query(sql, values)` resolves rows / OK packets,
 *   - `startTransaction()` returns a handle whose `query` runs inside the
 *     session, and whose `commit`/`rollback` are idempotent,
 *   - an abandoned transaction is rolled back by its watchdog.
 *
 * A real `MemoryStore` stands in for MongoDB, with a fake session, so no network
 * or database is required.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { MemoryStore, MongoStore } = require('../src/utils/mongo/store.js');

function fakeStore() {
	const store = new MemoryStore();
	store.sessions = [];
	store.startSession = async function () {
		const session = {
			id: store.sessions.length + 1,
			committed: 0,
			aborted: 0,
			ended: 0,
			commitTransaction() {
				this.committed++;
			},
			abortTransaction() {
				this.aborted++;
			},
			async endSession() {
				this.ended++;
			},
		};
		store.sessions.push(session);
		return session;
	};
	return store;
}

function installStubs() {
	const store = fakeStore();
	const stubs = {
		'/src/utils/mongo/client.js': {
			connect: async () => store,
			close: async () => {},
			getStore: () => store,
			isConnected: () => true,
			whenReady: async () => store,
		},
		'/src/utils/mongo/sql/index.js': null,
	};
	for (const suffix of Object.keys(stubs)) {
		const resolved = require.resolve(path.join(__dirname, '..', suffix));
		if (stubs[suffix]) {
			require.cache[resolved] = {
				id: resolved,
				filename: resolved,
				loaded: true,
				exports: stubs[suffix],
				children: [],
				paths: [],
			};
		} else {
			delete require.cache[resolved];
		}
	}
	return store;
}

let store;
let handler;

test.before(() => {
	store = installStubs();
	handler = require('../src/botHandlers/mysqlHandler.js');
});

test('query() runs SQL against MongoDB and resolves rows', async () => {
	await handler.query('INSERT INTO user (id,count) VALUES (?,?)', ['123456789012345678', 4]);
	const rows = await handler.query('SELECT id, count FROM user WHERE id = ?', [
		'123456789012345678',
	]);
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(rows[0].id, '123456789012345678');
	assert.strictEqual(rows[0].count, 4);
});

test('query() rejects with the engine error', async () => {
	await assert.rejects(handler.query('SELECT * FROM table_that_does_not_exist'), /unknown table/i);
});

test('setConnection() lets a caller inject its own connection', async () => {
	let captured;
	handler.setConnection({
		query(options, values, cb) {
			captured = { options, values };
			cb(null, [{ id: 1 }]);
		},
	});
	const rows = await handler.query('SELECT * FROM user WHERE id = ?', [42]);
	assert.deepStrictEqual(rows, [{ id: 1 }]);
	assert.strictEqual(captured.options.sql, 'SELECT * FROM user WHERE id = ?');
	assert.deepStrictEqual(captured.values, [42]);
	// restore the real connection for the remaining tests
	handler.setConnection(require('../src/utils/mysql.js').con);
});

test('startTransaction() opens a session and forwards queries', async () => {
	const before = store.sessions.length;
	const tx = await handler.startTransaction();
	assert.strictEqual(store.sessions.length, before + 1, 'a session was opened');
	await tx.query('INSERT INTO cowoncy (id,money) VALUES (?,?)', [1, 100]);
	const rows = await tx.query('SELECT money FROM cowoncy WHERE id = ?', [1]);
	assert.strictEqual(String(rows[0].money), '100');
	assert.strictEqual(await tx.commit(), true);
});

test('commit is idempotent and rollback rejects later queries', async () => {
	const tx = await handler.startTransaction();
	await tx.query('INSERT INTO cowoncy (id,money) VALUES (?,?)', [2, 50]);
	assert.strictEqual(await tx.commit(), true);
	assert.strictEqual(await tx.commit(), false, 'second commit is a no-op');

	const tx2 = await handler.startTransaction();
	await tx2.rollback();
	await assert.rejects(tx2.query('SELECT 1'), /already closed/i);
});

test('a failing commit is surfaced instead of swallowed', async () => {
	const tx = await handler.startTransaction();
	const session = store.sessions[store.sessions.length - 1];
	session.commitTransaction = async () => {
		throw new Error('commit failed');
	};
	await assert.rejects(tx.commit(), /commit failed/);
});

test('an abandoned transaction is rolled back by the watchdog', async () => {
	const previous = process.env.MONGO_TRANSACTION_TIMEOUT_MS;
	process.env.MONGO_TRANSACTION_TIMEOUT_MS = '50';
	delete require.cache[require.resolve('../src/botHandlers/mysqlHandler.js')];
	const freshHandler = require('../src/botHandlers/mysqlHandler.js');
	const tx = await freshHandler.startTransaction();
	await new Promise((resolve) => setTimeout(resolve, 150));
	const session = store.sessions[store.sessions.length - 1];
	assert.ok(session.aborted >= 1, 'the transaction was aborted');
	await tx.rollback();
	if (previous === undefined) delete process.env.MONGO_TRANSACTION_TIMEOUT_MS;
	else process.env.MONGO_TRANSACTION_TIMEOUT_MS = previous;
	delete require.cache[require.resolve('../src/botHandlers/mysqlHandler.js')];
});

test('MongoStore.startSession reports unsupported servers instead of throwing', async () => {
	const broken = Object.create(MongoStore.prototype);
	broken.client = {
		startSession() {
			throw new Error('Transaction numbers are only allowed on a replica set member');
		},
	};
	broken.log = { warn() {}, error() {}, info() {}, debug() {} };
	const session = await broken.startSession();
	assert.strictEqual(session, null);
});
