const test = require('node:test');
const assert = require('node:assert');

const presence = require('../src/utils/presence.js');

function fakeClient() {
	const calls = [];
	return {
		calls,
		editStatus(status, activities) {
			calls.push({ status, activities });
		},
	};
}

test('defaults are online + watching the support server', () => {
	const resolved = presence.resolve({});
	assert.strictEqual(resolved.status, 'online');
	assert.strictEqual(resolved.type, 'watching');
	assert.strictEqual(resolved.text, 'discord.gg/666family');
	assert.strictEqual(resolved.refreshMs, 0);
	assert.deepStrictEqual(resolved.warnings, []);
});

test('an unknown status falls back to online and warns', () => {
	const resolved = presence.resolve({ BOT_STATUS: 'away' });
	assert.strictEqual(resolved.status, 'online');
	assert.match(resolved.warnings.join(' '), /BOT_STATUS=away/);
});

test('every activity type maps to its discord id', () => {
	assert.strictEqual(presence.resolve({ BOT_ACTIVITY_TYPE: 'playing' }).typeId, 0);
	assert.strictEqual(presence.resolve({ BOT_ACTIVITY_TYPE: 'listening' }).typeId, 2);
	assert.strictEqual(presence.resolve({ BOT_ACTIVITY_TYPE: 'watching' }).typeId, 3);
	assert.strictEqual(presence.resolve({ BOT_ACTIVITY_TYPE: 'custom' }).typeId, 4);
	assert.strictEqual(presence.resolve({ BOT_ACTIVITY_TYPE: 'competing' }).typeId, 5);
});

test('streaming without a url degrades to playing', () => {
	const resolved = presence.resolve({ BOT_ACTIVITY_TYPE: 'streaming' });
	assert.strictEqual(resolved.type, 'playing');
	assert.strictEqual(resolved.url, null);
	assert.match(resolved.warnings.join(' '), /needs BOT_ACTIVITY_URL/);

	const withUrl = presence.resolve({
		BOT_ACTIVITY_TYPE: 'streaming',
		BOT_ACTIVITY_URL: 'https://twitch.tv/ocean',
	});
	assert.strictEqual(withUrl.type, 'streaming');
	assert.strictEqual(withUrl.url, 'https://twitch.tv/ocean');
	assert.strictEqual(withUrl.typeId, 1);
});

test('templates are rendered with live counts', () => {
	const text = presence.renderTemplate(
		'o help | {guilds} servers, {users} users, {shards}/{prefix}',
		{
			guilds: 12,
			users: 345,
			shards: 1,
			prefix: 'o',
		}
	);
	assert.strictEqual(text, 'o help | 12 servers, 345 users, 1/o');
});

test('custom status uses the state field', () => {
	const activity = presence.buildActivity(
		presence.resolve({ BOT_ACTIVITY_TYPE: 'custom', BOT_ACTIVITY_TEXT: 'o help' })
	);
	assert.deepStrictEqual(activity, { type: 4, name: 'Custom Status', state: 'o help' });
});

test('apply pushes status and a single activity to the client', () => {
	const client = fakeClient();
	const applied = presence.apply(client, {
		env: { BOT_ACTIVITY_TYPE: 'watching', BOT_ACTIVITY_TEXT: 'o help | {guilds} servers' },
		counts: { guilds: 3 },
	});
	assert.strictEqual(applied.status, 'online');
	assert.strictEqual(client.calls.length, 1);
	assert.strictEqual(client.calls[0].status, 'online');
	assert.deepStrictEqual(client.calls[0].activities, [{ name: 'o help | 3 servers', type: 3 }]);
	assert.match(presence.describe(applied.activity), /watching "o help \| 3 servers"/);
});

test('a client that refuses editStatus does not throw', () => {
	const client = {
		editStatus() {
			throw new Error('not connected');
		},
	};
	const applied = presence.apply(client, { env: {} });
	assert.strictEqual(applied.activity, null);
});

test('refresh interval is disabled unless configured', () => {
	const stop = presence.startRefresh({ bot: fakeClient(), prefix: 'o' }, { env: {} });
	assert.strictEqual(typeof stop, 'function');
	stop();
});

test('refresh keeps the presence updated', async () => {
	const client = fakeClient();
	const main = {
		prefix: 'o',
		bot: {
			guilds: { size: 5 },
			users: { size: 50 },
			shards: { size: 1 },
			editStatus: client.editStatus.bind(client),
		},
	};
	const stop = presence.startRefresh(main, {
		env: { BOT_PRESENCE_REFRESH_SEC: '1', BOT_ACTIVITY_TEXT: '{guilds} servers' },
	});
	// BOT_PRESENCE_REFRESH_SEC only accepts whole seconds.
	await new Promise((resolve) => setTimeout(resolve, 1100));
	stop();
	assert.ok(client.calls.length >= 1);
	// default activity type is now "watching" (3)
	assert.deepStrictEqual(client.calls[0].activities, [{ name: '5 servers', type: 3 }]);
});
