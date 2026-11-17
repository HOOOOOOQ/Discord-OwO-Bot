/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Safe stand-in for the private `tokens/macro.js` / `secret/macro.js` module.
 *
 * The macro module is OwO's anti-macro/captcha layer. Its real implementation is
 * not part of the public checkout, and `src/owo.js` used to `require()` it
 * without a last-resort fallback: a deployment without the file crashed the
 * cluster the moment it loaded (i.e. right after the gateway READY), which looks
 * exactly like "bot online for a second, then permanently offline".
 *
 * This module exposes the same API and keeps the bot functional. It does NOT
 * pretend to detect macros: `check()`/`levelCheck()` return true (allow) and the
 * captcha helpers are no-ops. When it is in use the bot logs a prominent
 * warning, so nobody mistakes a degraded anti-abuse layer for a working one.
 */

exports.name = 'macroFallback';

exports.isFallback = true;

// Checks for macros — allow everything.
exports.check = async function () {
	return true;
};

// Generates HB image buffers — nothing to generate without the real module.
exports.generateBuffer = async function () {};

// Verifies captcha from DMs — no captcha challenges are issued.
exports.verify = async function () {};

// Binds needed files to macro.js.
exports.bind = function () {};

// Binds level check files.
exports.initLevelCheck = function () {};

// Check for xp macros — allow.
exports.levelCheck = function () {
	return true;
};
