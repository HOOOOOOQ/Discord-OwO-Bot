/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const levels = require('../utils/levels.js');
const errors = require('../utils/errors.js');
/* eslint-disable-next-line */
const blacklist = require('../utils/blacklist.js');
const survey = require('../utils/survey.js');
const trace = require('../utils/commandTrace.js');

// Fired when a message is created
exports.handle = async function (msg, raw) {
	// if (blacklist.checkBot(msg)) return;
	if (msg.author.bot) {
		trace.rejected('author_is_bot', msg);
		return;
	}

	trace.received(msg);

	// Every command reads or writes MongoDB (economy, cooldowns, prefix, quests).
	// The cluster starts its connection right after the gateway READY, so a message
	// that arrives during that window used to fail with `MONGODB_NOT_READY`. Wait
	// for the (retrying) connection instead of answering with an error.
	if (this.mongoReady) {
		try {
			await this.mongoReady;
		} catch (err) {
			trace.rejected('database_not_ready', msg, { reason: err.message });
			return;
		}
	}

	if (this.optOut[msg.author.id]) {
		trace.rejected('opted_out', msg);
		return;
	}
	if (this.pause) {
		trace.rejected('paused', msg);
		return;
	}

	const whitelist = this.config.debugWhitelist || [];
	if (this.debug && msg.channel.guild && !whitelist.includes(msg.channel.guild.id)) {
		/* Ignore guilds if in debug mode */
		trace.rejected('debug_whitelist', msg, { whitelist: whitelist.join(',') || 'none' });
		return;
	}
	if (await this.command.executeAdmin(msg, raw)) {
		return;

		// no guild, its a dm
	} else if (!msg.channel.guild) {
		if (await this.macro.verify(msg, msg.content.trim())) {
			survey.handle.bind(this)(msg);
		}
	} else {
		// Awaited and contained: dispatch and XP bookkeeping are both async and
		// used to run as floating promises, so any failure became an unhandled
		// rejection that killed the cluster.
		await this.command.execute(msg, raw);
		await errors
			.wrapAsync(levels.giveXP, { stage: 'levels' })(msg)
			.catch((err) => errors.logFailure(err, { stage: 'levels' }));
	}
};
