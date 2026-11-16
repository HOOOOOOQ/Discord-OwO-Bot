/*
 * OwO Bot for Discord
 * Copyright (C) 2023 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Guard rails around the owner-only dynamic evaluation commands.
 *
 * `eval` remains the same mechanism the project always used, but it is now:
 *  - disabled unless ALLOW_EVAL=true,
 *  - only reachable for ids listed in OWNER_IDS,
 *  - executed with require/process/module/Buffer shadowed so accidental
 *    `require('fs')` or token reads fail instead of succeeding,
 *  - audited, and
 *  - passed through the secret redactor before anything is sent to Discord.
 *
 * This is mitigation, not a security boundary: JavaScript cannot sandbox
 * itself. The real control is that the feature is off by default.
 */

const config = require('./config.js');
const log = require('./log.js');

const MAX_OUTPUT = 1800;

exports.isEnabled = () => config.evalEnabled === true;

exports.formatResult = function (result) {
	let text;
	try {
		if (result === undefined) text = 'undefined';
		else if (result instanceof Error) text = `${result.name}: ${result.message}`;
		else if (typeof result === 'string') text = result;
		else text = JSON.stringify(result, null, 2);
	} catch (err) {
		text = String(result);
	}
	if (typeof text !== 'string') text = String(text);
	text = log.redact(text);
	if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}…(truncated)`;
	return '```js\n' + text + '\n```';
};

/* eslint-disable no-unused-vars */
function evaluate(js, context) {
	// Shadowing these identifiers inside the evaluation scope blocks the most
	// common accidents (reading the bot token, requiring fs, touching the
	// module cache). Runtime escapes via the Function constructor still exist.
	const require = undefined;
	const process = undefined;
	const module = undefined;
	const exports = undefined;
	const Buffer = undefined;
	const globalThis = undefined;
	const global = undefined;
	return function () {
		return eval(js);
	}.call(context);
}
/* eslint-enable no-unused-vars */

exports.run = function (js, context) {
	if (!exports.isEnabled()) {
		throw new Error('eval is disabled (set ALLOW_EVAL=true to enable)');
	}
	return evaluate(js, context);
};
