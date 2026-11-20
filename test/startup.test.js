/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Startup behaviour, end to end.
 *
 * These tests spawn the real processes (no mocks of index.js):
 *
 *   1. `node src/owo.js` — the file a user reaches for when the bot is offline.
 *      It is a worker class, not an entry point: before the guard it exited 0
 *      with no output at all, which reads as "the bot fails to connect".
 *
 *   2. `node index.js` with a token Discord will reject. The whole chain runs:
 *      master → MongoDB (in-memory fixture) → eris-sharder → worker → IDENTIFY
 *      attempt → failure → respawn. The assertions pin the two defects that made
 *      the bot sit "online" without ever connecting:
 *        - a respawned worker must receive its shard assignment again
 *          (eris-sharder's queue only ever delivers the first one);
 *        - the master must stop after a crash loop instead of forking forever.
 */

const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'fixtures', 'memoryMongo.js');

/** Runs a child process with a hard kill timer and collects its output. */
function run(args, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, {
			cwd: ROOT,
			env: Object.assign({}, process.env, options.env || {}),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let killedByTimer = false;
		const timer = setTimeout(() => {
			killedByTimer = true;
			child.kill('SIGKILL');
		}, options.timeout || 20000);
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, killedByTimer });
		});
	});
}

test('`node src/owo.js` explains that it is not an entry point', async () => {
	const result = await run(['src/owo.js'], { timeout: 15000 });

	assert.strictEqual(result.killedByTimer, false, 'it must exit by itself, not hang');
	assert.strictEqual(result.code, 1, 'a wrong entry point must not look like success');
	const output = result.stdout + result.stderr;
	assert.match(output, /cannot be started directly/i);
	assert.match(output, /node index\.js/, 'it names the real entry point');
	assert.match(output, /--doctor/, 'it names the diagnostic command');
});

test(
	'a rejected gateway stops the master instead of restarting workers forever',
	{ timeout: 120000 },
	async () => {
		const result = await run(['index.js'], {
			timeout: 90000,
			env: {
				// Discord rejects this; the gateway closes (or the REST call fails) and
				// the worker must report it instead of idling.
				BOT_TOKEN: 'Bot invalid.token.for.tests',
				MONGODB_URI: 'mongodb://memory/ocean',
				MONGO_OFFLINE: 'false',
				GATEWAY_PROBE_ON_BOOT: 'false',
				GATEWAY_CONNECT_ATTEMPTS: '1',
				CLUSTERS: '1',
				// Load the in-memory database before index.js requires the client.
				NODE_OPTIONS: `--require ${STUB}`,
			},
		});

		const output = result.stdout + result.stderr;
		assert.strictEqual(result.killedByTimer, false, 'the process must end on its own');

		// The startup sequence the panel should show.
		assert.match(output, /\[BOOT\] OCEAN starting/);
		assert.match(output, /\[ENV\] configuration loaded — prefix=o/);
		assert.match(output, /\[DATABASE\] connecting to MongoDB/);
		assert.match(output, /\[DATABASE\] connected/);
		assert.match(output, /\[DISCORD\] connecting to the gateway/);
		assert.match(
			output,
			/\[CLUSTER\] repaired eris-sharder's assignment queue/,
			'the queue repair is installed in the master'
		);

		// The failure is reported with its real reason, not as "worker online".
		assert.match(output, /\[GATEWAY\] connect attempt 1\/1 failed/);
		assert.match(output, /\[FATAL\].*gateway never opened/);

		// A respawned worker gets its shards again: eris-sharder's own queue only
		// delivers the first assignment (proof: the queue never executes twice).
		// Each worker logs its own acknowledgement, and the master logs when a
		// cluster moves to a new worker — both are counted here.
		const workerAcks = output.match(/\[GATEWAY\] stage ipc_connect_received/g) || [];
		assert.ok(
			workerAcks.length >= 2,
			`only ${workerAcks.length} worker(s) received the shard assignment`
		);
		const rehomes = output.match(/cluster 0 is served by worker \d+ now \(was \d+\)/g) || [];
		assert.ok(rehomes.length >= 1, 'the master never re-delivered an assignment after a crash');

		// And the master ends the loop instead of respawning forever.
		assert.match(output, /crash loop: \d+ worker exits/);
		assert.match(output, /\[FATAL\] stopping the master to end the restart loop/);
		assert.strictEqual(result.code, 1, 'the panel must see a crash, not a healthy server');
	}
);

test(
	'the shard assignment is replayed when it arrives before eris-sharder listens',
	{ timeout: 120000 },
	async () => {
		// The field failure: the worker's MongoDB handshake takes seconds, so
		// eris-sharder registers its IPC listener long after the master sent
		// "connect". Node emits the message into the void and the worker never
		// creates an Eris client. The worker now buffers it and replays it.
		const result = await run(['index.js'], {
			timeout: 90000,
			env: {
				BOT_TOKEN: 'Bot invalid.token.for.tests',
				MONGODB_URI: 'mongodb://memory/ocean',
				GATEWAY_PROBE_ON_BOOT: 'false',
				GATEWAY_CONNECT_ATTEMPTS: '1',
				CLUSTERS: '1',
				TEST_MONGO_DELAY_MS: '4000',
				NODE_OPTIONS: `--require ${STUB}`,
			},
		});

		const output = result.stdout + result.stderr;
		assert.strictEqual(result.killedByTimer, false);

		assert.match(
			output,
			/\[GATEWAY\] stage ipc_connect_buffered/,
			'the early assignment was captured instead of dropped'
		);
		assert.match(
			output,
			/replaying it now so the client is created/,
			'the captured assignment was replayed after eris-sharder was listening'
		);
		assert.match(
			output,
			/\[GATEWAY\] stage connect_called/,
			'Eris Client#connect() ran, which never happened before the fix'
		);
		// The slow start must not be misreported as "the assignment never arrived".
		assert.doesNotMatch(
			output,
			/eris-sharder never created an Eris client in this worker/,
			'a delayed worker was diagnosed as a missing assignment'
		);
	}
);
