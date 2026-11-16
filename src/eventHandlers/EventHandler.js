/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const requireDir = require('require-dir');
const dir = requireDir('./');
const errors = require('../utils/errors.js');

class EventHandler {
	constructor(main) {
		let filename = __filename.slice(__dirname.length + 1, -3);
		for (let listener in dir) {
			if (listener === filename) continue;
			const handler = dir[listener]?.handle;
			if (typeof handler !== 'function') continue;
			// Every gateway handler runs inside one safety net: a rejection is
			// logged with its event name and can never crash the cluster.
			main.bot.on(
				listener,
				errors.wrapAsync(handler.bind(main), { stage: 'event', event: listener })
			);
		}
	}
}

module.exports = EventHandler;
