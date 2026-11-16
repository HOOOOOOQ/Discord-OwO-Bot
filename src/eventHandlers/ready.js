/*
 * OwO Bot for Discord
 * Copyright (C) 2024 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

// Fired when all shards turn ready
const log = require('../utils/log.js');

exports.handle = function () {
	this.logger.logstashQos('ready');
	const bot = this.bot || {};
	const user = bot.user;
	const tag = user
		? `${user.username}${
				user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : ''
		  }`
		: 'unknown user';
	const guilds = bot.guilds ? bot.guilds.size : 0;
	// Readiness marker: readers (Docker healthcheck, Pterodactyl startup
	// detection) look for this line to know the bot is actually connected.
	log.info(`bot ready: ${tag} in ${guilds} guild(s), shard ${this.global.getShardString()}`);
	if (this.debug) {
		log.warn('bot ready: DEBUG mode is on — only DEBUG_WHITELIST guilds are answered');
	}
	if (guilds === 0) {
		log.warn(
			'bot ready: the bot is in no guild — invite it with ' +
				'https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=8'
		);
	}
};
