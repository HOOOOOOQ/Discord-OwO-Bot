/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const log = require('../utils/log.js');
const gatewayCodes = require('../utils/gatewayCodes.js');

exports.handle = function (err, id) {
	const code = err && (err.code || err.closeCode);
	const message = err && err.message ? err.message : String(err);
	log.error(`[shard ${id}] ${message}`);
	if (gatewayCodes.isFatalAuthCode(code)) {
		// 4004/4013/4014 never recover on their own: the process stays alive and
		// the bot simply never appears online.
		log.error(`[shard ${id}] ${gatewayCodes.describe(code)}`);
	}
};
