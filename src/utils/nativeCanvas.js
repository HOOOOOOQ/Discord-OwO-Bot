/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Optional access to the native `canvas` module.
 *
 * `canvas` needs cairo/pango/libjpeg at build time. Hosts that cannot build it
 * (a Pterodactyl server on a plain Node image, for example) simply skip it,
 * because the dependency is optional in package.json. Every caller goes through
 * this module so a missing module degrades to "memegen disabled" instead of
 * throwing while the command registry is being loaded.
 */

const log = require('./log.js');

let attempted = false;
let canvas = null;

/**
 * @param {Function} [loader] test hook to inject a failing/succeeding loader
 * @returns {object|null} the canvas module, or null when it is unavailable
 */
exports.load = function (loader) {
	if (typeof loader === 'function') {
		try {
			return loader();
		} catch (err) {
			return null;
		}
	}
	if (!attempted) {
		attempted = true;
		try {
			canvas = require('canvas');
		} catch (err) {
			canvas = null;
			// Only the first line: require() stacks are long and add no value here.
			const reason = String(err.message || err).split('\n')[0];
			log.warn(`canvas module is not available; memegen commands are disabled (${reason})`);
		}
	}
	return canvas;
};

exports.isAvailable = function () {
	return exports.load() !== null;
};
