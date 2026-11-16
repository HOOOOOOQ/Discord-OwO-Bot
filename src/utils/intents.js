/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Gateway intent selection.
 *
 * The upstream config never set `intents`, so eris fell back to
 * `Intents.allNonPrivileged`, which does NOT include MESSAGE_CONTENT. The bot
 * then connected fine but received every message with an empty `content`, so no
 * command ever matched — the classic "bot online tapi tidak merespons".
 *
 * MESSAGE_CONTENT is a privileged intent: it must also be toggled in the
 * Discord Developer Portal. `ERIS_MESSAGE_CONTENT` controls how we treat it:
 *
 *   auto (default) — request it unless the application flags say it is disabled
 *   on             — always request it (portal toggle must be enabled)
 *   off            — never request it (bot stays online but cannot read commands)
 */

const { INTENT_MESSAGE_CONTENT } = require('./discordApi.js');

// Sum of every non-privileged intent, matching eris' Intents.allNonPrivileged.
const ALL_NON_PRIVILEGED = 98045;

const KNOWN_NAMES = {
	guilds: 1 << 0,
	guildMembers: 1 << 1,
	guildBans: 1 << 2,
	guildEmojisAndStickers: 1 << 3,
	guildIntegrations: 1 << 4,
	guildWebhooks: 1 << 5,
	guildInvites: 1 << 6,
	guildVoiceStates: 1 << 7,
	guildPresences: 1 << 8,
	guildMessages: 1 << 9,
	guildMessageReactions: 1 << 10,
	guildMessageTyping: 1 << 11,
	directMessages: 1 << 12,
	directMessageReactions: 1 << 13,
	directMessageTyping: 1 << 14,
	messageContent: INTENT_MESSAGE_CONTENT,
	allNonPrivileged: ALL_NON_PRIVILEGED,
};

function intentTable() {
	try {
		const eris = require('eris');
		return (eris && eris.Constants && eris.Constants.Intents) || null;
	} catch (err) {
		return null;
	}
}

function lookup(name, table) {
	if (table && Number.isInteger(table[name])) return table[name];
	if (Number.isInteger(KNOWN_NAMES[name])) return KNOWN_NAMES[name];
	return null;
}

/** Parses `ERIS_INTENTS` — accepts names, numbers, or a mix (`allNonPrivileged,messageContent`). */
function parseIntentSpec(spec, table) {
	const parts = String(spec || '')
		.split(/[\s,]+/)
		.filter(Boolean);
	let value = 0;
	const unknown = [];
	for (const part of parts) {
		const numeric = Number(part);
		if (Number.isInteger(numeric) && numeric >= 0) {
			value |= numeric;
			continue;
		}
		const bit = lookup(part, table);
		if (bit === null) unknown.push(part);
		else value |= bit;
	}
	return { value, unknown };
}

/**
 * @param {Object} [options]
 * @param {Object} [options.env] environment (defaults to process.env)
 * @param {Object} [options.table] eris intent table (injectable for tests)
 * @param {Boolean} [options.messageContentAllowed] result of the application flags check
 */
function resolveIntents(options = {}) {
	const env = options.env || process.env;
	const table = options.table === undefined ? intentTable() : options.table;
	const base = (table && table.allNonPrivileged) || ALL_NON_PRIVILEGED;

	if (env.ERIS_INTENTS) {
		const parsed = parseIntentSpec(env.ERIS_INTENTS, table);
		if (parsed.value > 0) {
			return {
				value: parsed.value,
				source: 'ERIS_INTENTS',
				unknown: parsed.unknown,
				messageContent: (parsed.value & INTENT_MESSAGE_CONTENT) !== 0,
			};
		}
	}

	const mode = String(env.ERIS_MESSAGE_CONTENT || 'auto').toLowerCase();
	let includeMessageContent;
	if (mode === 'off') includeMessageContent = false;
	else if (mode === 'on') includeMessageContent = true;
	else includeMessageContent = options.messageContentAllowed !== false;

	return {
		value: includeMessageContent ? base | INTENT_MESSAGE_CONTENT : base,
		source: 'default',
		unknown: [],
		messageContent: includeMessageContent,
		mode,
	};
}

function describe(bitmask) {
	const names = [];
	for (const [name, bit] of Object.entries(KNOWN_NAMES)) {
		if (name === 'allNonPrivileged') continue;
		if ((bitmask & bit) === bit) names.push(name);
	}
	return names.length ? names.join(', ') : 'none';
}

module.exports = {
	ALL_NON_PRIVILEGED,
	INTENT_MESSAGE_CONTENT,
	KNOWN_NAMES,
	intentTable,
	parseIntentSpec,
	resolveIntents,
	describe,
};
