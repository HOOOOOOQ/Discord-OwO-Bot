/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Public entry point of the SQL → MongoDB layer.
 *
 * Everything the bot used to send to a MySQL server goes through here:
 *
 *   const sql = require('.../mongo/sql');
 *   const rows = await sql.query('SELECT money FROM cowoncy WHERE id = ?', [id]);
 *
 * `sql.query` returns the same shapes the mysql driver returned, so the ~350
 * existing call sites (including `result[0][0]` for multi-statement strings)
 * keep working without changes.
 */

const { Executor } = require('./executor.js');
const client = require('../client.js');
const log = require('../../log.js');

let sharedExecutor = null;

function engine(store) {
	return new Executor({ store: store || client.getStore(), log });
}

async function query(sql, params = [], options = {}) {
	const executor = options.executor || sharedExecutor || engine();
	return executor.execute(sql, params);
}

/** A query function bound to one MongoDB session (used by transactions). */
function withSession(store, session) {
	const executor = new Executor({ store, session, log });
	return {
		execute: (sql, params) => executor.execute(sql, params),
		executor,
	};
}

function reset() {
	sharedExecutor = null;
}

module.exports = { query, engine, withSession, reset };
