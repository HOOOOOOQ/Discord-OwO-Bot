/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Test fixture: an in-memory MongoDB client.
 *
 * The startup test runs the real `index.js` (master + eris-sharder workers), so
 * the database must answer without a MongoDB server. `NODE_OPTIONS=--require
 * this-file` replaces the client module before index.js can require it.
 *
 * It exports the same surface as `src/utils/mongo/client.js` and is backed by the
 * project's own `MemoryStore`, so the SQL/KV layers still run for real.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { MemoryStore } = require(path.join(ROOT, 'src/utils/mongo/store.js'));

const store = new MemoryStore();
store.connect();

const target = require.resolve(path.join(ROOT, 'src/utils/mongo/client.js'));
require.cache[target] = {
	id: target,
	filename: target,
	loaded: true,
	children: [],
	paths: [],
	exports: {
		connect: async () => store,
		getStore: () => store,
		isConnected: () => true,
		whenReady: async () => store,
		close: async () => {},
		maskUri: () => 'mongodb://***@memory/ocean',
		readUri: () => 'mongodb://memory/ocean',
		databaseName: () => 'ocean',
		inspectUri: () => ({ ok: true, scheme: 'mongodb', host: 'memory', database: 'ocean' }),
	},
};
