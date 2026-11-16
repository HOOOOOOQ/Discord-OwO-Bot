/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Human readable explanations for gateway close codes.
 *
 * Raw numbers on the panel console (`Bot Disconnected 4014`) tell a self-hoster
 * nothing, so every disconnect/error log line spells out what to fix.
 */

const CODES = {
	1000: 'normal closure',
	4000: 'unknown error (try reconnecting)',
	4001: 'unknown opcode — the client sent an invalid gateway op',
	4002: 'decode error — the client sent an invalid payload',
	4003: 'not authenticated — identify before sending packets',
	4004: 'authentication failed — BOT_TOKEN is invalid, revoked or for another application',
	4005: 'already authenticated — identify was sent twice',
	4007: 'invalid sequence number',
	4008: 'rate limited by the gateway — too many identifies, wait a few minutes',
	4009: 'session timed out — normal after long network outages',
	4010: 'invalid shard — check SHARDS / SHARD_FIRST / SHARD_LAST',
	4011: 'sharding required — this bot needs more than one shard',
	4012: 'invalid API version',
	4013: 'invalid intents — the requested intent bitmask is not valid',
	4014: 'disallowed intents — a privileged intent is requested but is NOT enabled in the Discord Developer Portal (Bot > Privileged Gateway Intents). Enable MESSAGE CONTENT INTENT, or set ERIS_MESSAGE_CONTENT=off',
};

function describe(code) {
	if (code === undefined || code === null) return 'no close code';
	const numeric = Number(code);
	const known = CODES[numeric];
	return known ? `${numeric} — ${known}` : `close code ${code}`;
}

function isFatalAuthCode(code) {
	const numeric = Number(code);
	return numeric === 4004 || numeric === 4013 || numeric === 4014;
}

module.exports = { CODES, describe, isFatalAuthCode };
