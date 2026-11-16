/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Central error handling and process lifecycle.
 *
 * A single failed command must never take down a cluster. Asynchronous entry
 * points are wrapped here so rejections are logged with context and swallowed,
 * while genuinely fatal conditions (uncaught exception) flush resources and exit
 * so the sharder can respawn a clean process.
 */

const log = require('./log.js');
const config = require('./config.js');

const shutdownHooks = [];
let shuttingDown = false;
let rejectionCount = 0;
let lastRejectionLog = [];

exports.describe = function (err) {
	if (!err) return { name: 'UnknownError', message: 'unknown error' };
	const name = err.name || err.constructor?.name || 'Error';
	const message = err.message || String(err);
	const code = err.code || err.status || err.statusCode;
	const out = { name, message };
	if (code !== undefined) out.code = code;
	if (config.debug && err.stack) out.stack = err.stack;
	return out;
};

/**
 * Transient failures are expected during normal operation (Discord hiccups,
 * Redis reconnects, restarts). They are logged at warn level instead of error
 * so real defects stay visible.
 */
const TRANSIENT_CODES = new Set([
	'ECONNRESET',
	'ETIMEDOUT',
	'EPIPE',
	'EAI_AGAIN',
	'ENOTFOUND',
	'ECONNREFUSED',
	'PROTOCOL_CONNECTION_LOST',
	'ER_CON_COUNT_ERROR',
	'ER_LOCK_WAIT_TIMEOUT',
	'50013', // Missing Permissions
	'50001', // Missing Access
	'10013', // Unknown User
	'10008', // Unknown Message
]);

exports.isTransient = function (err) {
	if (!err) return false;
	const code = err.code ?? err.status ?? err.httpStatus;
	if (code !== undefined && TRANSIENT_CODES.has(String(code))) return true;
	const message = String(err.message || '');
	return /Unknown Member|Unknown Message|Missing (Permissions|Access)|rate limit/i.test(message);
};

exports.logFailure = function (err, meta = {}) {
	const detail = exports.describe(err);
	const context = Object.entries(meta)
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => `${key}=${value}`)
		.join(' ');
	const transient = exports.isTransient(err);
	const line = `${context ? context + ' ' : ''}error=${detail.name}: ${detail.message}`;
	if (transient) log.warn(`handled (transient) ${line}`);
	else log.error(`handled ${line}`);
	if (detail.stack && !transient) log.debug(detail.stack);
	return detail;
};

/**
 * Wraps an async function so a rejection is logged and contained.
 */
exports.wrapAsync = function (fn, meta = {}) {
	return async function wrapped(...args) {
		try {
			return await fn.apply(this, args);
		} catch (err) {
			exports.logFailure(err, typeof meta === 'function' ? meta(...args) : meta);
			return undefined;
		}
	};
};

/**
 * Runs a command body with a single error response per invocation.
 */
exports.runCommandSafely = async function (p, fn) {
	try {
		return await fn();
	} catch (err) {
		exports.logFailure(err, { command: p?.command, user: p?.msg?.author?.id });
		if (p && !p.__errorReported) {
			p.__errorReported = true;
			try {
				await p.errorMsg(', something went wrong while running that command. :c', 4000);
			} catch (replyError) {
				exports.logFailure(replyError, { command: p?.command, stage: 'error-reply' });
			}
		}
		return undefined;
	}
};

exports.registerShutdownHook = function (fn) {
	if (typeof fn === 'function') shutdownHooks.push(fn);
};

exports.isShuttingDown = () => shuttingDown;

exports.runShutdown = async function (reason, code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	log.warn(`shutdown requested (${reason})`);
	for (const hook of shutdownHooks) {
		try {
			await Promise.race([
				Promise.resolve(hook(reason)),
				new Promise((resolve) => setTimeout(resolve, 5000)),
			]);
		} catch (err) {
			log.warn('shutdown hook failed:', err.message);
		}
	}
	log.info(`shutdown complete (${reason})`);
	process.exit(code);
};

exports.installProcessHandlers = function (options = {}) {
	if (global.__owoProcessHandlers) return;
	global.__owoProcessHandlers = true;

	process.on('unhandledRejection', (reason) => {
		const key = exports.describe(reason).message;
		rejectionCount++;
		const now = Date.now();
		lastRejectionLog = lastRejectionLog.filter((entry) => now - entry.at < 60000);
		const duplicate = lastRejectionLog.find((entry) => entry.key === key);
		if (duplicate) {
			duplicate.hits++;
			return;
		}
		lastRejectionLog.push({ key, at: now, hits: 1 });
		log.error('unhandledRejection:', reason);
	});

	process.on('uncaughtException', (err) => {
		log.error('uncaughtException:', err);
		if (config.exitOnFatal) {
			// Flush what we can and let the sharder supervise a clean restart
			exports.runShutdown('uncaughtException', 1);
		} else {
			log.warn('EXIT_ON_FATAL=false: continuing after uncaughtException');
		}
	});

	process.on('SIGTERM', () => exports.runShutdown('SIGTERM', 0));
	process.on('SIGINT', () => exports.runShutdown('SIGINT', 0));

	if (options.onSignal) {
		exports.registerShutdownHook(options.onSignal);
	}
};

exports.getStats = () => ({ rejectionCount });
