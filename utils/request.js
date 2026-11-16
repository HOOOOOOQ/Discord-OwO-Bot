/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const request = require('../src/utils/http.js');

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.HTTP_TIMEOUT_MS, 10) || 15000;

exports.fetchInit = function () {
	return new Promise((resolve, reject) => {
		const base = process.env.SHARDER_HOST;
		if (!base) {
			reject(new Error('SHARDER_HOST is not configured'));
			return;
		}
		const url = `${base}/sharder-info/${process.env.SHARDER_SERVER}`;
		request.get(url, { timeout: DEFAULT_TIMEOUT_MS }, (err, res, body) => {
			if (err) return reject(err);
			if (res.statusCode == 200) {
				try {
					resolve(JSON.parse(body));
				} catch (parseError) {
					reject(new Error('Sharder server returned invalid JSON'));
				}
			} else {
				reject(new Error(`Sharder server responded with HTTP ${res.statusCode}`));
			}
		});
	});
};
