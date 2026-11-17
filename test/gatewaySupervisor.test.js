/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Regression tests for the "worker is online but the gateway connection never
 * starts" failure.
 *
 * The bot used to be judged online from process liveness, and a worker that never
 * received eris-sharder's IPC "connect" message sat completely silent forever: no
 * client, no socket, no error, nothing in the log. These tests pin the staged
 * supervisor that now names the failing stage, and the DNS/probe helpers that
 * separate "Discord rejected us" from "we never reached Discord".
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const dns = require('dns');
const { test } = require('node:test');

const gatewayBoot = require('../src/utils/gatewayBoot.js');
const discordDns = require('../src/utils/discordDns.js');
const gatewayProbe = require('../src/utils/gatewayProbe.js');

function resetSupervisor() {
	gatewayBoot.state.stages.clear();
	gatewayBoot.state.phases.length = 0;
	gatewayBoot.state.startedAt = Date.now();
	gatewayBoot.state.connectCalled = false;
	gatewayBoot.state.websocketOpened = false;
	gatewayBoot.state.readySeenAt = null;
	gatewayBoot.state.lastPacket = null;
	gatewayBoot.state.lastError = null;
	gatewayBoot.state.clusterId = null;
	gatewayBoot.state.watchdogArmed = false;
	gatewayBoot.state.watchdogReported = false;
}

test('the startup stages are ordered and start with the worker process', () => {
	assert.deepStrictEqual(gatewayBoot.STARTUP_STAGES.slice(0, 5), [
		'process_started',
		'sharder_constructed',
		'ipc_connect_received',
		'connect_called',
		'websocket_open',
	]);
});

test('markStage records a stage once and never invents the next one', () => {
	resetSupervisor();
	gatewayBoot.markStage('process_started', 'pid 1');
	gatewayBoot.markStage('process_started', 'pid 1 again');
	gatewayBoot.markStage('sharder_constructed', 'path ./src/owo.js');

	assert.deepStrictEqual(
		[...gatewayBoot.state.stages.keys()],
		['process_started', 'sharder_constructed']
	);
	assert.strictEqual(gatewayBoot.state.stages.size, 2);
	assert.strictEqual(gatewayBoot.firstMissingStage(), 'ipc_connect_received');
	assert.strictEqual(gatewayBoot.state.connectCalled, false);
});

test('connect_called and websocket_open set the flags the watchdog reads', () => {
	resetSupervisor();
	gatewayBoot.markStage('connect_called', 'Client at 9ms');
	assert.strictEqual(gatewayBoot.state.connectCalled, true);
	assert.strictEqual(gatewayBoot.state.websocketOpened, false);
	gatewayBoot.markStage('websocket_open', 'shard 0');
	assert.strictEqual(gatewayBoot.state.websocketOpened, true);
});

test('gateway packets feed the stage table (HELLO → IDENTIFY → READY)', () => {
	resetSupervisor();
	gatewayBoot.markPhase('HELLO_RECEIVED', 'shard=0');
	gatewayBoot.markPhase('IDENTIFY_SENT', 'shard=0 intents=130813 presence=online');
	assert.ok(gatewayBoot.hasStage('hello_received'));
	assert.ok(gatewayBoot.hasStage('identify_sent'));
	assert.strictEqual(gatewayBoot.state.lastPacket, 'IDENTIFY_SENT');
	assert.strictEqual(gatewayBoot.firstMissingStage(), 'process_started');

	gatewayBoot.markPhase('READY_RECEIVED', 'shard=0 OCEAN guilds=1');
	assert.ok(gatewayBoot.hasStage('ready_received'));
	assert.ok(gatewayBoot.state.readySeenAt);
	assert.strictEqual(gatewayBoot.firstMissingStage(), 'process_started');
});

test('the diagnostic snapshot names the stage that was never reached', () => {
	resetSupervisor();
	gatewayBoot.markStage('process_started', 'pid 42');
	gatewayBoot.markStage('sharder_constructed');
	gatewayBoot.markStage('ipc_connect_received', 'cluster 0, shards 0~0 of 1');

	const snapshot = gatewayBoot.diagnosticSnapshot();
	assert.strictEqual(snapshot.firstMissing, 'connect_called');
	assert.strictEqual(snapshot.connectCalled, false);
	assert.strictEqual(snapshot.websocketOpened, false);
	assert.strictEqual(snapshot.lastPacket, null);
	assert.ok(snapshot.stages.some((entry) => /^connect_called=NOT REACHED$/.test(entry)));

	const lines = gatewayBoot.formatDiagnostics(snapshot).join('\n');
	assert.match(lines, new RegExp(`\\[DIAG\\] worker pid=${process.pid}`));
	assert.match(lines, /connect\(\) called=false/);
	assert.match(lines, /websocket open=false/);
	assert.match(lines, /NOT REACHED/);
});

test('the watchdog reports CONNECTION NOT STARTED when no IPC connect arrived', async () => {
	resetSupervisor();
	gatewayBoot.markStage('process_started', 'pid 7');
	gatewayBoot.markStage('sharder_constructed');

	const lines = [];
	const original = require('../src/utils/log.js');
	const captured = [];
	for (const level of ['error', 'info', 'warn']) {
		const previous = original[level];
		original[level] = (...args) => captured.push(args.join(' '));
		lines.push([level, previous]);
	}
	try {
		gatewayBoot.armStartupWatchdog({ GATEWAY_CONNECT_TIMEOUT_MS: '10' });
		await new Promise((resolve) => setTimeout(resolve, 60));
	} finally {
		for (const [level, previous] of lines) original[level] = previous;
	}

	const output = captured.join('\n');
	assert.match(output, /\[GATEWAY\] CONNECTION NOT STARTED/);
	assert.match(output, /\[DIAG\] Worker is alive but no Gateway connection was initiated\./);
	assert.match(output, /\[DIAG\] Check Eris client initialization and connect\(\) execution\./);
	assert.match(output, /never received from the master/);
	assert.match(output, /\[DIAG\] stages: process_started=/);
	assert.strictEqual(gatewayBoot.state.watchdogReported, true);
});

test('the watchdog reports WEBSOCKET NOT OPENED when connect() ran but no socket opened', async () => {
	resetSupervisor();
	gatewayBoot.markStage('process_started');
	gatewayBoot.markStage('sharder_constructed');
	gatewayBoot.markStage('ipc_connect_received');
	gatewayBoot.markStage('connect_called');

	const log = require('../src/utils/log.js');
	const captured = [];
	const previousError = log.error;
	log.error = (...args) => captured.push(args.join(' '));
	try {
		gatewayBoot.armStartupWatchdog({ GATEWAY_CONNECT_TIMEOUT_MS: '10' });
		await new Promise((resolve) => setTimeout(resolve, 60));
	} finally {
		log.error = previousError;
	}
	const output = captured.join('\n');
	assert.match(output, /\[GATEWAY\] WEBSOCKET NOT OPENED/);
	assert.match(output, /DNS\/IPv6, blocked egress on 443/);
});

test('the watchdog stays quiet once READY was really received', async () => {
	resetSupervisor();
	gatewayBoot.markStage('process_started');
	gatewayBoot.state.readySeenAt = Date.now();
	const log = require('../src/utils/log.js');
	const captured = [];
	const previousError = log.error;
	log.error = (...args) => captured.push(args.join(' '));
	try {
		gatewayBoot.armStartupWatchdog({ GATEWAY_CONNECT_TIMEOUT_MS: '10' });
		await new Promise((resolve) => setTimeout(resolve, 60));
	} finally {
		log.error = previousError;
	}
	assert.deepStrictEqual(captured, []);
	assert.strictEqual(gatewayBoot.state.watchdogReported, false);
});

test('the connect timeout is configurable but never zero', () => {
	assert.strictEqual(gatewayBoot.connectTimeoutMs({}), 15000);
	assert.strictEqual(gatewayBoot.connectTimeoutMs({ GATEWAY_CONNECT_TIMEOUT_MS: '2500' }), 2500);
	assert.strictEqual(gatewayBoot.connectTimeoutMs({ GATEWAY_CONNECT_TIMEOUT_MS: 'nope' }), 15000);
});

test('the DNS order defaults to ipv4first and can be disabled', () => {
	assert.strictEqual(discordDns.desiredOrder({}), 'ipv4first');
	assert.strictEqual(discordDns.desiredOrder({ GATEWAY_IPV4_FIRST: 'false' }), 'verbatim');
	assert.strictEqual(discordDns.desiredOrder({ GATEWAY_IPV4_FIRST: 'no' }), 'verbatim');
	assert.strictEqual(discordDns.desiredOrder({ GATEWAY_IPV4_FIRST: 'true' }), 'ipv4first');

	const before = dns.getDefaultResultOrder();
	try {
		const applied = discordDns.apply({ GATEWAY_IPV4_FIRST: 'true' });
		assert.strictEqual(applied.order, 'ipv4first');
		assert.strictEqual(dns.getDefaultResultOrder(), 'ipv4first');
		discordDns.apply({ GATEWAY_IPV4_FIRST: 'false' });
		assert.strictEqual(dns.getDefaultResultOrder(), 'verbatim');
	} finally {
		dns.setDefaultResultOrder(before);
	}
});

test('the probe resolves the URL and reports a failed handshake honestly', async () => {
	assert.match(gatewayProbe.defaultUrl({}), /^wss:\/\/gateway\.discord\.gg\//);

	// A fake WebSocket that never sends HELLO: the probe must time out, not hang.
	class SilentSocket extends EventEmitter {
		terminate() {}
		close() {}
	}
	const result = await gatewayProbe.probe({ WebSocket: SilentSocket, timeoutMs: 30 });
	assert.strictEqual(result.ok, false);
	assert.match(result.error, /no HELLO inside/);
	assert.match(gatewayProbe.describe(result), /blocked or hanging/);
});

test('the probe accepts a real HELLO (op 10) and reports the heartbeat', async () => {
	class HelloSocket extends EventEmitter {
		constructor() {
			super();
			setTimeout(
				() => this.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } })),
				5
			);
		}
		terminate() {}
		close() {}
	}
	const result = await gatewayProbe.probe({ WebSocket: HelloSocket, timeoutMs: 500 });
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.heartbeat, 41250);
	assert.match(gatewayProbe.describe(result), /the gateway is reachable/);
});

test('a socket error is reported with its message, not swallowed', async () => {
	class FailingSocket extends EventEmitter {
		constructor() {
			super();
			setTimeout(
				() =>
					this.emit(
						'error',
						Object.assign(new Error('getaddrinfo ENOTFOUND gateway.discord.gg'), {
							code: 'ENOTFOUND',
						})
					),
				5
			);
		}
		terminate() {}
		close() {}
	}
	const result = await gatewayProbe.probe({ WebSocket: FailingSocket, timeoutMs: 500 });
	assert.strictEqual(result.ok, false);
	assert.match(result.error, /ENOTFOUND/);
	assert.strictEqual(result.code, 'ENOTFOUND');
});

test('the gateway handshake timeout reaches the workers as plain JSON', () => {
	const config = require('../src/utils/config.js');
	const ws = config.eris.clientOptions.ws;
	assert.ok(ws && Number.isInteger(ws.handshakeTimeout) && ws.handshakeTimeout > 0);
	// cluster IPC uses JSON: anything non-serialisable here would make every
	// worker.send() throw and the shard assignment would never arrive.
	assert.deepStrictEqual(
		JSON.parse(JSON.stringify(config.eris.clientOptions)),
		config.eris.clientOptions
	);
});
