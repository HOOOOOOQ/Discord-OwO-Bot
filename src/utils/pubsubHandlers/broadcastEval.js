/*
 * OwO Bot for Discord
 * Copyright (C) 2023 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const sandbox = require('../sandbox.js');
const log = require('../log.js');

exports.handle = async function (main, message) {
	if (!sandbox.isEnabled()) {
		log.warn('broadcastEval ignored: ALLOW_EVAL is not enabled on this instance');
		return;
	}
	let payload;
	try {
		payload = JSON.parse(message);
	} catch (err) {
		log.warn('broadcastEval ignored: malformed payload');
		return;
	}
	const { js, channel } = payload || {};
	if (!js || !channel) return;
	const shardId = main.bot.shards.values().next().value.id;
	setTimeout(() => {
		let result;
		try {
			result = sandbox.run(js, main);
		} catch (err) {
			result = err;
		}
		// Redacted and capped by the sandbox formatter
		main.bot.createMessage(channel, sandbox.formatResult(result)).catch((err) => {
			log.warn('broadcastEval could not deliver its output:', err.message);
		});
	}, shardId * 500);
};
