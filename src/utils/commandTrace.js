/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Command pipeline tracing.
 *
 * "The bot is online but nothing answers" is impossible to debug from the
 * outside: the message may never arrive (intent), may be dropped by DEBUG mode,
 * may not match the prefix, may name a command that is not registered, or may be
 * held back by the accept-the-rules gate. Every one of those steps now emits a
 * single `[CMD]` line, so the console names the step that stopped the message.
 *
 * Tracing is opt-in: `COMMAND_DEBUG=true` turns it on explicitly, and it also
 * defaults to on when the bot itself runs with `DEBUG=true`. It is off in
 * normal production runs so the log stays readable.
 *
 * Nothing secret is logged: message bodies are truncated and stripped of
 * newlines, and every line still goes through `log.js`, which redacts the bot
 * token, database passwords and other configured secrets.
 */

const log = require('./log.js');

const MAX_CONTENT = 80;
const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off'];

function parseFlag(value) {
	if (typeof value !== 'string') return undefined;
	const flag = value.trim().toLowerCase();
	if (TRUTHY.includes(flag)) return true;
	if (FALSY.includes(flag)) return false;
	return undefined;
}

/** Is tracing enabled? `COMMAND_DEBUG` wins, then DEBUG mode. */
function isEnabled(env = process.env) {
	const explicit = parseFlag(env.COMMAND_DEBUG);
	if (explicit !== undefined) return explicit;
	return parseFlag(env.DEBUG) === true;
}

/** Truncated, single-line, copy of a message body. Never a full transcript. */
function preview(content) {
	if (typeof content !== 'string') return '';
	const flat = content.replace(/\s+/g, ' ').trim();
	if (!flat) return '';
	return flat.length > MAX_CONTENT ? `${flat.slice(0, MAX_CONTENT)}…` : flat;
}

function where(msg) {
	if (!msg) return 'guild=? channel=?';
	const guild = msg.channel && msg.channel.guild ? msg.channel.guild.id : 'dm';
	const channel = msg.channel && msg.channel.id ? msg.channel.id : '?';
	return `guild=${guild} channel=${channel} author=${msg.author ? msg.author.id : '?'}`;
}

function formatFields(fields) {
	const parts = [];
	for (const key of Object.keys(fields || {})) {
		const value = fields[key];
		if (value === undefined || value === null || value === '') continue;
		parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
	}
	return parts.length ? ` — ${parts.join(' ')}` : '';
}

/**
 * Emit one pipeline line. `stage` is a stable token such as
 * `message_received` or `rejected`; `fields` are plain key/value diagnostics.
 */
function trace(stage, fields) {
	if (!isEnabled()) return;
	log.info(`[CMD] ${stage}${formatFields(fields)}`);
}

/** Report a dropped message and the exact reason it was dropped. */
function rejected(reason, msg, extra) {
	trace('rejected', Object.assign({ reason, at: where(msg) }, extra));
}

/** A message that reached the command pipeline (author is not a bot). */
function received(msg) {
	trace('message_received', {
		at: where(msg),
		chars: msg && typeof msg.content === 'string' ? msg.content.length : 0,
		content: preview(msg && msg.content),
	});
}

/** The prefix matched and the command word was isolated. */
function matched(msg, prefix, source, command) {
	trace('prefix_matched', { at: where(msg), prefix, source, command });
}

/** The command word matched a registered command (or did not). */
function parsed(msg, command, registered, alias) {
	trace('command_parsed', {
		at: where(msg),
		command,
		registered: !!registered,
		alias: alias || undefined,
	});
}

/** The command ran (or was refused by a gate). */
function executed(msg, command, extra) {
	trace('command_executed', Object.assign({ at: where(msg), command }, extra));
}

module.exports = { isEnabled, trace, rejected, received, matched, parsed, executed, preview };
