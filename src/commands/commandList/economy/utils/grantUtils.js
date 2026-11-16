/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Pure parsing/validation helpers for the `grant` command (adding cowoncy to a
 * user). Kept free of Discord/DB access so the rules can be unit tested.
 */

// `<@123>`, `<@!123>` or a bare snowflake
const TARGET_PATTERN = /^(?:<@!?)?(\d{17,20})>?$/;
const DIGITS = /^\d+$/;

exports.parseTargetId = function (arg) {
	if (typeof arg !== 'string') return null;
	const match = arg.trim().match(TARGET_PATTERN);
	return match ? match[1] : null;
};

/** Accepts only positive whole numbers written with digits (no `1e9`, no `10.5`). */
exports.parseAmount = function (arg) {
	if (arg === undefined || arg === null) return null;
	const text = String(arg).trim();
	if (!DIGITS.test(text)) return null;
	const amount = Number(text);
	return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};

/**
 * Validates a parsed grant request against the configured cap.
 * @returns {{ok: true, amount: number} | {ok: false, error: string, limit?: number}}
 */
exports.validateGrant = function (targetId, amount, max) {
	if (!targetId) return { ok: false, error: 'invalid-user' };
	if (amount === null || amount === undefined) return { ok: false, error: 'invalid-amount' };
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return { ok: false, error: 'invalid-amount' };
	}
	const limit = Number.isSafeInteger(max) && max > 0 ? max : 0;
	if (limit && amount > limit) return { ok: false, error: 'amount-too-large', limit };
	return { ok: true, amount };
};
