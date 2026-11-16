const test = require('node:test');
const assert = require('node:assert');

const {
	freshRequire,
	withEnv,
	adminEnv,
	fakeMessage,
	OWNER_A,
	OWNER_B,
	MOD_CHANNEL,
	ADMIN_ROLE,
	MOD_ROLE,
	HELPER_ROLE,
} = require('./helpers.js');

function loadAuth(env = {}) {
	return withEnv(adminEnv(env), () => {
		freshRequire('../src/utils/config.js');
		return freshRequire('../src/utils/auth.js');
	});
}

test('owner detection only accepts configured, well-formed ids', () => {
	const auth = loadAuth();
	assert.strictEqual(auth.isOwner(OWNER_A), true);
	assert.strictEqual(auth.isOwner(OWNER_B), true);
	assert.strictEqual(auth.isOwner('999999999999999999'), false);
	assert.strictEqual(auth.isOwner('not-an-id'), false);
	assert.strictEqual(auth.isOwner(undefined), false);
});

test('owner-only commands are denied for everyone when no owner is configured', () => {
	const auth = loadAuth({ OWNER_IDS: undefined, OWNER_ID: undefined });
	const decision = auth.canRunAdmin({ owner: true }, fakeMessage({ userId: OWNER_A }));
	assert.deepStrictEqual(decision, { allowed: false, reason: 'not-owner' });
});

test('eval stays disabled unless ALLOW_EVAL is set', () => {
	const auth = loadAuth();
	const evalCommand = { owner: true, alias: ['eval'] };
	const decision = auth.canRunAdmin(evalCommand, fakeMessage({ userId: OWNER_A }));
	assert.strictEqual(decision.allowed, false);
	assert.strictEqual(decision.reason, 'eval-disabled');
});

test('eval is allowed for an owner once ALLOW_EVAL=true', () => {
	const auth = loadAuth({ ALLOW_EVAL: 'true' });
	const decision = auth.canRunAdmin(
		{ owner: true, alias: ['eval'] },
		fakeMessage({ userId: OWNER_A })
	);
	assert.deepStrictEqual(decision, { allowed: true, reason: 'owner' });
	// still not allowed for a random user
	assert.strictEqual(
		auth.canRunAdmin(
			{ owner: true, alias: ['eval'] },
			fakeMessage({ userId: '123456789012345678' })
		).allowed,
		false
	);
});

test('staff commands require both a mod channel and the right role', () => {
	const auth = loadAuth();
	const adminCommand = { admin: true };

	assert.deepStrictEqual(auth.canRunAdmin(adminCommand, fakeMessage({ roles: [ADMIN_ROLE] })), {
		allowed: true,
		reason: 'admin-role',
	});
	// right role, wrong channel
	assert.strictEqual(
		auth.canRunAdmin(
			adminCommand,
			fakeMessage({ channelId: '888888888888888888', roles: [ADMIN_ROLE] })
		).allowed,
		false
	);
	// right channel, wrong role
	assert.strictEqual(
		auth.canRunAdmin(adminCommand, fakeMessage({ userId: '123456789012345678', roles: [] }))
			.allowed,
		false
	);
	assert.deepStrictEqual(auth.canRunAdmin({ manager: true }, fakeMessage({ roles: [MOD_ROLE] })), {
		allowed: true,
		reason: 'manager-role',
	});
	assert.deepStrictEqual(
		auth.canRunAdmin({ helper: true }, fakeMessage({ roles: [HELPER_ROLE] })),
		{ allowed: true, reason: 'helper-role' }
	);
});

test('missing member/roles never grants access', () => {
	const auth = loadAuth();
	const msg = { author: { id: '123456789012345678' }, channel: { id: MOD_CHANNEL } };
	assert.strictEqual(auth.canRunAdmin({ admin: true }, msg).allowed, false);
	assert.strictEqual(auth.canRunAdmin({ owner: true }, msg).allowed, false);
});
