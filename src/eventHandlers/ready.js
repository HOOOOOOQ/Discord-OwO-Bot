/*
 * OwO Bot for Discord
 * Copyright (C) 2024 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

// Fired when all shards turn ready
const log = require('../utils/log.js');
const presence = require('../utils/presence.js');

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
	const users = bot.users ? bot.users.size : 0;

	// Presence first: this is the "green dot" a self-hoster looks for in Discord.
	const applied = presence.apply(bot, {
		counts: { guilds, users, shards: bot.shards ? bot.shards.size : 1, prefix: this.prefix },
	});

	// Readiness marker: readers (Docker healthcheck, Pterodactyl startup
	// detection, scripts/healthcheck.js) look for "bot ready" to know the bot is
	// actually connected.
	log.info(
		`bot ready: ${tag} in ${guilds} guild(s), shard ${this.global.getShardString()} — ONLINE ` +
			`(status ${applied.status}, ${presence.describe(applied.activity)})`
	);
	log.info(
		'Bot is online. Commands accept the prefix "' +
			this.prefix +
			'" (try "' +
			this.prefix +
			'help")'
	);

	if (this.debug) {
		log.warn('bot ready: DEBUG mode is on — only DEBUG_WHITELIST guilds are answered');
	}
	if (guilds === 0) {
		log.warn(
			'bot ready: the bot is in no guild — invite it with ' +
				'https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=8'
		);
	}

	// Keeps {guilds}/{users} templates fresh; no-op unless BOT_PRESENCE_REFRESH_SEC>0.
	if (!this.__presenceRefresh) this.__presenceRefresh = presence.startRefresh(this);
};
