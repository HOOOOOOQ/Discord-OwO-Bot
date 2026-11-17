/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const requireDir = require('require-dir');
const dir = requireDir('./');
const errors = require('../utils/errors.js');
const readyState = require('../utils/readyState.js');

class EventHandler {
	constructor(main) {
		this.main = main;
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

	/**
	 * eris-sharder instantiates src/owo.js from *inside* the client's own
	 * `ready` listener (`bot.once("ready", () => this.loadCode(bot))`), so this
	 * class is built after the event already fired: the ready listeners below
	 * would never run on the first connect, which means no presence (eris
	 * identifies as "offline"), no `bot ready` marker and no health line.
	 *
	 * Replaying the handler once right after binding keeps the normal event flow
	 * for later reconnects while making the first boot behave correctly.
	 */
	replayReady() {
		if (!readyState.needsReplay(this.main, this.main && this.main.bot)) return false;
		const handler = dir['ready'] && dir['ready'].handle;
		if (typeof handler !== 'function') return false;
		readyState.markReplayed(this.main);
		const wrapped = errors.wrapAsync(handler.bind(this.main), {
			stage: 'event',
			event: 'ready',
			replayed: true,
		});
		wrapped();
		return true;
	}
}

module.exports = EventHandler;
