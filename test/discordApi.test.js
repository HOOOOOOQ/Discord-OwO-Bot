const test = require('node:test');
const assert = require('node:assert');

const discordApi = require('../src/utils/discordApi.js');

function fakeFetch(response) {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		const { status = 200, body = {} } =
			typeof response === 'function' ? response(url, options) : response;
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetchImpl, calls };
}

test('normalizeToken prefixes the Bot scheme exactly once', () => {
	assert.strictEqual(discordApi.normalizeToken('abc'), 'Bot abc');
	assert.strictEqual(discordApi.normalizeToken('Bot abc'), 'Bot abc');
	assert.strictEqual(discordApi.normalizeToken('  Bot   abc '), 'Bot abc');
	assert.strictEqual(discordApi.normalizeToken(''), 'Bot ');
});

test('messageContentIntentAllowed understands both flag variants', () => {
	assert.strictEqual(discordApi.messageContentIntentAllowed(0), false);
	assert.strictEqual(discordApi.messageContentIntentAllowed(1 << 19), true);
	assert.strictEqual(discordApi.messageContentIntentAllowed(1 << 20), true);
	assert.strictEqual(discordApi.messageContentIntentAllowed((1 << 19) | (1 << 15)), true);
	assert.strictEqual(
		discordApi.messageContentIntentAllowed(1 << 15),
		false,
		'guildMembers flag is not content'
	);
	assert.strictEqual(discordApi.messageContentIntentAllowed(undefined), false);
});

test('apiGet sends the bot token and parses json', async () => {
	const { fetchImpl, calls } = fakeFetch({ body: { id: '1', username: 'Ocean' } });
	const result = await discordApi.getCurrentUser('token', { fetchImpl });
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.data.username, 'Ocean');
	assert.match(calls[0].url, /\/users\/@me$/);
	assert.strictEqual(calls[0].options.headers.authorization, 'Bot token');
});

test('a 401 is reported, never thrown', async () => {
	const { fetchImpl } = fakeFetch({ status: 401, body: { message: '401: Unauthorized', code: 0 } });
	const result = await discordApi.getApplication('bad', { fetchImpl });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.status, 401);
	assert.match(result.error, /Unauthorized/);
});

test('network failures are reported, never thrown', async () => {
	const fetchImpl = async () => {
		throw new Error('getaddrinfo ENOTFOUND discord.com');
	};
	const result = await discordApi.getBotGateway('token', { fetchImpl });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.status, 0);
	assert.match(result.error, /ENOTFOUND/);
});

test('invalid json bodies do not throw', async () => {
	const { fetchImpl } = fakeFetch({ body: 'not json at all' });
	const result = await discordApi.getCurrentUser('token', { fetchImpl });
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.data, null);
});

test('formatUser hides the "#0" discriminator', () => {
	assert.strictEqual(
		discordApi.formatUser({ id: '1', username: 'Ocean', discriminator: '0' }),
		'Ocean (id 1)'
	);
	assert.strictEqual(
		discordApi.formatUser({ id: '2', username: 'Ocean', discriminator: '5352' }),
		'Ocean#5352 (id 2)'
	);
	assert.strictEqual(discordApi.formatUser(null), 'unknown');
});
