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
 *   - is MONGODB_URI configured and reachable?
 *
 * It never starts a shard, never writes to the database and never prints
 * secrets.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const buildInfo = require('./buildInfo.js');
const gatewayBoot = require('./gatewayBoot.js');
const discordApi = require('./discordApi.js');
const intentsUtil = require('./intents.js');
const gatewayCodes = require('./gatewayCodes.js');
const presenceUtil = require('./presence.js');
const tokenUtil = require('./token.js');
const discordDns = require('./discordDns.js');
const gatewayProbe = require('./gatewayProbe.js');

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

		const client = new Eris(tokenUtil.botAuth(token), {
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
					)}s — reached: ${gatewayBoot.phaseSummary()}`,
				}),
			timeoutMs
		);
		if (typeof timer.unref === 'function') timer.unref();

		// Trace the real packets so the report shows where a login stopped even
		// when no READY ever arrives (HELLO without IDENTIFY = wrong token shape,
		// IDENTIFY without READY = intents/shards rejected).
		client.on('connect', (id) => {
			try {
				if (client.shards && client.shards.get) gatewayBoot.instrumentShard(client.shards.get(id));
			} catch (err) {
				/* tracing is best effort */
			}
		});

		client.on('ready', () => {
			const user = client.user;
			finish({
				level: OK,
				title: 'gateway login',
				detail:
					`connected as ${user ? discordApi.formatUser(user) : 'unknown'} ` +
					`in ${client.guilds.size} guild(s), ${client.shards.size} shard(s) — the bot can appear online` +
					` | ${gatewayBoot.phaseSummary()}`,
			});
		});
		client.on('error', (err) => {
			const code = gatewayBoot.closeCodeOf(err);
			finish({
				level: FAIL,
				title: 'gateway login',
				detail:
					`${err && err.message}${code ? ` (${gatewayCodes.describe(code)})` : ''}` +
					` | reached: ${gatewayBoot.phaseSummary()}`,
			});
		});
		client.on('disconnect', (err) => {
			const code = gatewayBoot.closeCodeOf(err);
			if (code === 1000 || code === 1001) return; // normal close after ready
			finish({
				level: FAIL,
				title: 'gateway login',
				detail: `${gatewayCodes.describe(code)} | reached: ${gatewayBoot.phaseSummary()}`,
			});
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

	// --- source fingerprint --------------------------------------------------
	// Pterodactyl runs whatever sits in /home/container: uploading a zip and
	// pressing Start does not replace old files. These hashes are what the panel
	// console prints as `[BOOT] running build <id>` — if they differ, the panel and
	// this check are running different code, which no log can reveal.
	push(
		INFO,
		'source build',
		`${buildInfo.fingerprint({ root: options.root })} (compare: [BOOT] running build …)`
	);
	for (const entry of buildInfo.snapshot({ root: options.root })) {
		// Informational on purpose: a missing file is already a hard FAIL further
		// down (macro/words), here it only pins *which* source tree is being run.
		push(
			INFO,
			`source ${entry.file}`,
			entry.hash === 'MISSING' ? 'MISSING — not present in this checkout' : entry.hash
		);
	}

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
		const tokenInfo = tokenUtil.strip(env.BOT_TOKEN);
		if (tokenInfo.changed) {
			push(
				WARN,
				'BOT_TOKEN format',
				`the value needed normalising (${tokenUtil
					.describeChanges(tokenInfo)
					.join(
						', '
					)}) — replace the panel variable with the bare token; a "Bot " prefix used to produce 4004 on the gateway`
			);
		}
		if (!tokenInfo.token) {
			push(FAIL, 'BOT_TOKEN', 'empty after normalisation — the panel variable is blank');
		}
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
			'not set — using 1 cluster (safe for a 2 GB panel). Set CLUSTERS=2 only on a larger server'
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
	if (presence.status === 'invisible') {
		push(
			FAIL,
			'presence',
			'BOT_STATUS=invisible makes a perfectly healthy bot look OFFLINE — set BOT_STATUS=online'
		);
	}

	// --- DNS lookup order ----------------------------------------------------
	// `ws` (the gateway) has no Happy Eyeballs: on a host with a broken IPv6
	// route REST works and the gateway hangs forever. Show the order the bot will
	// actually use, and apply it here so the probe below is representative.
	const dnsApplied = discordDns.apply(env);
	push(
		INFO,
		'dns lookup order',
		`${dnsApplied.order || 'default'}` +
			(dnsApplied.order === 'ipv4first'
				? ' (gateway prefers IPv4; GATEWAY_IPV4_FIRST=false to change)'
				: '')
	);

	// --- gateway websocket reachability (no IDENTIFY, no session) -----------
	if (options.probeGateway) {
		const result = await gatewayProbe.probe({ env, timeoutMs: options.probeTimeoutMs || 10000 });
		if (result.ok) {
			push(OK, 'gateway websocket', gatewayProbe.describe(result));
		} else {
			push(
				FAIL,
				'gateway websocket',
				`${gatewayProbe.describe(result)} — REST can be fine while this fails: the gateway is ` +
					'gateway.discord.gg over a raw ws/tls socket (no Happy Eyeballs, no proxy support)'
			);
		}
	}

	// --- DEBUG mode does not touch the gateway -------------------------------
	if (String(env.DEBUG || '').toLowerCase() === 'true') {
		push(
			INFO,
			'DEBUG and the gateway',
			'DEBUG only limits which guilds are answered (and forces one shard/cluster); it never ' +
				'changes the token, intents or connection path. Set DEBUG=false for production'
		);
	}

	// --- real gateway login (opt in: opens a session) ------------------------
	if (options.connect) {
		if (!env.BOT_TOKEN) {
			push(FAIL, 'gateway login', 'BOT_TOKEN is not set');
		} else {
			const login = await gatewayLogin(env.BOT_TOKEN, { env });
			push(login.level, login.title, login.detail);
		}
	}

	// --- required files (public checkout has them, some forks strip secret/) ---
	const root = options.root || path.join(__dirname, '..', '..');
	const exists = (relative) => {
		try {
			return fs.existsSync(path.join(root, relative));
		} catch (err) {
			return false;
		}
	};
	const firstExisting = (candidates) => candidates.find((candidate) => exists(candidate)) || null;

	const macro = firstExisting(['tokens/macro.js', 'secret/macro.js']);
	if (!macro) {
		push(
			FAIL,
			'macro module',
			'missing — src/owo.js requires tokens/macro.js and falls back to secret/macro.js; without either the cluster throws right after READY'
		);
	} else {
		try {
			const macroModule = require(path.join(root, macro));
			const bind = typeof macroModule.bind === 'function';
			if (bind) push(OK, 'macro module', `${macro} (exports bind/check/verify)`);
			else
				push(
					FAIL,
					'macro module',
					`${macro} exists but does not export bind() — the cluster will throw`
				);
		} catch (err) {
			push(FAIL, 'macro module', `${macro} could not be loaded: ${err.message}`);
		}
	}

	for (const [label, candidates] of [
		['badwords.json', ['tokens/badwords.json', 'secret/badwords.json']],
		['goodwords.json', ['tokens/goodwords.json', 'secret/goodwords.json']],
	]) {
		const found = firstExisting(candidates);
		if (!found) {
			push(
				FAIL,
				label,
				`missing — src/owo.js / src/utils/global.js require one of ${candidates.join(
					', '
				)}; without it the cluster crashes when the module loads`
			);
			continue;
		}
		try {
			JSON.parse(fs.readFileSync(path.join(root, found), 'utf8'));
			push(OK, label, found);
		} catch (err) {
			push(FAIL, label, `${found} is not valid JSON: ${err.message}`);
		}
	}

	// --- storage -------------------------------------------------------------
	// MongoDB Atlas is the only datastore the bot needs (database + key/value +
	// pub/sub all live there), so that is the only thing probed here.
	const mongoClient = require('./mongo/client.js');
	const uri = mongoClient.readUri(env);
	const info = mongoClient.inspectUri(uri);
	if (!info.ok) {
		push(FAIL, 'database', `${info.reason} — ${info.action}`);
	} else {
		push(OK, 'database uri', mongoClient.maskUri(uri));
		const host = String(info.host).split(',')[0].split(':')[0];
		const port = Number.parseInt(String(info.host).split(':')[1], 10) || 27017;
		const mongoProbe = await probe(host, port);
		if (mongoProbe.ok) push(OK, 'database reachable', `${host}:${port}`);
		else
			push(
				WARN,
				'database',
				`${host}:${port} — ${mongoProbe.error} (Atlas may still work over SRV/DNS)`
			);
	}
	if (env.DATABASE_URL || env.REDIS_URL || env.MYSQL_HOST || env.REDIS_HOST) {
		push(
			WARN,
			'legacy variables',
			'DATABASE_URL/REDIS_URL/MYSQL_*/REDIS_* are ignored — the bot stores everything in MongoDB Atlas'
		);
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
	// The CLI probes the gateway by default: it is the only check that proves the
	// WebSocket path works, and it never sends IDENTIFY. GATEWAY_PROBE_ON_BOOT=false
	// (or --no-probe) skips it.
	if (options.probeGateway === undefined) {
		// `--no-probe` skips it (e.g. on a host whose egress is known to be closed).
		options.probeGateway = !process.argv.includes('--no-probe');
	}
	const checks = await collect(options);
	const { text, failed } = format(checks);
	// eslint-disable-next-line no-console
	console.log(text);
	return failed === 0;
}

module.exports = { collect, format, run, gatewayLogin, maskToken, probeTcp };
