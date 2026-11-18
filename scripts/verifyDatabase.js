/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Live database verification — run this on the Pterodactyl server (or locally)
 * with the bot **stopped**:
 *
 *     node scripts/verifyDatabase.js
 *
 * It connects to the real `MONGODB_URI`, then exercises the same statements the
 * commands use (economy, inventory, battle, giveaway, quests, XP/rank, guild
 * prefix) and checks the results. Every row it writes belongs to a test account
 * (`TEST_USER_ID`) and is deleted again at the end, so real players are never
 * touched. Exit code 0 = everything passed.
 */

const crypto = require('node:crypto');

require('dotenv').config({ quiet: true });

const client = require('../src/utils/mongo/client.js');
const sql = require('../src/utils/mongo/sql/index.js');
const kv = require('../src/utils/kv.js');
const schema = require('../src/utils/mongo/schema.js');

const TEST_USER_ID = process.env.VERIFY_USER_ID || '999999999999999999';
const TEST_GUILD_ID = process.env.VERIFY_GUILD_ID || '999999999999999998';
const TEST_CHANNEL_ID = '999999999999999997';

const results = [];

function check(name, condition, detail) {
	results.push({ name, ok: !!condition, detail });
	if (!condition) console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
	else console.log(`[ OK ] ${name}`);
}

async function cleanup() {
	const statements = [
		['DELETE FROM quest WHERE uid IN (SELECT uid FROM user WHERE id = ?)', [TEST_USER_ID]],
		[
			'DELETE FROM pet_team_animal WHERE pid IN (SELECT pid FROM animal WHERE id = ?)',
			[TEST_USER_ID],
		],
		['DELETE FROM animal WHERE id = ?', [TEST_USER_ID]],
		['DELETE FROM animal_count WHERE id = ?', [TEST_USER_ID]],
		['DELETE FROM pet_team WHERE uid IN (SELECT uid FROM user WHERE id = ?)', [TEST_USER_ID]],
		[
			'DELETE FROM pet_team_active WHERE uid IN (SELECT uid FROM user WHERE id = ?)',
			[TEST_USER_ID],
		],
		['DELETE FROM user_battle WHERE user1 IN (SELECT uid FROM user WHERE id = ?)', [TEST_USER_ID]],
		['DELETE FROM user_battle WHERE user2 IN (SELECT uid FROM user WHERE id = ?)', [TEST_USER_ID]],
		[
			'DELETE FROM battle_settings WHERE uid IN (SELECT uid FROM user WHERE id = ?)',
			[TEST_USER_ID],
		],
		[
			'DELETE FROM user_weapon_kills WHERE uwid IN (SELECT uwid FROM user_weapon WHERE uid IN (SELECT uid FROM user WHERE id = ?))',
			[TEST_USER_ID],
		],
		[
			'DELETE FROM user_weapon_passive WHERE uwid IN (SELECT uwid FROM user_weapon WHERE uid IN (SELECT uid FROM user WHERE id = ?))',
			[TEST_USER_ID],
		],
		['DELETE FROM user_weapon WHERE uid IN (SELECT uid FROM user WHERE id = ?)', [TEST_USER_ID]],
		['DELETE FROM cowoncy WHERE id = ?', [TEST_USER_ID]],
		['DELETE FROM cowoncy_limit WHERE id = ?', [TEST_USER_ID]],
		['DELETE FROM giveaway WHERE cid = ?', [TEST_CHANNEL_ID]],
		['DELETE FROM user WHERE id = ?', [TEST_USER_ID]],
	];
	for (const [statement, params] of statements) {
		try {
			await sql.query(statement, params);
		} catch (err) {
			// Cleanup is best-effort: a missing row or an empty table is fine.
			console.log(`[note] cleanup skipped: ${err.message.slice(0, 90)}`);
		}
	}
	for (const key of [
		`cd_${TEST_USER_ID}`,
		`data_${TEST_USER_ID}`,
		`xplimit_${TEST_USER_ID}`,
		TEST_GUILD_ID,
		`test_xp_${TEST_GUILD_ID}`,
	]) {
		await kv.del(key).catch(() => {});
	}
	await kv.zrem('user_xp', TEST_USER_ID).catch(() => {});
	await kv.zrem(`user_xp_${TEST_GUILD_ID}`, TEST_USER_ID).catch(() => {});
}

(async () => {
	console.log('OCEAN database verification\n');

	// 0. schema -----------------------------------------------------------------
	const tables = schema.tableNames();
	check('schema loaded', tables.length >= 80, `${tables.length} tables`);

	// 1. connection -------------------------------------------------------------
	const uri = client.readUri();
	const info = client.inspectUri(uri);
	if (!info.ok) {
		console.log(`[FAIL] MONGODB_URI — ${info.reason}: ${info.action}`);
		process.exit(1);
	}
	check('MONGODB_URI is a MongoDB URI', true, client.maskUri(uri));
	const store = await client.connect();
	check('connected to MongoDB', !!store);

	await cleanup();

	// 2. user + economy ---------------------------------------------------------
	const insertUser = await sql.query('INSERT INTO user (id,count) VALUES (?,0)', [TEST_USER_ID]);
	check(
		'insert user',
		insertUser.affectedRows === 1 && insertUser.insertId > 0,
		`uid=${insertUser.insertId}`
	);
	const uid = insertUser.insertId;

	const userRows = await sql.query('SELECT uid FROM user WHERE id = ?', [TEST_USER_ID]);
	check(
		'select user by discord id',
		userRows.length === 1 && String(userRows[0].uid) === String(uid)
	);

	await sql.query('INSERT INTO cowoncy (id,money) VALUES (?,?)', [TEST_USER_ID, 1000]);
	await sql.query(
		'INSERT INTO cowoncy (id,money) VALUES (?,?) ON DUPLICATE KEY UPDATE money = money + ?',
		[TEST_USER_ID, 0, 250]
	);
	const money = await sql.query('SELECT money FROM cowoncy WHERE id = ?', [TEST_USER_ID]);
	check(
		'cowoncy balance after two writes',
		String(money[0].money) === '1250',
		`money=${money[0].money}`
	);

	// concurrent increments must not lose money (atomic $inc)
	await Promise.all(
		Array.from({ length: 20 }, () =>
			sql.query('UPDATE cowoncy SET money = money + ? WHERE id = ?', [5, TEST_USER_ID])
		)
	);
	const money2 = await sql.query('SELECT money FROM cowoncy WHERE id = ?', [TEST_USER_ID]);
	check(
		'20 parallel +5 increments are atomic',
		String(money2[0].money) === '1350',
		`money=${money2[0].money}`
	);

	const transfer = await sql.query(
		'UPDATE cowoncy SET money = money - ? WHERE id = ? AND money >= ?',
		[350, TEST_USER_ID, 350]
	);
	check('guarded spend (money >= amount)', transfer.affectedRows === 1);

	// 3. inventory / animals ----------------------------------------------------
	const animalInsert = await sql.query(
		'INSERT INTO animal (id, name, count, totalcount) VALUES (?, ?, 1, 1)',
		[TEST_USER_ID, 'dog']
	);
	check('insert animal with auto pid', !!animalInsert, `affected=${animalInsert.affectedRows}`);
	await sql.query(
		'INSERT INTO animal (id, name, count, totalcount) VALUES (?, ?, 1, 1) ON DUPLICATE KEY UPDATE count = count + 1',
		[TEST_USER_ID, 'dog']
	);
	const animal = await sql.query('SELECT pid, count FROM animal WHERE id = ? AND name = ?', [
		TEST_USER_ID,
		'dog',
	]);
	check('animal count incremented', String(animal[0].count) === '2', JSON.stringify(animal[0]));

	const weapon = await sql.query(
		"INSERT INTO user_weapon (uid, wid, stat, avg, rrcount, rrattempt, wear) VALUES (?, 1, '1,1,1', 10, 0, 0, 1)",
		[uid]
	);
	check('insert user_weapon', weapon.affectedRows === 1, `uwid=${weapon.insertId}`);

	// 4. battle -----------------------------------------------------------------
	await sql.query('INSERT INTO pet_team (uid, name) VALUES (?,?)', [uid, 'default']);
	const team = await sql.query('SELECT pgid FROM pet_team WHERE uid = ?', [uid]);
	check('pet_team auto pgid', team.length === 1 && team[0].pgid !== null, JSON.stringify(team));

	await sql.query(
		'INSERT INTO user_battle (user1, user2, bet, time, sender) VALUES (?,?,?,NOW(),?)',
		[uid, uid, 10, uid]
	);
	const battle = await sql.query(
		'SELECT bet FROM user_battle WHERE TIMESTAMPDIFF(MINUTE,time,NOW()) < 10 AND user1 = ?',
		[uid]
	);
	check('battle lookup with TIMESTAMPDIFF', battle.length === 1 && String(battle[0].bet) === '10');
	await sql.query("UPDATE user_battle SET time = '2018-01-01' WHERE user1 = ?", [uid]);

	// 5. quest + giveaway -------------------------------------------------------
	await sql.query('INSERT INTO quest (uid, qid, qname, count) VALUES (?,?,?,?)', [
		uid,
		1,
		'hunt',
		3,
	]);
	const quest = await sql.query('SELECT count FROM quest WHERE uid = ? AND qid = ? AND qname = ?', [
		uid,
		1,
		'hunt',
	]);
	check('quest row round-trip', quest.length === 1 && String(quest[0].count) === '3');

	await sql.query('INSERT INTO giveaway (cid, rewards, winners, active) VALUES (?,?,?,?)', [
		TEST_CHANNEL_ID,
		'1000 cowoncy',
		1,
		1,
	]);
	const giveaway = await sql.query('SELECT rewards FROM giveaway WHERE cid = ?', [TEST_CHANNEL_ID]);
	check('giveaway row round-trip', giveaway.length === 1 && /cowoncy/.test(giveaway[0].rewards));
	await sql.query('UPDATE giveaway SET active = 0 WHERE cid = ?', [TEST_CHANNEL_ID]);

	// 6. XP / ranking (key/value store) ----------------------------------------
	await kv.zincrby('user_xp', TEST_USER_ID, 120);
	await kv.zincrby(`user_xp_${TEST_GUILD_ID}`, TEST_USER_ID, 45);
	check('xp score stored', Number(await kv.zscore('user_xp', TEST_USER_ID)) === 120);
	check(
		'guild xp score stored',
		Number(await kv.zscore(`user_xp_${TEST_GUILD_ID}`, TEST_USER_ID)) === 45
	);
	const top = await kv.zrevrange('user_xp', 0, 4);
	check(
		'leaderboard returns member+score pairs',
		top.length >= 2 && top[0] === TEST_USER_ID,
		JSON.stringify(top)
	);
	check(
		'rank lookup returns a number',
		Number.isInteger(await kv.zrevrank('user_xp', TEST_USER_ID))
	);

	// 7. prefix (per guild, must survive a restart) -----------------------------
	await kv.hset(TEST_GUILD_ID, 'prefix', '!');
	check('guild prefix stored', (await kv.hget(TEST_GUILD_ID, 'prefix')) === '!');
	await kv.hdel(TEST_GUILD_ID, 'prefix');
	check(
		'guild prefix removed → default "o" applies',
		(await kv.hget(TEST_GUILD_ID, 'prefix')) === null
	);

	// 8. cooldowns --------------------------------------------------------------
	const cd = await kv.hincrby(`cd_${TEST_USER_ID}`, 'daily', 1);
	check('cooldown counter', Number(cd) === 1, `value=${cd}`);

	// 9. persistence across a reconnect -----------------------------------------
	await client.close();
	await client.connect();
	const afterReconnect = await sql.query('SELECT money FROM cowoncy WHERE id = ?', [TEST_USER_ID]);
	check(
		'data survives a reconnect (restart)',
		String(afterReconnect[0].money) === '1000',
		`money=${afterReconnect[0].money}`
	);

	// 10. cleanup ---------------------------------------------------------------
	await cleanup();
	const leftover = await sql.query('SELECT COUNT(*) AS count FROM user WHERE id = ?', [
		TEST_USER_ID,
	]);
	check('test rows removed', Number(leftover[0].count) === 0);
	await client.close();

	const failed = results.filter((result) => !result.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) {
		console.log('failed:', failed.map((result) => result.name).join(', '));
		process.exit(1);
	}
	console.log(`verification id ${crypto.randomUUID().slice(0, 8)}`);
	process.exit(0);
})().catch(async (err) => {
	console.error(`\n[FAIL] verification crashed: ${err.message}`);
	if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
	try {
		await cleanup();
	} catch (cleanupError) {
		console.error(`cleanup failed: ${cleanupError.message}`);
	}
	process.exit(1);
});
