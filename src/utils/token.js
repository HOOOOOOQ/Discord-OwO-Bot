/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Token hygiene for panel-hosted deployments.
 *
 * Discord's documentation shows the REST header as `Bot <token>`, so a token
 * pasted from a tutorial usually comes with the `Bot ` prefix already attached.
 * Panel variables are also easy to save with a trailing newline or wrapping
 * quotes.
 *
 * REST calls tolerated both shapes (src/utils/discordApi.js prepends `Bot ` only
 * when it is missing), but the gateway did not: `index.js` always sent
 * `'Bot ' + BOT_TOKEN`, so a prefixed value became `Bot Bot <token>` and the
 * socket was closed with **4004 Authentication failed** even though the token
 * itself was perfectly valid — a bot that passes every REST check in
 * `--doctor` and still never appears online.
 *
 * `strip()` normalises the value and reports what it had to change; callers
 * decide how loudly to say so. The token itself is never returned in a log line.
 */

/** Removes duplicated `Bot ` prefixes, surrounding quotes and whitespace. */
function strip(raw) {
	const original = String(raw === undefined || raw === null ? '' : raw);
	const trimmed = original.trim();
	const hadQuotes = /^(["'`])[\s\S]*\1$/.test(trimmed);
	let value = hadQuotes ? trimmed.slice(1, -1).trim() : trimmed;

	let prefixes = 0;
	while (/^bot\s/i.test(value)) {
		value = value.slice(4).trim();
		prefixes++;
	}

	// Tokens never contain whitespace, and a variable saved as just "Bot " is a
	// blank token rather than a token literally called "Bot".
	const collapsed = value.replace(/\s+/g, '');
	const hadWhitespace = collapsed !== value || trimmed !== original;
	const token = /^bot$/i.test(collapsed) ? '' : collapsed;

	return {
		token,
		prefixes,
		hadPrefix: prefixes > 0,
		hadQuotes,
		hadWhitespace,
		changed: prefixes > 0 || hadQuotes || hadWhitespace,
	};
}

/** The authorization header / client constructor value: exactly one `Bot `. */
function botAuth(raw) {
	return `Bot ${strip(raw).token}`;
}

/** Human-readable description of what had to be normalised (never the value). */
function describeChanges(result) {
	const changes = [];
	if (result.prefixes === 1) changes.push('removed a duplicated "Bot " prefix');
	if (result.prefixes > 1) changes.push(`removed ${result.prefixes} duplicated "Bot " prefixes`);
	if (result.hadQuotes) changes.push('removed surrounding quotes');
	if (result.hadWhitespace) changes.push('trimmed whitespace/newlines');
	return changes;
}

module.exports = { strip, botAuth, describeChanges };
