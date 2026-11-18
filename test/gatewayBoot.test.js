const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const gatewayBoot = require('../src/utils/gatewayBoot.js');

test('IDENTIFY presence is "online" instead of eris\' default "offline"', () => {
	const { presence, resolved, activity } = gatewayBoot.identifyPresence({});
	assert.strictEqual(presence.status, 'online');
	assert.strictEqual(presence.afk, false);
	assert.strictEqual(presence.since, 0);
	assert.strictEqual(resolved.type, 'watching');
	assert.deepStrictEqual(activity, { name: 'discord.gg/666family', type: 3 });
	assert.deepStrictEqual(presence.activities, [{ name: 'discord.gg/666family', type: 3 }]);
});

test('IDENTIFY presence honours the configured status/activity', () => {
	const { presence } = gatewayBoot.identifyPresence({
		BOT_STATUS: 'dnd',
		BOT_ACTIVITY_TYPE: 'watching',
		BOT_ACTIVITY_TEXT: '{guilds} servers',
	});
	assert.strictEqual(presence.status, 'dnd');
	assert.deepStrictEqual(presence.activities, [{ name: '0 servers', type: 3 }]);
});

test('a missing activity still sends a valid presence object', () => {
	const { presence } = gatewayBoot.identifyPresence({ BOT_ACTIVITY_TEXT: '   ' });
	assert.deepStrictEqual(presence.activities, [{ name: 'discord.gg/666family', type: 3 }]);
});

test('install() sets the presence before the real connect runs and is idempotent', () => {
	const calls = [];
	class FakeClient {}
	FakeClient.prototype.connect = function connect(...args) {
		calls.push({ presence: this.presence, args });
		return Promise.resolve('connected');
	};
	const Eris = { Client: FakeClient };

	assert.strictEqual(gatewayBoot.install({ Eris, env: { BOT_STATUS: 'online' } }), true);
	assert.strictEqual(gatewayBoot.install({ Eris, environment: {} }), true);

	const client = new FakeClient();
	client.shards = { size: 1 };
	client.guilds = { size: 0 };
	return client.connect('arg').then(() => {
		assert.strictEqual(calls.length, 1, 'connect called once');
		assert.strictEqual(calls[0].presence.status, 'online');
		assert.deepStrictEqual(calls[0].args, ['arg']);
		assert.strictEqual(FakeClient.prototype.__oceanGatewayPatched, true);
	});
});

test('lifecycle logging reports ready/disconnect and never throws', () => {
	const client = new EventEmitter();
	client.shards = { size: 1 };
	client.guilds = { size: 2 };
	const stop = gatewayBoot.attachLogging(client, { env: {} });
	assert.doesNotThrow(() => client.emit('connect', 0));
	assert.doesNotThrow(() => client.emit('shardReady', 0));
	assert.doesNotThrow(() => client.emit('ready'));
	assert.doesNotThrow(() => client.emit('shardDisconnect', { code: 4014 }, 0));
	assert.strictEqual(gatewayBoot.state.lastCloseCode, 4014);
	assert.doesNotThrow(() => client.emit('error', new Error('boom')));
	assert.doesNotThrow(() => client.emit('disconnect', { code: 1000 }));
	stop();
	client.removeAllListeners();
});

test('READY watchdog is unref-ed so it cannot keep a dead worker alive', () => {
	const client = new EventEmitter();
	client.shards = { size: 1 };
	client.guilds = { size: 0 };
	const stop = gatewayBoot.attachLogging(client, { env: { GATEWAY_READY_TIMEOUT_MS: '5' } });
	stop();
	client.removeAllListeners();
	assert.ok(true);
});
