/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const log = require('../utils/log.js');
const gatewayCodes = require('../utils/gatewayCodes.js');

// Fired when a shard disconnects
exports.handle = function (error, id) {
	const code = error && error.code;
	log.error(`[shard ${id}] disconnected: ${gatewayCodes.describe(code)}`);
	if (code === 4014) {
		log.error(
			`[shard ${id}] MESSAGE CONTENT INTENT is requested but disabled in the Developer Portal. ` +
				'Enable it (Bot → Privileged Gateway Intents) or set ERIS_MESSAGE_CONTENT=off, then restart.'
		);
	} else if (code === 4004) {
		log.error(
			`[shard ${id}] BOT_TOKEN is invalid or revoked; the bot will never come online until it is replaced.`
		);
	}
	this.logger.logstashQos('shardDisconnect');
};
