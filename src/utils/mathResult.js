/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Classification helper for `o math` failures.
 *
 * The command used to compare against the literal string
 * "Promise timed out after 1000 ms" while configuring a 3000ms budget, so the
 * timeout branch could never fire. Detection is now independent of the exact
 * wording and of the configured budget.
 */

const TIMEOUT_PATTERN = /timeout|timed out|terminated unexpectedly/i;

exports.classifyMathError = function (err) {
	if (!err) return 'invalid';
	if (err.code === 'WORKERPOOL_TIMEOUT' || err.name === 'TimeoutError') return 'timeout';
	return TIMEOUT_PATTERN.test(String(err.message || '')) ? 'timeout' : 'invalid';
};

exports.TIMEOUT_PATTERN = TIMEOUT_PATTERN;
