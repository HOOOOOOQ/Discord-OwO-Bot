/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Compatibility replacement for the `urban-dictionary` npm package, which was
 * unpublished from the registry on 2023-12-15 and made `npm ci` fail with E404.
 *
 * The callback contract of `ud.define(word, cb)` is preserved: cb(error, entries)
 * where every entry exposes `definition`, `example` and `permalink`, which is
 * exactly what the `define` command renders.
 */

const request = require('./http.js');
const log = require('./log.js');

const API_URL = process.env.URBAN_DICTIONARY_URL || 'https://api.urbandictionary.com/v0/define';
const TIMEOUT_MS = Number.parseInt(process.env.URBAN_DICTIONARY_TIMEOUT_MS, 10) || 8000;

function normalizeEntry(entry) {
	return {
		word: entry.word || '',
		definition: entry.definition || '',
		example: entry.example || '',
		permalink: entry.permalink || '',
		thumbsUp: entry.thumbs_up ?? 0,
		thumbsDown: entry.thumbs_down ?? 0,
		author: entry.author || '',
		writtenOn: entry.written_on || '',
	};
}

exports.define = function (word, callback) {
	const cb = typeof callback === 'function' ? callback : () => {};
	const term = String(word || '').trim();
	if (!term) {
		cb(new Error('word is required'));
		return;
	}

	const url = `${API_URL}?term=${encodeURIComponent(term)}`;
	request({ url, method: 'GET', json: true, timeout: TIMEOUT_MS }, (err, response, body) => {
		if (err) {
			log.warn(`urban-dictionary: request failed (${err.code || err.name})`);
			return cb(err);
		}
		if (!response || response.statusCode < 200 || response.statusCode >= 300) {
			return cb(new Error(`urban-dictionary responded with HTTP ${response?.statusCode}`));
		}
		const list = Array.isArray(body?.list) ? body.list : [];
		if (list.length === 0) {
			const notFound = new Error('No definition found');
			notFound.code = 'NOT_FOUND';
			return cb(notFound);
		}
		return cb(null, list.map(normalizeEntry));
	});
};

exports.normalizeEntry = normalizeEntry;
