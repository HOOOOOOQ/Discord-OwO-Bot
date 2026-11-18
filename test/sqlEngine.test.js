/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Behaviour of the SQL → MongoDB engine against a real in-memory document store.
 * Each test here mirrors a command flow (hunt, daily, battle, giveaway, quest,
 * ranking) so a regression in the engine is caught without a database server.
 */

const test = require('node:test');
const assert = require('node:assert');

const { MemoryStore } = require('../src/utils/mongo/store.js');
const { Executor } = require('../src/utils/mongo/sql/executor.js');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const BIG_ID = '123456789012345678';

async function fresh() {
	const store = new MemoryStore();
	await store.connect();
	return { store, db: new Executor({ store, log: silent }) };
}

test('a row inserted once is not inserted twice (INSERT IGNORE)', async () => {
	const { db } = await fresh();
	const first = await db.execute('INSERT INTO user (id,count) VALUES (?,?)', [BIG_ID, 0]);
	assert.strictEqual(first.affectedRows, 1);
	const second = await db.execute('INSERT IGNORE INTO user (id,count) VALUES (?,0)', [BIG_ID]);
	assert.strictEqual(second.affectedRows, 0);
	const rows = await db.execute('SELECT count FROM user WHERE id = ?', [BIG_ID]);
	assert.strictEqual(rows.length, 1);
});

test('a duplicate key without IGNORE throws like MySQL did', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [BIG_ID]);
	await assert.rejects(
		db.execute('INSERT INTO user (id,count) VALUES (?,0)', [BIG_ID]),
		/duplicate/i
	);
});

test('ON DUPLICATE KEY UPDATE accumulates with atomic $inc', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [BIG_ID, 100]);
	for (let i = 0; i < 10; i++) {
		await db.execute(
			'INSERT INTO cowoncy (id,money) VALUES (?,?) ON DUPLICATE KEY UPDATE money = money + ?',
			[BIG_ID, 100, 10]
		);
	}
	const rows = await db.execute('SELECT money FROM cowoncy WHERE id = ?', [BIG_ID]);
	assert.strictEqual(String(rows[0].money), '200');
});

test('parallel increments never lose a write', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [BIG_ID, 0]);
	await Promise.all(
		Array.from({ length: 25 }, () =>
			db.execute('UPDATE cowoncy SET money = money + ? WHERE id = ?', [4, BIG_ID])
		)
	);
	const rows = await db.execute('SELECT money FROM cowoncy WHERE id = ?', [BIG_ID]);
	assert.strictEqual(String(rows[0].money), '100');
});

test('a guarded spend only succeeds when the balance is high enough', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [BIG_ID, 50]);
	const failed = await db.execute(
		'UPDATE cowoncy SET money = money - ? WHERE id = ? AND money >= ?',
		[100, BIG_ID, 100]
	);
	assert.strictEqual(failed.affectedRows, 0);
	const rows = await db.execute('SELECT money FROM cowoncy WHERE id = ?', [BIG_ID]);
	assert.strictEqual(String(rows[0].money), '50');
});

test('AUTO_INCREMENT generates increasing ids and reports insertId', async () => {
	const { db } = await fresh();
	const a = await db.execute('INSERT INTO pet_team (uid, name) VALUES (?,?)', [1, 'a']);
	const b = await db.execute('INSERT INTO pet_team (uid, name) VALUES (?,?)', [2, 'b']);
	assert.ok(a.insertId > 0);
	assert.ok(b.insertId > a.insertId);
	const rows = await db.execute('SELECT pgid FROM pet_team ORDER BY pgid ASC');
	assert.strictEqual(rows.length, 2);
});

test('INNER JOIN only returns matched rows, LEFT JOIN keeps them with nulls', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [BIG_ID]);
	const uid = (await db.execute('SELECT uid FROM user WHERE id = ?', [BIG_ID]))[0].uid;
	await db.execute('INSERT INTO rules (uid) VALUES (?)', [uid]);
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', ['987654321098765432']);

	const inner = await db.execute(
		'SELECT rules.* FROM rules INNER JOIN user ON user.uid = rules.uid WHERE id = ?',
		[BIG_ID]
	);
	assert.strictEqual(inner.length, 1);

	const left = await db.execute(
		'SELECT user.id, patreonMonths FROM user LEFT JOIN patreons ON user.uid = patreons.uid WHERE id = ?',
		[BIG_ID]
	);
	assert.strictEqual(left.length, 1);
	assert.strictEqual(left[0].patreonMonths, null);
});

test('UPDATE ... JOIN updates only the matching rows', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [BIG_ID]);
	const uid = (await db.execute('SELECT uid FROM user WHERE id = ?', [BIG_ID]))[0].uid;
	await db.execute('INSERT INTO crate (uid, boxcount) VALUES (?, 5)', [uid]);
	const result = await db.execute(
		'UPDATE crate INNER JOIN user ON crate.uid = user.uid SET crate.boxcount = crate.boxcount - ? WHERE user.id = ? AND boxcount >= ?',
		[3, BIG_ID, 3]
	);
	assert.strictEqual(result.affectedRows, 1);
	const rows = await db.execute('SELECT boxcount FROM crate WHERE uid = ?', [uid]);
	assert.strictEqual(String(rows[0].boxcount), '2');
});

test('multi-table DELETE removes rows from the named table only', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [BIG_ID]);
	const uid = (await db.execute('SELECT uid FROM user WHERE id = ?', [BIG_ID]))[0].uid;
	await db.execute('INSERT INTO animal (id, name, count, totalcount) VALUES (?,?,?,?)', [
		BIG_ID,
		'dog',
		1,
		1,
	]);
	await db.execute('INSERT INTO pet_team_animal (pid, pgid, pos) VALUES (1, 1, 1)');
	const deleted = await db.execute(
		'DELETE pta FROM pet_team_animal pta INNER JOIN animal a ON pta.pid = a.pid WHERE a.id = ?',
		[BIG_ID]
	);
	assert.strictEqual(deleted.affectedRows, 1);
	const left = await db.execute('SELECT * FROM animal WHERE id = ?', [BIG_ID]);
	assert.strictEqual(left.length, 1, 'the animal row is untouched');
	assert.ok(uid);
});

test('multi-statement strings return one result per statement', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [BIG_ID, 42]);
	const results = await db.execute(
		'SELECT money FROM cowoncy WHERE id = ?; UPDATE cowoncy SET money = 0 WHERE id = ?;',
		[BIG_ID, BIG_ID]
	);
	assert.strictEqual(results.length, 2);
	assert.strictEqual(String(results[0][0].money), '42');
	assert.strictEqual(results[1].affectedRows, 1);
});

test('ORDER BY sorts numerically even for big values', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [1, 9]);
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [2, 100]);
	await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [3, 25]);
	const rows = await db.execute('SELECT id, money FROM cowoncy ORDER BY money DESC');
	assert.deepStrictEqual(
		rows.map((row) => String(row.money)),
		['100', '25', '9']
	);
});

test('LIMIT and OFFSET paginate the way the transaction/history commands expect', async () => {
	const { db } = await fresh();
	for (let i = 1; i <= 5; i++) {
		await db.execute('INSERT INTO cowoncy (id,money) VALUES (?,?)', [i, i]);
	}
	const page = await db.execute('SELECT id FROM cowoncy ORDER BY id DESC LIMIT 2 OFFSET 2');
	assert.deepStrictEqual(
		page.map((row) => String(row.id)),
		['3', '2']
	);
});

test('COUNT/SUM/MAX and GROUP BY work', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO animal (id, name, count, totalcount) VALUES (?,?,?,?)', [
		1,
		'dog',
		2,
		2,
	]);
	await db.execute('INSERT INTO animal (id, name, count, totalcount) VALUES (?,?,?,?)', [
		1,
		'cat',
		3,
		3,
	]);
	const counts = await db.execute(
		'SELECT name, COUNT(*) AS c FROM animal GROUP BY name ORDER BY name ASC'
	);
	assert.deepStrictEqual(
		counts.map((row) => [row.name, Number(row.c)]),
		[
			['cat', 1],
			['dog', 1],
		]
	);
	const sum = await db.execute('SELECT SUM(count) AS total FROM animal');
	assert.strictEqual(Number(sum[0].total), 5);
	const max = await db.execute('SELECT MAX(count) AS best FROM animal');
	assert.strictEqual(Number(max[0].best), 3);
});

test('subqueries and IN (SELECT ...) resolve', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [BIG_ID]);
	const uid = (await db.execute('SELECT uid FROM user WHERE id = ?', [BIG_ID]))[0].uid;
	await db.execute('INSERT INTO quest (uid, qid, qname, count) VALUES (?,?,?,?)', [
		uid,
		1,
		'hunt',
		2,
	]);
	const viaSubquery = await db.execute(
		'SELECT * FROM quest WHERE uid = (SELECT uid FROM user WHERE id = ?) ORDER BY qid asc',
		[BIG_ID]
	);
	assert.strictEqual(viaSubquery.length, 1);
	const viaIn = await db.execute(
		'SELECT qname FROM quest WHERE uid IN (SELECT uid FROM user WHERE id = ?)',
		[BIG_ID]
	);
	assert.strictEqual(viaIn[0].qname, 'hunt');
});

test('TIMESTAMPDIFF drives the battle-expiry queries', async () => {
	const { db } = await fresh();
	await db.execute(
		'INSERT INTO user_battle (user1, user2, bet, time, sender) VALUES (?,?,?,NOW(),?)',
		[1, 2, 10, 1]
	);
	const active = await db.execute(
		'SELECT bet FROM user_battle WHERE TIMESTAMPDIFF(MINUTE,time,NOW()) < 10 AND ( user1 = ? OR user2 = ? )',
		[1, 2]
	);
	assert.strictEqual(active.length, 1);
	await db.execute("UPDATE user_battle SET time = '2018-01-01' WHERE user1 = ?", [1]);
	const expired = await db.execute(
		'SELECT bet FROM user_battle WHERE TIMESTAMPDIFF(MINUTE,time,NOW()) < 10 AND ( user1 = ? OR user2 = ? )',
		[1, 2]
	);
	assert.strictEqual(expired.length, 0);
});

test('REPLACE INTO overwrites the row', async () => {
	const { db } = await fresh();
	// `animals_rank` is keyed by the rank name, not an id
	await db.execute('INSERT INTO animals_rank (rank, emoji, name) VALUES (?,?,?)', [
		'common',
		'c',
		'Common',
	]);
	await db.execute('REPLACE INTO animals_rank (rank, emoji, name) VALUES (?,?,?)', [
		'common',
		'C',
		'COMMON',
	]);
	const rows = await db.execute('SELECT emoji FROM animals_rank WHERE rank = ?', ['common']);
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(rows[0].emoji, 'C');
});

test('a generated column is computed on read', async () => {
	const { db } = await fresh();
	await db.execute('INSERT INTO animal_count (id, common, uncommon) VALUES (?,?,?)', [1, 2, 3]);
	const rows = await db.execute('SELECT total FROM animal_count WHERE id = ?', [1]);
	// common*1 + uncommon*5 = 2 + 15
	assert.strictEqual(Number(rows[0].total), 17);
});

test('Discord snowflakes keep every digit', async () => {
	const { db } = await fresh();
	const a = '123456789012345678';
	const b = '123456789012345679';
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [a]);
	await db.execute('INSERT INTO user (id,count) VALUES (?,0)', [b]);
	const rows = await db.execute('SELECT id FROM user WHERE id = ?', [b]);
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(String(rows[0].id), b);
});

test('interpolated values (the old ${} style) behave like parameters', async () => {
	const { db } = await fresh();
	const id = '987654321098765432';
	await db.execute(`INSERT INTO cowoncy (id,money) VALUES (${id},100)`);
	const rows = await db.execute(`SELECT money FROM cowoncy WHERE id = ${id}`);
	assert.strictEqual(String(rows[0].money), '100');
});

test('an unknown table reports a readable error instead of corrupting data', async () => {
	const { db } = await fresh();
	await assert.rejects(db.execute('SELECT * FROM not_a_table'), /unknown table/i);
});
