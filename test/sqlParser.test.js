/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The bot's ~350 SQL call sites are parsed by `src/utils/mongo/sql/parser.js`
 * before they run against MongoDB. These cases are the real statement shapes
 * taken from the command tree; if one of them stops parsing, a feature breaks.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parse, tokenize } = require('../src/utils/mongo/sql/parser.js');

const SHAPES = [
	'DELETE FROM quest WHERE qid = ? AND qname = ? AND uid = ?;',
	"INSERT INTO lootbox (id,boxcount,claim) VALUES (?,?,'2017-01-01 10:10:10') ON DUPLICATE KEY UPDATE boxcount = boxcount + ?;",
	'UPDATE IGNORE quest SET count = count + ? WHERE qid = ? AND qname = ? AND uid = ?;',
	'SELECT rules.* FROM rules INNER JOIN user ON user.uid = rules.uid WHERE id = ?;',
	'SELECT uw.uwid, uw.wid, uwp.wpid FROM user_weapon uw LEFT JOIN user_weapon_passive uwp ON uw.uwid = uwp.uwid WHERE uid = ? AND avg = ?;',
	'SELECT user.uid,patreonMonths,patreonTimer,TIMESTAMPDIFF(MONTH,patreonTimer,NOW()) AS monthsPassed,patreonType FROM user LEFT JOIN patreons ON user.uid = patreons.uid WHERE id = ?',
	'INSERT IGNORE INTO user (id,count) VALUES (?,0);',
	'INSERT INTO patreons (uid,patreonMonths,patreonType) VALUES (?,?,?) ON DUPLICATE KEY UPDATE patreonType = ?, patreonMonths = ?, patreonTimer = NOW();',
	'INSERT INTO timeout (id,time,count,penalty) VALUES (1,NOW(),1,2),(3,NOW(),1,2) ON DUPLICATE KEY UPDATE time = NOW(), count=count+1, penalty = 3600;',
	'DELETE pta FROM pet_team_animal pta INNER JOIN animal a ON pta.pid = a.pid WHERE a.id = 123; DELETE FROM animal WHERE id = 123;',
	'SELECT (SELECT id FROM user WHERE uid = sender) AS sender,bet,flags,channel FROM user_battle WHERE TIMESTAMPDIFF(MINUTE,time,NOW()) < 10 AND ( user1 = 1 OR user2 = 2 ) AND ( sender != 3 OR user1 = user2 );',
	"UPDATE user_battle SET time = '2018-01-01' WHERE TIMESTAMPDIFF(MINUTE,time,NOW()) < 10 AND ( user1 = (SELECT uid FROM user WHERE id = 1) OR user2 = 2 );",
	'UPDATE user_battle SET user1win = user1win + 1 WHERE user1 = (SELECT uid FROM user WHERE id = 1) AND user2 = (SELECT uid FROM user WHERE id = 2);',
	'INSERT IGNORE INTO battle_settings (uid,level) VALUES ((SELECT uid FROM user WHERE id = 1), 2) ON DUPLICATE KEY UPDATE level = 2;',
	'SELECT boxcount FROM crate INNER JOIN user ON crate.uid = user.uid WHERE id = 1;',
	'UPDATE crate INNER JOIN user ON crate.uid = user.uid SET crate.boxcount = crate.boxcount - 5 WHERE user.id = 1 AND boxcount >= 5;',
	'SELECT u1.id as user1,u2.id as user2 FROM user_battle LEFT JOIN user u1 ON user_battle.user1 = u1.uid LEFT JOIN user u2 ON user_battle.user2 = u2.uid WHERE TIMESTAMPDIFF(MINUTE,time,NOW()) < 10 AND ( u1.id = 1 OR u2.id = 1 );',
	"UPDATE animal SET nickname = ? , offensive = 1 WHERE id = 1 AND name = 'dog'",
	'SELECT COUNT(*) AS count FROM user_pray WHERE sender = 1',
	'SELECT * FROM user_pray WHERE sender = 1 LIMIT 10 OFFSET 20;',
	'SELECT * FROM transaction WHERE sender = 1 ORDER BY tid DESC LIMIT 10 OFFSET 0;',
	'UPDATE IGNORE cowoncy SET money = money + 5 WHERE id IN (1,2)',
	"INSERT INTO user_item (uid, name, count) VALUES (1, 'ticket', 2) ON DUPLICATE KEY update count = count + 2;",
	'SELECT IFNULL((SELECT money FROM cowoncy WHERE id = 1),0) AS m',
	'SELECT name, COUNT(*) FROM animal WHERE id = 1 GROUP BY name HAVING COUNT(*) > 1',
	'SELECT * FROM cowoncy WHERE id = 1 FOR UPDATE',
	'REPLACE INTO animals_rank (id, rank) VALUES (1, 2)',
	'UPDATE user SET cookie = cookie | 4 WHERE id = 1',
	'SELECT SUM(money) AS total, MAX(money) AS best FROM cowoncy',
	'SELECT COUNT(DISTINCT name) AS c FROM animal',
	'SELECT * FROM user WHERE id = 1 AND (cookie & 4) = 0',
	'DELETE FROM user WHERE id = 1 LIMIT 1',
	'SELECT DISTINCT id FROM animal_count',
	'SELECT * FROM `user` WHERE `id` = 1',
	'INSERT INTO `cowoncy` (`id`, `money`) VALUES (1, 2)',
];

test('every statement shape in the command tree parses', () => {
	for (const sql of SHAPES) {
		assert.doesNotThrow(() => parse(sql), `failed to parse: ${sql}`);
	}
});

test('tokenize keeps quotes, backticks and placeholders', () => {
	const tokens = tokenize("SELECT * FROM `user` WHERE name = 'it''s' AND id = ?");
	assert.ok(
		tokens.some((token) => token.type === 'ident' && token.value === 'user' && token.quoted)
	);
	assert.ok(tokens.some((token) => token.type === 'string' && token.value === "it's"));
	assert.ok(tokens.some((token) => token.type === 'param'));
});

test('multi statement strings are split into statements', () => {
	const statements = parse('SELECT 1 FROM user; UPDATE user SET count = 0 WHERE id = 1;');
	assert.strictEqual(statements.length, 2);
	assert.strictEqual(statements[0].type, 'select');
	assert.strictEqual(statements[1].type, 'update');
});

test('table aliases are captured for joins', () => {
	const [statement] = parse(
		'SELECT u.id FROM user u LEFT JOIN pet_team t ON t.uid = u.uid WHERE u.id = 1'
	);
	assert.strictEqual(statement.from.alias, 'u');
	assert.strictEqual(statement.joins[0].kind, 'LEFT');
	assert.strictEqual(statement.joins[0].target.alias, 't');
});

test('ON DUPLICATE KEY UPDATE assignments are attached to the insert', () => {
	const [statement] = parse(
		'INSERT INTO cowoncy (id,money) VALUES (?,?) ON DUPLICATE KEY UPDATE money = money + ?'
	);
	assert.deepStrictEqual(statement.columns, ['id', 'money']);
	assert.strictEqual(statement.onDuplicate.length, 1);
	assert.strictEqual(statement.onDuplicate[0].column, 'money');
});

test('control statements are accepted so transactions do not fail', () => {
	for (const sql of ['START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SET NAMES utf8mb4']) {
		const [statement] = parse(sql);
		assert.strictEqual(statement.type, 'control');
	}
});

test('an unsupported statement fails loudly, never silently', () => {
	assert.throws(() => parse('GRANT ALL ON *.* TO x'), /unsupported statement/);
});
