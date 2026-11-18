/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Promise wrapper around the database, exactly like before — only the engine
 * underneath changed (MongoDB Atlas instead of a MySQL server).
 *
 * `startTransaction()` opens a MongoDB session and transaction on Atlas (which
 * is always a replica set). If the deployment cannot do transactions (a
 * standalone mongod, e.g. a local test instance), it logs once and keeps going
 * without one: the statements still run, they are just not rolled back together.
 * The economic operations themselves are atomic either way, because they use
 * `$inc` / upserts rather than read-modify-write.
 */

const log = require('../utils/log.js');
const client = require('../utils/mongo/client.js');
const sqlLayer = require('../utils/mongo/sql/index.js');

let con = require('../utils/mysql.js').con;
let warnedAboutTransactions = false;
let transactionCounter = 0;

const acquireTimeLimit = Number.parseInt(process.env.MONGO_TRANSACTION_TIMEOUT_MS, 10) || 15000;
const queryTimeout = Number.parseInt(process.env.MONGO_QUERY_TIMEOUT_MS, 10) || 30000;

/** Allows tests to inject a fake connection without touching MongoDB. */
exports.setConnection = function (connection) {
	con = connection;
};

/** Converts a query to a Promise. */
exports.query = function (sql, variables = []) {
	return new Promise((resolve, reject) => {
		con.query({ sql, timeout: queryTimeout }, variables, function (err, rows) {
			if (err) return reject(err);
			resolve(rows);
		});
	});
};

/**
 * Starts a transaction and returns `{ commit, rollback, query }`.
 * A handle that is never settled is aborted by a watchdog, so an abandoned
 * transaction can never hold a session open.
 */
exports.startTransaction = async function () {
	await client.whenReady();
	const store = client.getStore();
	const session = await store.startSession();
	if (!session && !warnedAboutTransactions) {
		warnedAboutTransactions = true;
		log.warn(
			'[MONGO] this MongoDB deployment does not support transactions; ' +
				'multi-step operations run without one (Atlas always supports them)'
		);
	}
	const scoped = session ? sqlLayer.withSession(store, session) : null;
	const id = ++transactionCounter;
	let settled = false;
	let timer = null;

	const finish = async (action) => {
		if (settled) return false;
		settled = true;
		if (timer) clearTimeout(timer);
		if (!session) return false;
		try {
			if (action === 'commit') {
				await session.commitTransaction();
				return true;
			}
			await session.abortTransaction();
			return false;
		} finally {
			await session.endSession().catch(() => {});
		}
	};

	const transaction = {
		id,
		query(sql, variables = []) {
			if (settled) return Promise.reject(new Error('Transaction is already closed'));
			if (scoped) return scoped.execute(sql, variables);
			return sqlLayer.query(sql, variables);
		},
		commit: () => finish('commit'),
		rollback: () => finish('rollback'),
	};

	if (session) {
		timer = setTimeout(() => {
			log.error(
				`[MONGO] transaction ${id} was not settled within ${acquireTimeLimit}ms — rolling back`
			);
			finish('rollback');
		}, acquireTimeLimit);
		if (typeof timer.unref === 'function') timer.unref();
	}

	return transaction;
};

/** Kept for compatibility with the old lifecycle tests. */
exports.buildTransaction = function (acon, options = {}) {
	return exports.startTransaction(options);
};
