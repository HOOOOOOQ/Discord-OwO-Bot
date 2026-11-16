/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const log = require('../utils/log.js');

let con = require('../utils/mysql.js').con;
const acquireTimeLimit = Number.parseInt(process.env.MYSQL_TRANSACTION_TIMEOUT_MS, 10) || 10000;
const queryTimeout = Number.parseInt(process.env.MYSQL_QUERY_TIMEOUT_MS, 10) || 30000;

/** Allows tests to inject a fake pool without touching the real connection. */
exports.setConnection = function (connection) {
	con = connection;
};

/* Converts mysql queries to Promises */
exports.query = function (sql, variables = []) {
	return new Promise((resolve, reject) => {
		con.query({ sql, timeout: queryTimeout }, variables, function (err, rows) {
			if (err) return reject(err);
			resolve(rows);
		});
	});
};

/**
 * Builds the transaction handle for an already-acquired connection.
 *
 * Every terminal operation (commit / rollback) is idempotent, releases the
 * connection exactly once, and never throws from inside a driver callback.
 * Exported so the lifecycle can be unit tested against a fake connection.
 */
exports.buildTransaction = function (acon, options = {}) {
	const timeLimit = options.timeLimit || acquireTimeLimit;
	const onWarn = options.onWarn || ((message) => log.error(message));
	let settled = false;
	let releaseTimer = null;

	const release = () => {
		try {
			acon.release();
		} catch (err) {
			onWarn(`[${acon.threadId}] Failed to release mysql connection: ${err.message}`);
		}
	};

	const clearTimer = () => {
		if (releaseTimer) {
			clearTimeout(releaseTimer);
			releaseTimer = null;
		}
	};

	const rollback = function (reason) {
		if (settled) return Promise.resolve(false);
		settled = true;
		clearTimer();
		if (reason) onWarn(`[${acon.threadId}] Transaction rolled back: ${reason}`);
		return new Promise((resolve) => {
			acon.rollback(() => {
				release();
				resolve(false);
			});
		});
	};

	const commit = function () {
		if (settled) return Promise.resolve(false);
		settled = true;
		clearTimer();
		return new Promise((resolve, reject) => {
			acon.commit((err) => {
				if (err) {
					acon.rollback(() => {
						release();
						reject(err);
					});
					return;
				}
				release();
				resolve(true);
			});
		});
	};

	const transaction = {
		commit,
		rollback,
		query: (sql, variables = []) =>
			new Promise((resolve, reject) => {
				if (settled) {
					reject(new Error('Transaction is already closed'));
					return;
				}
				acon.query({ sql, timeout: queryTimeout }, variables, (err, rows) => {
					if (err) return reject(err);
					resolve(rows);
				});
			}),
	};

	releaseTimer = setTimeout(() => {
		onWarn(`[${acon.threadId}] Mysql connection was not released!`);
		rollback('lease timeout');
	}, timeLimit);
	// Do not keep the process alive just for the lease watchdog
	releaseTimer.unref?.();

	return transaction;
};

exports.startTransaction = function () {
	return new Promise((resolve, reject) => {
		con.getConnection((err, acon) => {
			if (err) return reject(err);
			acon.beginTransaction((beginErr) => {
				if (beginErr) {
					try {
						acon.release();
					} catch (releaseError) {
						log.error('Failed to release connection after failed transaction start');
					}
					return reject(beginErr);
				}
				resolve(exports.buildTransaction(acon));
			});
		});
	});
};
