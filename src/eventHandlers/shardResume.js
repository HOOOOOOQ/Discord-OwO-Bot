/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const log = require('../utils/log.js');
const presence = require('../utils/presence.js');

// Fired when a shard resumes
exports.handle = function (id) {
	log.info(`[shard ${id}] resumed`);
	this.logger.logstashQos('shardResume');
	// A resumed session does not replay the presence, so re-apply it here.
	const bot = this.bot;
	if (bot && bot.user) {
		presence.apply(bot, {
			counts: {
				guilds: bot.guilds.size,
				users: bot.users.size,
				shards: bot.shards.size,
				prefix: this.prefix,
			},
		});
	}
};
