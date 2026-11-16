/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * weeb.sh client.
 *
 * The `weeb.js` package (which pulled in the deprecated `request` library, and
 * with it a critical SSRF advisory) is replaced by two direct API calls that
 * keep the same public surface: grab() and getTypes().
 */

const request = require('./http.js');
const log = require('./log.js');

const BASE_URL = process.env.WEEBSH_URL || 'https://api.weeb.sh';
const TIMEOUT_MS = Number.parseInt(process.env.WEEBSH_TIMEOUT_MS, 10) || 10000;

function authHeaders() {
	return {
		Authorization: 'Wolke ' + (process.env.WEEBSH_TOKEN || ''),
		'User-Agent': 'owo/1.0',
	};
}

function fetchRandom(type, nsfw, filetype) {
	return new Promise((resolve, reject) => {
		const query = new URLSearchParams({ type, filetype });
		if (nsfw) query.append('nsfw', nsfw);
		request.get(
			`${BASE_URL}/images/random?${query.toString()}`,
			{ headers: authHeaders(), json: true, timeout: TIMEOUT_MS },
			(err, response, body) => {
				if (err) return reject(err);
				if (!response || response.statusCode !== 200 || !body?.url) {
					return reject(new Error(`weeb.sh responded with HTTP ${response?.statusCode}`));
				}
				resolve(body);
			}
		);
	});
}

function fetchTypes() {
	return new Promise((resolve, reject) => {
		request.get(
			`${BASE_URL}/images/types`,
			{ headers: authHeaders(), json: true, timeout: TIMEOUT_MS },
			(err, response, body) => {
				if (err) return reject(err);
				if (!response || response.statusCode !== 200) {
					return reject(new Error(`weeb.sh responded with HTTP ${response?.statusCode}`));
				}
				resolve(Array.isArray(body?.types) ? body.types : []);
			}
		);
	});
}

/**
 * Gets an image from weeb.sh
 */
exports.grab = function (p, ptype, ftype, text, notsfw, retry) {
	ftype = ftype.toLowerCase();
	ptype = ptype.toLowerCase();
	let nsfwt = false;
	let retryt = true;
	if (typeof notsfw == 'boolean' && notsfw) nsfwt = 'only';
	if (retryt && typeof retry == 'boolean') retryt = retry;

	fetchRandom(ptype, nsfwt, ftype)
		.then((array) => {
			if (!array) {
				return;
			}
			let embed = {
				color: p.config.embed_color,
				image: {
					url: array.url,
				},
				author: {
					name: text,
					url: array.url,
					icon_url: p.msg.author.avatarURL,
				},
			};

			p.send({ embed });
		})
		.catch((err) => {
			log.debug(`weeb.sh lookup failed for type=${ptype}: ${err.message}`);
			if (retryt && (ftype == 'jpg' || ftype == 'png')) {
				exports.grab(p, ptype, ftype == 'jpg' ? 'png' : 'jpg', text, notsfw, false);
			} else
				p.errorMsg(
					", I couldn't find that image type! :c\nType `o help gif` for the list of types!",
					3000
				);
		});
};

/**
 * Lists all weeb.sh types
 */
exports.getTypes = function (p) {
	fetchTypes()
		.then((array) => {
			var txt = 'Available Image Types:\n';
			for (var i = 0; i < array.length; i++) txt += '`' + array[i] + '`, ';
			txt += '`nsfw`';
			txt += '\n*Some types will not work on pic*';
			p.send(txt);
		})
		.catch((err) => {
			log.warn('weeb.sh types lookup failed:', err.message);
			p.errorMsg(", I couldn't reach the image service right now. :c", 3000);
		});
};
