const test = require('node:test');
const assert = require('node:assert');

const { freshRequire, withEnv, adminEnv, OWNER_A, ADMIN_ROLE } = require('./helpers.js');

const GRANT_USER = '888888888888888888';
const STRANGER = '123456789012345678';
const TARGET = '999000000000000001';

function loadAuth(env = {}) {
	return withEnv(adminEnv(env), () => {
		freshRequire('../src/utils/config.js');
		return freshRequire('../src/utils/auth.js');
	});
}

// --- parsing / validation -------------------------------------------------

test('grant parses mentions, raw snowflakes and rejects junk', () => {
	const { parseTargetId } = require('../src/commands/commandList/economy/utils/grantUtils.js');
	assert.strictEqual(parseTargetId(`<@${TARGET}>`), TARGET);
	assert.strictEqual(parseTargetId(`<@!${TARGET}>`), TARGET);
	assert.strictEqual(parseTargetId(TARGET), TARGET);
	assert.strictEqual(parseTargetId('@everyone'), null);
	assert.strictEqual(parseTargetId('123'), null);
	assert.strictEqual(parseTargetId(undefined), null);
});

test('grant amounts must be positive whole numbers', () => {
	const { parseAmount } = require('../src/commands/commandList/economy/utils/grantUtils.js');
	assert.strictEqual(parseAmount('1000'), 1000);
	assert.strictEqual(parseAmount(' 25 '), 25);
	for (const bad of ['0', '-5', '1.5', '1e9', 'abc', '', undefined, null, '0x10']) {
		assert.strictEqual(parseAmount(bad), null, `amount ${bad} must be rejected`);
	}
});

test('grant validation enforces the configured cap', () => {
	const { validateGrant } = require('../src/commands/commandList/economy/utils/grantUtils.js');
	assert.deepStrictEqual(validateGrant(TARGET, 100, 1000), { ok: true, amount: 100 });
	assert.strictEqual(validateGrant(TARGET, 0, 1000).error, 'invalid-amount');
	assert.strictEqual(validateGrant(TARGET, null, 1000).error, 'invalid-amount');
	assert.strictEqual(validateGrant(null, 10, 1000).error, 'invalid-user');
	const tooBig = validateGrant(TARGET, 5000, 1000);
	assert.strictEqual(tooBig.ok, false);
	assert.strictEqual(tooBig.error, 'amount-too-large');
	assert.strictEqual(tooBig.limit, 1000);
	// A missing/!valid cap does not silently allow everything beyond safe ints
	assert.strictEqual(validateGrant(TARGET, 5000, 0).ok, true);
});

// --- authorization --------------------------------------------------------

test('grant is allowed for owners, allowlisted users and allowlisted roles', () => {
	const auth = loadAuth({ COWONCY_ADMIN_IDS: GRANT_USER, COWONCY_ADMIN_ROLE_IDS: ADMIN_ROLE });

	assert.deepStrictEqual(auth.canGrantCowoncy(OWNER_A, { roles: [] }), {
		allowed: true,
		reason: 'owner',
	});
	assert.deepStrictEqual(auth.canGrantCowoncy(GRANT_USER, { roles: [] }), {
		allowed: true,
		reason: 'grant-user',
	});
	assert.deepStrictEqual(auth.canGrantCowoncy(STRANGER, { roles: [ADMIN_ROLE] }), {
		allowed: true,
		reason: 'grant-role',
	});
});

test('grant is denied for everyone else when lists are empty', () => {
	const auth = loadAuth({
		OWNER_IDS: undefined,
		OWNER_ID: undefined,
		COWONCY_ADMIN_IDS: undefined,
		COWONCY_ADMIN_ROLE_IDS: undefined,
	});
	assert.deepStrictEqual(auth.canGrantCowoncy(STRANGER, { roles: [ADMIN_ROLE] }), {
		allowed: false,
		reason: 'not-allowed',
	});
	// invalid member shapes never grant
	assert.strictEqual(auth.canGrantCowoncy(STRANGER, undefined).allowed, false);
	assert.strictEqual(auth.canGrantCowoncy('not-an-id', { roles: [] }).allowed, false);
});

test('grant cap is read from the environment and falls back on junk', () => {
	const cfg = withEnv({ COWONCY_GRANT_MAX: '5000' }, () => freshRequire('../src/utils/config.js'));
	assert.strictEqual(cfg.cowoncyGrantMax, 5000);

	const fallback = withEnv({ COWONCY_GRANT_MAX: 'oops' }, () =>
		freshRequire('../src/utils/config.js')
	);
	assert.strictEqual(fallback.cowoncyGrantMax, 1000000000);
});

// --- command behaviour ----------------------------------------------------

function fakeParams({ userId, roles = [], args, cfg }) {
	const calls = { queries: [], replies: [], errors: [] };
	const params = {
		command: 'grant',
		args,
		msg: {
			author: { id: userId },
			member: { roles },
			channel: { id: '333333333333333333', guild: { id: '777777777777777777' } },
		},
		config: cfg,
		client: { users: { get: (id) => (id === TARGET ? { id, username: 'Target' } : undefined) } },
		global: { toFancyNum: (n) => String(n) },
		getMention: () => undefined,
		getName: () => 'Tester',
		getUniqueName: (u) => (u && u.username) || 'Target',
		query: async (sql, variables) => {
			calls.queries.push({ sql, variables });
			if (/^SELECT money/.test(sql)) return [{ money: 1234 }];
			return [{ affectedRows: 1 }];
		},
		send: async (text) => calls.replies.push(text),
		errorMsg: (text) => calls.errors.push(text),
	};
	params.calls = calls;
	return params;
}

function runGrant(params) {
	const command = require('../src/commands/commandList/economy/grant.js');
	return command.executeCommand.call(params, params);
}

const baseConfig = {
	prefix: 'o',
	emoji: { cowoncy: '💰', blank: '<:blank:1>' },
	cowoncyAdmins: [GRANT_USER],
	cowoncyAdminRoles: [ADMIN_ROLE],
	cowoncyGrantMax: 1000,
};

test('grant denies unauthorized users without touching the database', async () => {
	const params = fakeParams({
		userId: STRANGER,
		args: [`<@${TARGET}>`, '100'],
		cfg: baseConfig,
	});
	await runGrant(params);
	assert.strictEqual(params.calls.queries.length, 0, 'no query for denied users');
	assert.strictEqual(params.calls.replies.length, 0);
	assert.match(params.calls.errors[0], /permission/i);
});

test('grant credits the target with parameterized queries', async () => {
	const params = fakeParams({
		userId: GRANT_USER,
		args: [`<@${TARGET}>`, '250'],
		cfg: baseConfig,
	});
	await runGrant(params);

	const queries = params.calls.queries;
	assert.strictEqual(queries.length, 3, 'user upsert, balance upsert, balance select');
	for (const q of queries) {
		assert.ok(Array.isArray(q.variables), 'every statement is parameterized');
		assert.ok(!q.sql.includes(TARGET), 'ids are never concatenated into SQL');
		assert.ok(!q.sql.includes('250'), 'amounts are never concatenated into SQL');
	}
	assert.deepStrictEqual(queries[1].variables, [TARGET, 250, 250]);
	assert.match(params.calls.replies[0], /250 cowoncy/);
	assert.match(params.calls.replies[0], /1234/);
});

test('grant rejects bad amounts and oversized grants', async () => {
	for (const amount of ['0', '-10', '1.5', 'abc']) {
		const params = fakeParams({
			userId: GRANT_USER,
			args: [`<@${TARGET}>`, amount],
			cfg: baseConfig,
		});
		await runGrant(params);
		assert.strictEqual(params.calls.queries.length, 0, `amount ${amount} must not query`);
		assert.match(params.calls.errors[0], /invalid syntax/i);
	}

	const tooBig = fakeParams({
		userId: GRANT_USER,
		args: [`<@${TARGET}>`, '1001'],
		cfg: baseConfig,
	});
	await runGrant(tooBig);
	assert.strictEqual(tooBig.calls.queries.length, 0);
	assert.match(tooBig.calls.errors[0], /invalid syntax/i);
});

test('grant exposes the documented aliases and economy group', () => {
	const command = require('../src/commands/commandList/economy/grant.js');
	assert.deepStrictEqual(command.alias, ['grant', 'addcash', 'addmoney', 'topup']);
	assert.deepStrictEqual(command.group, ['economy']);
	assert.strictEqual(command.owner, undefined, 'it is a regular command gated at runtime');
});
