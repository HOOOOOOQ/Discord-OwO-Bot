/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * `node index.js --doctor`
 *
 * A read-only self-check for hosts where the only way to inspect the bot is the
 * panel console (Pterodactyl, Docker logs, systemd journal). It answers the
 * questions that "bot offline / commands ignored" always boil down to:
 *
 *   - is the token still valid?
 *   - is MESSAGE CONTENT INTENT enabled for that application?
 *   - is the shard count sane?
 *   - are DATABASE_URL / REDIS_URL configured and reachable?
 *
 * It never starts a shard, never writes to the database and never prints
 * secrets.
 */

const net = require('net');

const discordApi = require('./discordApi.js');
const dbUrl = require('./dbUrl.js');
const intentsUtil = require('./intents.js');
const gatewayCodes = require('./gatewayCodes.js');
const presenceUtil = require('./presence.js');

const OK = 'ok  ';
const FAIL = 'FAIL';
const WARN = 'warn';
const INFO = 'info';

function maskToken(token) {
	const value = String(token || '');
	if (!value) return '(empty)';
	if (value.length <= 8) return '*'.repeat(value.length);
	return `${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function major(version) {
	return Number.parseInt(String(version || '').replace(/^v/, ''), 10) || 0;
}

function probeTcp(host, port, timeoutMs = 3000) {
	return new Promise((resolve) => {
		if (!host || !port) {
			resolve({ ok: false, error: 'host/port not configured' });
			return;
		}
		const socket = net.connect({ host, port });
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish({ ok: true }));
		socket.once('timeout', () => finish({ ok: false, error: `timeout after ${timeoutMs}ms` }));
		socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
	});
}

/**
 * Performs a real gateway login (`--doctor --connect`). This is the only check
 * that proves the bot can actually appear online: a valid token with a disabled
 * privileged intent only fails at IDENTIFY time.
 *
 * Stop the server first — two connections with the same token invalidate each
 * other's session.
 */
function gatewayLogin(token, options = {}) {
	const timeoutMs = options.timeoutMs || 25000;
	const intents = intentsUtil.resolveIntents({ env: options.env || process.env }).value;
	let Eris;
	try {
		Eris = require('eris');
	} catch (err) {
		return Promise.resolve({
			level: FAIL,
			title: 'gateway login',
			detail: `eris is not installed (${err.message})`,
		});
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try {
				client.disconnect({ reconnect: false });
			} catch (err) {
				/* already gone */
			}
			resolve(result);
		};

		const client = new Eris(`Bot ${token}`, {
			intents,
			autoreconnect: false,
			compress: false,
			messageLimit: 1,
		});

		const timer = setTimeout(
			() =>
				finish({
					level: WARN,
					title: 'gateway login',
					detail: `no READY inside ${Math.round(
						timeoutMs / 1000
					)}s — network blocked or Discord slow`,
				}),
			timeoutMs
		);
		if (typeof timer.unref === 'function') timer.unref();

		client.on('ready', () => {
			const user = client.user;
			finish({
				level: OK,
				title: 'gateway login',
				detail:
					`connected as ${user ? discordApi.formatUser(user) : 'unknown'} ` +
					`in ${client.guilds.size} guild(s), ${client.shards.size} shard(s) — the bot can appear online`,
			});
		});
		client.on('error', (err) => {
			const code = err && (err.code || err.closeCode);
			finish({
				level: FAIL,
				title: 'gateway login',
				detail: `${err && err.message}${code ? ` (${gatewayCodes.describe(code)})` : ''}`,
			});
		});
		client.on('disconnect', (err) => {
			const code = err && err.code;
			if (code === 1000 || code === 1001) return; // normal close after ready
			finish({ level: FAIL, title: 'gateway login', detail: gatewayCodes.describe(code) });
		});

		Promise.resolve()
			.then(() => client.connect())
			.catch((err) => finish({ level: FAIL, title: 'gateway login', detail: err.message }));
	});
}

async function collect(options = {}) {
	const env = options.env || process.env;
	const api = options.api || discordApi;
	const probe = options.probe || probeTcp;
	const checks = [];
	const push = (level, title, detail) => checks.push({ level, title, detail });

	// --- runtime ------------------------------------------------------------
	const nodeMajor = major(process.versions.node);
	if (nodeMajor >= 20) {
		push(OK, `node ${process.versions.node}`, 'meets engines >= 20');
	} else {
		push(
			FAIL,
			`node ${process.versions.node}`,
			'requires Node >= 20 (set the panel image / startup to nodejs_20)'
		);
	}

	// --- token --------------------------------------------------------------
	if (!env.BOT_TOKEN) {
		push(FAIL, 'BOT_TOKEN', 'not set — add it to .env (or the panel variables)');
	} else {
		push(INFO, 'BOT_TOKEN', `set (${maskToken(env.BOT_TOKEN)})`);
		const user = await api.getCurrentUser(env.BOT_TOKEN);
		if (user.ok) {
			push(OK, 'token accepted by Discord', api.formatUser(user.data));
		} else if (user.status === 401) {
			push(
				FAIL,
				'token rejected (HTTP 401)',
				'invalid/revoked token — copy a fresh one from the Developer Portal'
			);
		} else {
			push(WARN, 'token not verified', `could not reach Discord: ${user.error}`);
		}
	}

	// --- application / privileged intents -----------------------------------
	if (env.BOT_TOKEN) {
		const app = await api.getApplication(env.BOT_TOKEN);
		if (app.ok) {
			const data = app.data || {};
			push(INFO, 'application', `${data.name || 'unknown'} (id ${data.id || '?'})`);
			if (api.messageContentIntentAllowed(data.flags)) {
				push(OK, 'MESSAGE CONTENT INTENT', 'enabled — commands can be read');
			} else {
				push(
					FAIL,
					'MESSAGE CONTENT INTENT',
					'DISABLED — the bot connects but ignores every command. Enable it: Developer Portal → your app → Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT → Save, then restart'
				);
			}
		} else if (app.status !== 401) {
			push(WARN, 'application flags', `unavailable: ${app.error}`);
		}
	}

	// --- intents actually requested -----------------------------------------
	const resolvedIntents = intentsUtil.resolveIntents({ env });
	push(
		INFO,
		'requested intents',
		`${resolvedIntents.value} (${intentsUtil.describe(resolvedIntents.value)})` +
			(resolvedIntents.source === 'ERIS_INTENTS' ? ' [ERIS_INTENTS]' : '')
	);

	// --- shards -------------------------------------------------------------
	if (env.SHARDS || env.SHARD_FIRST || env.SHARD_LAST) {
		push(
			INFO,
			'shard overrides',
			`SHARDS=${env.SHARDS || '-'} SHARD_FIRST=${env.SHARD_FIRST || '-'} SHARD_LAST=${
				env.SHARD_LAST || '-'
			}`
		);
	} else if (env.SHARDER_HOST) {
		push(INFO, 'shard source', `SHARDER_HOST=${env.SHARDER_HOST} (external sharder server)`);
	} else {
		push(INFO, 'shard source', "Discord's recommended shard count (SHARDER_HOST not needed)");
	}
	if (env.BOT_TOKEN) {
		const gateway = await api.getBotGateway(env.BOT_TOKEN);
		if (gateway.ok) {
			const limit = (gateway.data && gateway.data.session_start_limit) || {};
			push(
				OK,
				'gateway',
				`${gateway.data && gateway.data.shards} recommended shard(s), identify budget ${
					limit.remaining
				}/${limit.total}`
			);
			if (limit.remaining === 0) {
				push(
					WARN,
					'identify budget exhausted',
					`reset in ${Math.round((limit.reset_after || 0) / 60000)} minutes`
				);
			}
		} else if (gateway.status !== 401) {
			push(WARN, 'gateway', `unavailable: ${gateway.error}`);
		}
	}

	// --- clusters ------------------------------------------------------------
	const clusters = Number.parseInt(env.CLUSTERS, 10);
	if (!Number.isInteger(clusters) || clusters < 1) {
		push(
			WARN,
			'CLUSTERS',
			'not set — the repo default (60) needs several GB of RAM. Set CLUSTERS=1 or 2 for a small server'
		);
	} else if (clusters > 4) {
		push(
			WARN,
			'CLUSTERS',
			`${clusters} clusters — each one is a full Node process; 1-2 is enough below ~2500 guilds`
		);
	} else {
		push(OK, 'CLUSTERS', String(clusters));
	}

	// --- debug mode ----------------------------------------------------------
	if (String(env.DEBUG || '').toLowerCase() === 'true') {
		const whitelist = String(env.DEBUG_WHITELIST || '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		if (whitelist.length === 0) {
			push(
				FAIL,
				'DEBUG=true without DEBUG_WHITELIST',
				'the bot would ignore every guild — set DEBUG_WHITELIST to your guild ID, or remove DEBUG'
			);
		} else {
			push(
				WARN,
				'DEBUG=true',
				`the bot only responds in: ${whitelist.join(
					', '
				)} — run without DEBUG once the sharder is configured`
			);
		}
	}

	// --- presence ------------------------------------------------------------
	const presence = presenceUtil.resolve(env);
	push(
		INFO,
		'presence',
		`${presence.status} — ${presence.type} "${presence.text}"` +
			(presence.refreshMs ? ` (refresh every ${presence.refreshMs / 1000}s)` : '')
	);
	for (const warning of presence.warnings) push(WARN, 'presence', warning);

	// --- real gateway login (opt in: opens a session) ------------------------
	if (options.connect) {
		if (!env.BOT_TOKEN) {
			push(FAIL, 'gateway login', 'BOT_TOKEN is not set');
		} else {
			const login = await gatewayLogin(env.BOT_TOKEN, { env });
			push(login.level, login.title, login.detail);
		}
	}

	// --- storage -------------------------------------------------------------
	const mysql = dbUrl.resolveMysql(env);
	const redis = dbUrl.resolveRedis(env);

	if (!mysql.host) {
		push(
			FAIL,
			'database',
			'no host — set DATABASE_URL=mysql://user:pass@host:3306/owo (or MYSQL_HOST/MYSQL_USER/MYSQL_PASS)'
		);
	} else {
		const mysqlProbe = await probe(mysql.host, mysql.port || 3306);
		if (mysqlProbe.ok) push(OK, 'database reachable', `${mysql.host}:${mysql.port || 3306}`);
		else push(WARN, 'database', `${mysql.host}:${mysql.port || 3306} — ${mysqlProbe.error}`);
	}

	if (!redis.host) {
		push(
			FAIL,
			'redis',
			'no host — set REDIS_URL=redis://:pass@host:6379/0 (or REDIS_HOST/REDIS_PASS)'
		);
	} else {
		const redisProbe = await probe(redis.host, redis.port || 6379);
		if (redisProbe.ok) push(OK, 'redis reachable', `${redis.host}:${redis.port || 6379}`);
		else push(WARN, 'redis', `${redis.host}:${redis.port || 6379} — ${redisProbe.error}`);
	}

	return checks;
}

function format(checks) {
	const lines = ['OCEAN self-check (node index.js --doctor)', ''];
	for (const check of checks) {
		lines.push(`[${check.level}] ${check.title}${check.detail ? ` — ${check.detail}` : ''}`);
	}
	const failed = checks.filter((check) => check.level === FAIL).length;
	const warned = checks.filter((check) => check.level === WARN).length;
	lines.push('');
	lines.push(`${checks.length} checks, ${failed} failed, ${warned} warning(s)`);
	return { text: lines.join('\n'), failed };
}

async function run(options = {}) {
	const checks = await collect(options);
	const { text, failed } = format(checks);
	// eslint-disable-next-line no-console
	console.log(text);
	return failed === 0;
}

module.exports = { collect, format, run, gatewayLogin, maskToken, probeTcp };
