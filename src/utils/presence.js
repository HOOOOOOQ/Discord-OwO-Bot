/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Bot presence (the green dot next to the name and the "Playing …" line).
 *
 * Upstream only set a status when its private sharder server answered, so a
 * self-hosted bot connected with a blank presence and looked dead in the member
 * list even while it was working. Everything here is environment driven:
 *
 *   BOT_STATUS=online|idle|dnd|invisible        (default: online)
 *   BOT_ACTIVITY_TYPE=playing|watching|listening|competing|streaming|custom
 *                                               (default: watching)
 *   BOT_ACTIVITY_TEXT="discord.gg/666family"    supports {guilds} {users} {shards} {prefix}
 *
 * Discord renders the activity as plain text: an activity text is NOT clickable
 * (only a real link inside an embed is), so the server invite is additionally
 * shown as a clickable embed link by the help/about commands.
 *   BOT_ACTIVITY_URL=https://twitch.tv/...      required for streaming (type 1)
 *   BOT_PRESENCE_REFRESH_SEC=600                re-apply every N seconds, 0 disables
 *
 * A custom status (type 4) is supported by Discord for bots, but clients render
 * it only as a "Custom Status" line, so the text goes into `state`.
 */

const log = require('./log.js');

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];

// Discord activity type ids.
const TYPES = {
	playing: 0,
	streaming: 1,
	listening: 2,
	watching: 3,
	custom: 4,
	competing: 5,
};

const DEFAULT_STATUS = 'online';
const DEFAULT_TYPE = 'watching';
const DEFAULT_TEXT = 'discord.gg/666family';
const DEFAULT_REFRESH_SEC = 0;

function normalizeChoice(value, allowed, fallback, name, warnings) {
	if (value === undefined || value === null || String(value).trim() === '') return fallback;
	const normalized = String(value).trim().toLowerCase();
	if (allowed.includes(normalized)) return normalized;
	warnings.push(`${name}=${value} is not one of ${allowed.join('|')}; using ${fallback}`);
	return fallback;
}

function toSeconds(value, fallback, warnings) {
	if (value === undefined || value === null || String(value).trim() === '') return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		warnings.push(`BOT_PRESENCE_REFRESH_SEC=${value} is not a positive number; using ${fallback}`);
		return fallback;
	}
	return parsed;
}

/** Fills {guilds}/{users}/{shards}/{prefix} in the activity text. */
function renderTemplate(text, counts = {}) {
	if (!text) return '';
	return String(text)
		.replace(/\{guilds\}/gi, String(counts.guilds ?? 0))
		.replace(/\{users\}/gi, String(counts.users ?? 0))
		.replace(/\{shards\}/gi, String(counts.shards ?? 1))
		.replace(/\{prefix\}/gi, String(counts.prefix ?? 'o'));
}

/**
 * @param {Object} [env] environment (defaults to process.env)
 * @returns {{status: String, type: String, typeId: Number, text: String, url: ?String, refreshMs: Number, warnings: Array<String>}}
 */
function resolve(env = process.env) {
	const warnings = [];
	const status = normalizeChoice(env.BOT_STATUS, STATUSES, DEFAULT_STATUS, 'BOT_STATUS', warnings);
	let type = normalizeChoice(
		env.BOT_ACTIVITY_TYPE,
		Object.keys(TYPES),
		DEFAULT_TYPE,
		'BOT_ACTIVITY_TYPE',
		warnings
	);
	const text =
		env.BOT_ACTIVITY_TEXT === undefined ||
		env.BOT_ACTIVITY_TEXT === null ||
		String(env.BOT_ACTIVITY_TEXT).trim() === ''
			? DEFAULT_TEXT
			: String(env.BOT_ACTIVITY_TEXT).trim();
	let url = env.BOT_ACTIVITY_URL ? String(env.BOT_ACTIVITY_URL).trim() : null;

	// Discord rejects a streaming activity without a URL; fall back to playing.
	if (type === 'streaming' && !url) {
		warnings.push('BOT_ACTIVITY_TYPE=streaming needs BOT_ACTIVITY_URL; using playing');
		type = 'playing';
	}
	if (type !== 'streaming') url = null;

	const refreshMs = toSeconds(env.BOT_PRESENCE_REFRESH_SEC, DEFAULT_REFRESH_SEC, warnings) * 1000;

	return { status, type, typeId: TYPES[type], text, url, refreshMs, warnings };
}

/** Builds the eris `activities` payload (array of one). */
function buildActivity(presence, counts = {}) {
	const text = renderTemplate(presence.text, counts);
	if (!text) return null;
	if (presence.type === 'custom') {
		return { type: TYPES.custom, name: 'Custom Status', state: text };
	}
	const activity = { name: text, type: presence.typeId };
	if (presence.type === 'streaming' && presence.url) activity.url = presence.url;
	return activity;
}

/**
 * Applies the configured presence to a connected client.
 * @returns {{status: String, activity: ?Object, presence: Object}}
 */
function apply(client, options = {}) {
	const env = options.env || process.env;
	const counts = options.counts || {};
	const presence = resolve(env);

	for (const warning of presence.warnings) log.warn(`presence: ${warning}`);

	const activity = buildActivity(presence, counts);
	try {
		client.editStatus(presence.status, activity ? [activity] : []);
	} catch (err) {
		log.warn(`presence: could not set status (${err.message})`);
		return { status: presence.status, activity: null, presence };
	}
	return { status: presence.status, activity, presence };
}

function describe(activity) {
	if (!activity) return 'no activity';
	if (activity.type === TYPES.custom) return `custom status "${activity.state}"`;
	const label = Object.keys(TYPES).find((key) => TYPES[key] === activity.type) || 'playing';
	return `${label} "${activity.name}"`;
}

/**
 * Periodically re-applies the presence (useful with {guilds}/{users} templates
 * and after gateway reconnects). Returns a function that stops the interval.
 */
function startRefresh(main, options = {}) {
	const env = options.env || process.env;
	const presence = resolve(env);
	if (!presence.refreshMs) return () => {};

	const timer = setInterval(() => {
		try {
			const bot = main.bot;
			apply(bot, {
				env,
				counts: {
					guilds: bot.guilds.size,
					users: bot.users.size,
					shards: bot.shards.size,
					prefix: main.prefix,
				},
			});
		} catch (err) {
			log.warn(`presence: refresh failed (${err.message})`);
		}
	}, presence.refreshMs);
	if (typeof timer.unref === 'function') timer.unref();

	return () => clearInterval(timer);
}

module.exports = {
	STATUSES,
	TYPES,
	DEFAULT_STATUS,
	DEFAULT_TYPE,
	DEFAULT_TEXT,
	resolve,
	renderTemplate,
	buildActivity,
	apply,
	describe,
	startRefresh,
};
