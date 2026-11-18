/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The IDENTIFY payload, without Discord.
 *
 * This is the part of "is the bot online?" that can be proven offline: eris
 * builds the IDENTIFY frame from the client options, and Discord shows a bot as
 * online only when that frame carries `presence.status = "online"`. Here eris
 * talks to a fake WebSocket (HELLO → IDENTIFY → READY), so the test asserts the
 * real frame eris would send:
 *
 *   - the token has exactly one "Bot " prefix (a doubled prefix is the classic
 *     4004 Authentication failed),
 *   - the intent bitmask contains MESSAGE_CONTENT (otherwise no command is read),
 *   - the presence is `online` with `Watching discord.gg/666family`,
 *   - the shard tuple matches the requested range.
 *
 * What it cannot prove: that Discord accepted the frame (needs a real token and
 * network). That stays marked BELUM TERVERIFIKASI in LAPORAN-PENGUJIAN.md.
 */

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

function fakeGateway() {
	const sockets = [];
	class FakeWS extends EventEmitter {
		constructor(url, options) {
			super();
			this.url = url;
			this.options = options;
			this.readyState = 0;
			this.sent = [];
			sockets.push(this);
			setImmediate(() => {
				this.readyState = 1;
				this.emit('open');
				this.emit(
					'message',
					Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }))
				);
			});
		}
		send(data) {
			this.sent.push(String(data));
			const packet = JSON.parse(String(data));
			if (packet.op === 2) {
				setImmediate(() =>
					this.emit(
						'message',
						Buffer.from(
							JSON.stringify({
								op: 0,
								s: 1,
								t: 'READY',
								d: {
									v: 9,
									user: {
										id: '111111111111111111',
										username: 'OCEAN',
										discriminator: '5352',
										bot: true,
										avatar: null,
									},
									guilds: [],
									session_id: 'session-1',
									shard: [0, 1],
									application: { id: '111111111111111111', flags: 0 },
									private_channels: [],
									relationships: [],
									user_settings: {},
								},
							})
						)
					)
				);
			}
		}
		close() {
			this.readyState = 3;
			this.emit('close', 1000, 'normal');
		}
		terminate() {
			this.readyState = 3;
		}
	}
	FakeWS.CONNECTING = 0;
	FakeWS.OPEN = 1;
	FakeWS.CLOSING = 2;
	FakeWS.CLOSED = 3;
	const resolved = require.resolve('ws');
	require.cache[resolved] = {
		id: resolved,
		filename: resolved,
		loaded: true,
		exports: FakeWS,
		children: [],
		paths: [],
	};
	return { FakeWS, sockets };
}

const gateway = fakeGateway();
const gatewayBoot = require('../src/utils/gatewayBoot.js');
const presence = require('../src/utils/presence.js');
const { resolveIntents } = require('../src/utils/intents.js');
const Eris = require('eris');

let exitCode = null;
// the real patch the bot installs at boot; `exit` is injected so a fatal
// connect failure ends the test instead of the test runner process
gatewayBoot.install({ exit: (code) => (exitCode = code) });

function connectWith({ token, intents, presenceConfig, maxShards = 1, fastReconnect = false }) {
	const client = new Eris(token, {
		intents,
		maxShards,
		firstShardID: 0,
		lastShardID: maxShards - 1,
		shardConcurrency: 1,
		restMode: true,
		messageLimit: 0,
		presence: presenceConfig,
		// keep the retry path fast in tests (the real default is 20 s+)
		reconnectDelay: fastReconnect ? () => 5 : undefined,
	});
	// No REST in this test: every request is answered locally.
	client.requestHandler = {
		request: async (method, url) => {
			if (String(url).includes('/gateway')) {
				return {
					url: 'wss://gateway.test/',
					shards: maxShards,
					session_start_limit: { max_concurrency: 1 },
				};
			}
			throw new Error(`unexpected REST call ${method} ${url}`);
		},
	};
	return client;
}

/**
 * Closes the fake client and drops the timers eris leaves behind when a socket
 * is torn down (its connect/guild-create timeouts are not cleared by
 * `disconnect({reconnect:false})` when the fake socket closes synchronously).
 */
function shutdown(client) {
	try {
		client.disconnect({ reconnect: false });
	} catch (err) {
		/* already gone */
	}
	try {
		client.shards.forEach((shard) => {
			clearTimeout(shard.connectTimeout);
			clearTimeout(shard.guildCreateTimeout);
			if (shard.heartbeatInterval) clearInterval(shard.heartbeatInterval);
			shard.heartbeatInterval = null;
		});
	} catch (err) {
		/* nothing to clear */
	}
}

function identifyFrame() {
	const socket = gateway.sockets[gateway.sockets.length - 1];
	const frame = socket.sent.map((raw) => JSON.parse(raw)).find((packet) => packet.op === 2);
	return { socket, frame };
}

test('IDENTIFY carries one Bot prefix, messageContent and an online watching presence', async () => {
	const intents = resolveIntents({
		env: { ERIS_MESSAGE_CONTENT: 'auto' },
		messageContentAllowed: true,
	});
	const resolvedPresence = presence.resolve({});
	const client = connectWith({
		token: 'Bot MTEx.TEST.TOKEN',
		intents: intents.value,
		presenceConfig: resolvedPresence.presence,
	});
	const ready = new Promise((resolve) => client.once('ready', resolve));
	await client.connect();
	await ready;

	const { socket, frame } = identifyFrame();
	assert.ok(socket, 'a WebSocket was created');
	assert.match(socket.url, /^wss:\/\//);
	assert.ok(frame, 'eris sent IDENTIFY');
	assert.strictEqual(
		(frame.d.token.match(/^Bot /g) || []).length,
		1,
		'exactly one "Bot " prefix — two is 4004 Authentication failed'
	);
	assert.ok(
		(frame.d.intents & 32768) === 32768,
		'MESSAGE_CONTENT bit must be requested, otherwise every command is invisible'
	);
	assert.strictEqual(
		frame.d.presence.status,
		'online',
		'eris defaults to "offline" without the patch'
	);
	assert.deepStrictEqual(frame.d.presence.activities, [{ name: 'discord.gg/666family', type: 3 }]);
	// eris only includes the tuple when more than one shard is configured; a
	// single-shard deployment (the default here) legitimately omits it.
	assert.ok(
		frame.d.shard === undefined || (Array.isArray(frame.d.shard) && frame.d.shard[0] === 0),
		`unexpected shard tuple ${JSON.stringify(frame.d.shard)}`
	);
});

test('a token pasted with the "Bot " prefix is not doubled by the bot', () => {
	const tokenUtil = require('../src/utils/token.js');
	assert.strictEqual(tokenUtil.botAuth('Bot   MTEx.TEST '), 'Bot MTEx.TEST');
	assert.strictEqual(tokenUtil.botAuth('"MTEx.TEST"'), 'Bot MTEx.TEST');
	assert.strictEqual(tokenUtil.botAuth('Bot Bot MTEx'), 'Bot MTEx');
});

test('a failing gateway discovery is reported instead of swallowed', async (t) => {
	const intents = resolveIntents({
		env: { ERIS_MESSAGE_CONTENT: 'auto' },
		messageContentAllowed: true,
	});
	const client = connectWith({
		token: 'Bot x',
		intents: intents.value,
		presenceConfig: null,
	});
	t.after(() => shutdown(client));
	let calls = 0;
	// The real failure path: the REST layer rejects (this is what a 401 looks
	// like through eris-sharder's SyncedRequestHandler). autoreconnect=false so
	// eris surfaces the error instead of hiding it behind its retry loop.
	client.options.autoreconnect = false;
	client.requestHandler = {
		request: async () => {
			calls++;
			const err = new Error('401 Unauthorized');
			err.status = 401;
			throw err;
		},
	};
	gatewayBoot.state.lastRestError = null;
	// clients from earlier tests must not trip the duplicate-connection guard
	gatewayBoot.state.activeClient = null;
	gatewayBoot.state.activeRange = null;
	await assert.rejects(client.connect(), /401/);
	assert.ok(calls >= 1, 'the REST discovery was attempted');
	assert.match(
		String(gatewayBoot.state.lastRestError),
		/401/,
		'the real REST error is recorded, not swallowed by eris'
	);
});

test('the silent connect retry loop is counted and capped', async (t) => {
	const intents = resolveIntents({
		env: { ERIS_MESSAGE_CONTENT: 'auto' },
		messageContentAllowed: true,
	});
	const client = connectWith({
		token: 'Bot x',
		intents: intents.value,
		presenceConfig: null,
		fastReconnect: true,
	});
	t.after(() => {
		client.connect = async () => {};
		shutdown(client);
	});
	client.requestHandler = {
		request: async () => {
			const err = new Error('401 Unauthorized');
			err.status = 401;
			throw err;
		},
	};
	process.env.GATEWAY_CONNECT_ATTEMPTS = '2';
	gatewayBoot.state.connectFailures = 0;
	gatewayBoot.state.fatalConnectFailure = false;
	exitCode = null;
	gatewayBoot.state.activeClient = null;
	gatewayBoot.state.activeRange = null;
	try {
		// first attempt: patches connect, logs the REST error and counts retry #1
		client.connect().catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 50));
		// stop eris recursing so the test stays deterministic
		client.connect = async () => {};
		const retry = client.options.reconnectDelay;
		assert.strictEqual(typeof retry, 'function', 'the retry hook was installed');
		retry(0, 2); // second failed attempt reaches the cap
		await new Promise((resolve) => setTimeout(resolve, 100));
	} finally {
		delete process.env.GATEWAY_CONNECT_ATTEMPTS;
	}

	assert.ok(
		gatewayBoot.state.connectFailures >= 2,
		`the silent retries are counted (${gatewayBoot.state.connectFailures})`
	);
	assert.strictEqual(
		gatewayBoot.state.fatalConnectFailure,
		true,
		'an unrecoverable connect loop stops instead of retrying forever'
	);
	assert.strictEqual(exitCode, 1, 'the worker exits 1 so the master reports the crash loop');
});

/*
 * A real gateway client is torn down by the process exiting; this harness keeps
 * fake sockets and eris' per-shard timers around, which would leave the event
 * loop alive and hang `npm test`. Finish explicitly once every assertion has
 * run — the exit code still reflects a failed assertion.
 */
test.after(() => {
	setTimeout(() => process.exit(process.exitCode || 0), 100);
});
