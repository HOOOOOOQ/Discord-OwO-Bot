const test = require('node:test');
const assert = require('node:assert');

const doctor = require('../src/utils/doctor.js');

const HEALTHY_ENV = {
	BOT_TOKEN: 'Bot abcdefghijklmnop.qrstu',
	DATABASE_URL: 'mysql://owo:secret@127.0.0.1:3306/owo',
	REDIS_URL: 'redis://:secret@127.0.0.1:6379/0',
	CLUSTERS: '2',
};

function fakeApi({ contentAllowed = true, tokenValid = true } = {}) {
	return {
		getCurrentUser: async () =>
			tokenValid
				? { ok: true, status: 200, data: { id: '1', username: 'Ocean', discriminator: '5352' } }
				: { ok: false, status: 401, error: '401: Unauthorized' },
		getApplication: async () =>
			tokenValid
				? {
						ok: true,
						status: 200,
						data: { id: '2', name: 'Ocean', flags: contentAllowed ? 1 << 19 : 0 },
				  }
				: { ok: false, status: 401, error: '401: Unauthorized' },
		getBotGateway: async () =>
			tokenValid
				? {
						ok: true,
						status: 200,
						data: {
							shards: 1,
							session_start_limit: { total: 1000, remaining: 998, reset_after: 86400000 },
						},
				  }
				: { ok: false, status: 401, error: '401: Unauthorized' },
		formatUser: (user) => `${user.username}#${user.discriminator} (id ${user.id})`,
		messageContentIntentAllowed: (flags) => (Number(flags) & ((1 << 19) | (1 << 20))) !== 0,
	};
}

const reachable = async () => ({ ok: true });

async function collect(env, apiOptions = {}, probe = reachable) {
	return doctor.collect({ env: { ...HEALTHY_ENV, ...env }, api: fakeApi(apiOptions), probe });
}

function failures(checks) {
	return checks.filter((check) => check.level === 'FAIL');
}

test('maskToken hides everything but the last four characters', () => {
	const masked = doctor.maskToken('Bot abcdefghijklmnop');
	assert.ok(!masked.includes('abcdefghij'));
	assert.equal(masked.slice(-4), 'mnop');
	assert.strictEqual(doctor.maskToken(''), '(empty)');
});

test('a healthy deployment has no failing checks', async () => {
	const checks = await collect({});
	assert.deepStrictEqual(failures(checks), []);
	const rendered = doctor.format(checks).text;
	assert.match(rendered, /MESSAGE CONTENT INTENT — enabled/);
	assert.match(rendered, /database reachable/);
});

test('a disabled message content intent is the loud failure', async () => {
	const checks = await collect({}, { contentAllowed: false });
	const fail = failures(checks);
	assert.strictEqual(fail.length, 1);
	assert.match(fail[0].title, /MESSAGE CONTENT INTENT/);
	assert.match(fail[0].detail, /ignores every command/i);
});

test('an invalid token is reported as such', async () => {
	const checks = await collect({}, { tokenValid: false });
	const fail = failures(checks);
	assert.ok(fail.some((check) => /token rejected/i.test(check.title)));
});

test('DEBUG without a whitelist would ignore every guild', async () => {
	const checks = await collect({ DEBUG: 'true' });
	assert.ok(failures(checks).some((check) => /DEBUG_WHITELIST/.test(check.title)));
});

test('missing storage configuration fails', async () => {
	const checks = await collect({ DATABASE_URL: '', REDIS_URL: '' });
	const fail = failures(checks);
	assert.strictEqual(fail.length, 2);
	assert.ok(fail.some((check) => /database/.test(check.title)));
	assert.ok(fail.some((check) => /redis/.test(check.title)));
});

test('an unreachable database is a warning, not a failure', async () => {
	const checks = await collect({}, {}, async () => ({ ok: false, error: 'ECONNREFUSED' }));
	assert.deepStrictEqual(failures(checks), []);
	assert.ok(checks.some((check) => check.level === 'warn' && /database/.test(check.title)));
});

test('the report ends with a summary line', async () => {
	const checks = await collect({});
	const { text } = doctor.format(checks);
	assert.match(text, /\d+ checks, 0 failed, \d+ warning\(s\)/);
});
