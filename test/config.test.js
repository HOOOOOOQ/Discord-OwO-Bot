const test = require('node:test');
const assert = require('node:assert');

const {
	freshRequire,
	withEnv,
	OWNER_A,
	OWNER_B,
	MOD_CHANNEL,
	ADMIN_ROLE,
} = require('./helpers.js');

function loadConfig(env) {
	return withEnv(env, () => freshRequire('../src/utils/config.js'));
}

test('committed defaults grant no privileges and disable debug/eval', () => {
	// The committed config.json must never contain a personal owner id
	const raw = require('../src/data/config.json');
	assert.deepStrictEqual(raw.owners, []);
	assert.strictEqual(raw.owner, '');
	assert.deepStrictEqual(raw.role, { admin: [], manager: [], helper: [] });
	assert.deepStrictEqual(raw.modChannels, []);
	assert.strictEqual(raw.debug, false);
	assert.strictEqual(raw.evalEnabled, false);
});

test('OWNER_IDS is parsed, trimmed, de-duplicated and validated', () => {
	const config = loadConfig({
		OWNER_IDS: `${OWNER_A}, ${OWNER_B},${OWNER_A},not-an-id,123`,
	});
	assert.deepStrictEqual(config.owners, [OWNER_A, OWNER_B]);
	assert.strictEqual(config.owner, OWNER_A);
});

test('OWNER_ID (legacy single id) is still supported', () => {
	const config = loadConfig({ OWNER_IDS: undefined, OWNER_ID: OWNER_A });
	assert.deepStrictEqual(config.owners, [OWNER_A]);
});

test('empty owner configuration grants nobody access', () => {
	const config = loadConfig({ OWNER_IDS: undefined, OWNER_ID: undefined });
	assert.deepStrictEqual(config.owners, []);
	assert.strictEqual(config.owner, '');
	assert.strictEqual(config.validate(), false);
});

test('role and mod channel ids come from the environment', () => {
	const config = loadConfig({ ADMIN_ROLE_IDS: ADMIN_ROLE, MOD_CHANNEL_IDS: MOD_CHANNEL });
	assert.deepStrictEqual(config.role.admin, [ADMIN_ROLE]);
	assert.deepStrictEqual(config.modChannels, [MOD_CHANNEL]);
});

test('DEBUG and ALLOW_EVAL are opt-in, invalid booleans fall back', () => {
	assert.strictEqual(loadConfig({ DEBUG: 'true' }).debug, true);
	assert.strictEqual(loadConfig({ DEBUG: 'maybe' }).debug, false);
	assert.strictEqual(loadConfig({ ALLOW_EVAL: '1' }).evalEnabled, true);
	assert.strictEqual(loadConfig({ ALLOW_EVAL: undefined }).evalEnabled, false);
});

test('CLUSTERS override is bounded, invalid values fall back to 60', () => {
	assert.strictEqual(loadConfig({ CLUSTERS: '8' }).clusters, 8);
	assert.strictEqual(loadConfig({ CLUSTERS: '9999' }).clusters, 60);
	assert.strictEqual(loadConfig({ CLUSTERS: 'abc' }).clusters, 60);
});

test('prefix override is normalised to lowercase', () => {
	assert.strictEqual(loadConfig({ PREFIX: 'OWO' }).prefix, 'owo');
});
