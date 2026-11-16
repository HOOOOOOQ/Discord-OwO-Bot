/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Minimal `request`-compatible HTTP client built on the global fetch API.
 *
 * The `request` package has been deprecated since 2020 and carries a critical
 * SSRF advisory (CVE-2023-28155 and friends). It was used in 24 files, all of
 * them with the same small option surface: method, uri/url, json, body, headers,
 * encoding:null for binary responses, and a (err, response, body) callback.
 * This shim keeps that contract so call sites stay untouched, while adding a
 * hard timeout so a hung upstream can never stall a cluster.
 */

const log = require('./log.js');

const DEFAULT_TIMEOUT = Number.parseInt(process.env.HTTP_TIMEOUT_MS, 10) || 15000;
const USER_AGENT = 'owo-bot (+https://github.com/ChristopherBThai/Discord-OwO-Bot)';

function buildUrl(options) {
	let url = options.uri || options.url;
	if (typeof url !== 'string') throw new TypeError('http: missing url/uri');
	if (options.qs && typeof options.qs === 'object') {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(options.qs)) {
			if (value !== undefined && value !== null) search.append(key, value);
		}
		const query = search.toString();
		if (query) url += (url.includes('?') ? '&' : '?') + query;
	}
	return url;
}

function encodeForm(form) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(form)) {
		if (value !== undefined && value !== null) search.append(key, value);
	}
	return search.toString();
}

async function perform(options) {
	const url = buildUrl(options);
	const method = (options.method || 'GET').toUpperCase();
	const headers = { 'user-agent': USER_AGENT, ...(options.headers || {}) };
	let body;

	if (options.json && options.body !== undefined && options.body !== null) {
		body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
		headers['content-type'] = headers['content-type'] || 'application/json';
	} else if (options.form && typeof options.form === 'object') {
		body = encodeForm(options.form);
		headers['content-type'] = 'application/x-www-form-urlencoded';
	} else if (options.body !== undefined && options.body !== null) {
		body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
		if (!headers['content-type'] && typeof body === 'string' && body.startsWith('{')) {
			headers['content-type'] = 'application/json';
		}
	}

	const timeoutMs = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, { method, headers, body, signal: controller.signal });
		const buffer = Buffer.from(await response.arrayBuffer());
		let parsed = buffer.toString('utf8');

		if (options.json) {
			if (parsed.length === 0) parsed = null;
			else {
				try {
					parsed = JSON.parse(parsed);
				} catch (err) {
					log.debug(`http: response from ${url} was not valid JSON`);
				}
			}
		} else if (options.encoding === null) {
			parsed = buffer;
		}

		const responseHeaders = {};
		for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;

		return {
			statusCode: response.status,
			status: response.status,
			statusMessage: response.statusText,
			headers: responseHeaders,
			body: parsed,
		};
	} catch (err) {
		if (err.name === 'AbortError') {
			const timeoutError = new Error(`http: request to ${url} timed out after ${timeoutMs}ms`);
			timeoutError.code = 'ETIMEDOUT';
			throw timeoutError;
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function createRequest(defaults = {}) {
	function requestClient(optionsOrUrl, callback) {
		const options =
			typeof optionsOrUrl === 'string'
				? { ...defaults, url: optionsOrUrl }
				: { ...defaults, ...optionsOrUrl };
		const cb = typeof callback === 'function' ? callback : () => {};
		const controller = new AbortController();
		let finished = false;

		const finish = (err, response, body) => {
			if (finished) return;
			finished = true;
			try {
				cb(err, response, body);
			} catch (callbackError) {
				log.error('http: request callback threw:', callbackError);
			}
		};

		perform(options)
			.then((response) => finish(null, response, response.body))
			.catch((err) => finish(err));

		return {
			abort() {
				controller.abort();
			},
		};
	}

	// Supports both get(url, cb) and get(url, options, cb)
	function method(methodName) {
		return function requestWithMethod(url, optionsOrCallback, maybeCallback) {
			const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback || {};
			const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
			return requestClient({ ...options, url, method: methodName }, callback);
		};
	}

	requestClient.get = method('GET');
	requestClient.post = method('POST');
	requestClient.put = method('PUT');
	requestClient.delete = method('DELETE');
	requestClient.patch = method('PATCH');
	requestClient.defaults = (extra) => createRequest({ ...defaults, ...extra });

	return requestClient;
}

module.exports = createRequest();
module.exports.createRequest = createRequest;
module.exports.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;
