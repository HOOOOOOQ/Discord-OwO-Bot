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
	// Readiness marker: readers (Docker healthcheck, Pterodactyl startup
	// detection) look for this line to know the bot is actually connected.
	log.info('bot ready: all shards connected');
};
