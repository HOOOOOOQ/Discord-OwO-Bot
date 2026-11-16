/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Tiny Discord REST helpers used by the sharder bootstrap, the
 * `node index.js --doctor` self-check and the startup diagnostics.
 *
 * Everything here is best effort: a network failure returns
 * `{ ok: false, error }` instead of throwing, so the bot can always fall back
 * to conservative defaults.
 */

const log = require('./log.js');

const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.DISCORD_API_TIMEOUT_MS, 10) || 10000;

// Gateway intents (Discord docs > Gateway > Intents)
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MEMBERS = 1 << 1;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

// Application flags (Discord docs > Resources > Application)
const APP_FLAG_GATEWAY_PRESENCE = 1 << 13;
const APP_FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 14;
const APP_FLAG_GATEWAY_GUILD_MEMBERS = 1 << 15;
const APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 16;
const APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 19;
const APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 20;

function apiBase() {
	return process.env.DISCORD_API_BASE || DEFAULT_API_BASE;
}

/** Accepts a raw token or one already prefixed with `Bot `. */
function normalizeToken(token) {
	const value = String(token || '').trim();
	if (!value) return 'Bot ';
	return /^Bot /i.test(value) ? `Bot ${value.slice(4).trim()}` : `Bot ${value}`;
}

async function apiGet(token, path, options = {}) {
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	if (typeof fetchImpl !== 'function') {
		return { ok: false, status: 0, error: 'global fetch is unavailable (Node >= 18 required)' };
	}

	const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
	if (timer && typeof timer.unref === 'function') timer.unref();

	try {
		const res = await fetchImpl(`${apiBase()}${path}`, {
			method: 'GET',
			headers: {
				authorization: normalizeToken(token),
				'user-agent': 'DiscordBot (https://github.com/ChristopherBThai/Discord-OwO-Bot, 1.0.0)',
			},
			signal: controller ? controller.signal : undefined,
		});

		let text = '';
		try {
			text = await res.text();
		} catch (err) {
			text = '';
		}
		let data = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch (err) {
				data = null;
			}
		}

		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				data,
				error: (data && data.message) || `HTTP ${res.status}`,
			};
		}
		return { ok: true, status: res.status, data };
	} catch (err) {
		const aborted = err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''));
		const error = aborted
			? `request timed out after ${timeoutMs}ms`
			: (err && err.message) || String(err);
		log.debug(`discord api GET ${path} failed: ${error}`);
		return { ok: false, status: 0, error };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** `GET /users/@me` — also the cheapest way to validate a bot token. */
function getCurrentUser(token, options) {
	return apiGet(token, '/users/@me', options);
}

/** `GET /applications/@me` — holds the privileged-intent flags. */
function getApplication(token, options) {
	return apiGet(token, '/applications/@me', options);
}

/** `GET /gateway/bot` — recommended shard count + session start budget. */
function getBotGateway(token, options) {
	return apiGet(token, '/gateway/bot', options);
}

/**
 * Discord keeps a flag per privileged intent: the `*_LIMITED` variant means the
 * intent is enabled but the app is not verified. Either way the gateway accepts
 * the intent.
 */
function messageContentIntentAllowed(flags) {
	const value = Number(flags) || 0;
	return (
		(value & APP_FLAG_GATEWAY_MESSAGE_CONTENT) !== 0 ||
		(value & APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0
	);
}

function guildMembersIntentAllowed(flags) {
	const value = Number(flags) || 0;
	return (
		(value & APP_FLAG_GATEWAY_GUILD_MEMBERS) !== 0 ||
		(value & APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED) !== 0
	);
}

function presenceIntentAllowed(flags) {
	const value = Number(flags) || 0;
	return (
		(value & APP_FLAG_GATEWAY_PRESENCE) !== 0 || (value & APP_FLAG_GATEWAY_PRESENCE_LIMITED) !== 0
	);
}

function formatUser(user) {
	if (!user) return 'unknown';
	const tag =
		user.discriminator && user.discriminator !== '0'
			? `${user.username}#${user.discriminator}`
			: user.username;
	return `${tag} (id ${user.id})`;
}

module.exports = {
	INTENT_GUILDS,
	INTENT_GUILD_MEMBERS,
	INTENT_GUILD_MESSAGES,
	INTENT_MESSAGE_CONTENT,
	APP_FLAG_GATEWAY_MESSAGE_CONTENT,
	APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED,
	APP_FLAG_GATEWAY_GUILD_MEMBERS,
	APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED,
	APP_FLAG_GATEWAY_PRESENCE,
	APP_FLAG_GATEWAY_PRESENCE_LIMITED,
	apiBase,
	apiGet,
	normalizeToken,
	getCurrentUser,
	getApplication,
	getBotGateway,
	messageContentIntentAllowed,
	guildMembersIntentAllowed,
	presenceIntentAllowed,
	formatUser,
};
