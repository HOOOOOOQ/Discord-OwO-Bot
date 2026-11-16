/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Structured logger.
 *
 * All log output goes through this module so every line carries a timestamp,
 * a severity level and the cluster/shard identity. Output is passed through a
 * redactor so bot tokens, database passwords and other secrets can never leak
 * into logs or into an `eval` response.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL_NAMES = ['error', 'warn', 'info', 'debug'];

// Values that must never appear in a log line or command output
const SECRET_ENV_PATTERN = /(TOKEN|PASS|PASSWORD|SECRET|API_KEY|APIKEY|CLIENT_SECRET|_KEY)$/i;
const SECRET_VALUE_MIN_LENGTH = 6;
// Discord bot tokens (three base64url parts separated by dots)
const DISCORD_TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g;
const REDACTED = '[REDACTED]';

let currentLevel = LEVELS.info;
let identity = 'cluster:?';

function parseLevel(value) {
	if (typeof value !== 'string') return undefined;
	const level = value.trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(LEVELS, level) ? LEVELS[level] : undefined;
}

function secretValues() {
	const values = [];
	for (const key of Object.keys(process.env)) {
		if (!SECRET_ENV_PATTERN.test(key)) continue;
		const value = process.env[key];
		if (typeof value === 'string' && value.length >= SECRET_VALUE_MIN_LENGTH) {
			values.push(value);
		}
	}
	// Longest first so a secret is not partially replaced by a shorter one
	return values.sort((a, b) => b.length - a.length);
}

function redact(input) {
	if (input === undefined || input === null) return input;
	let text = typeof input === 'string' ? input : String(input);
	for (const secret of secretValues()) {
		if (text.includes(secret)) text = text.split(secret).join(REDACTED);
	}
	return text.replace(DISCORD_TOKEN_PATTERN, REDACTED);
}

function stringify(value) {
	if (value instanceof Error) return value.stack || value.message;
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch (err) {
		return String(value);
	}
}

function formatArgs(args) {
	return args.map((arg) => redact(stringify(arg))).join(' ');
}

function write(level, scope, args) {
	if (LEVELS[level] > currentLevel) return;
	const time = new Date().toISOString();
	const prefix = `${time} ${level.toUpperCase().padEnd(5)} [${identity}]${
		scope ? ` [${scope}]` : ''
	}`;
	const line = `${prefix} ${formatArgs(args)}`;
	// Use the original console methods so installing the bridge cannot recurse
	const target = level === 'error' ? originalError : level === 'warn' ? originalWarn : originalLog;
	target.call(console, line);
}

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

exports.configure = function (options = {}) {
	const level = parseLevel(options.level || process.env.LOG_LEVEL);
	if (level !== undefined) currentLevel = level;
	else currentLevel = options.debug ? LEVELS.debug : LEVELS.info;
	if (options.identity) identity = options.identity;
};

exports.setIdentity = function (value) {
	identity = value ? String(value) : 'cluster:?';
};

exports.getLevel = function () {
	return LEVEL_NAMES[currentLevel];
};

function scopeLogger(scope, args) {
	write(scope.level, scope.name, args);
}

exports.create = function (scope) {
	const logger = {
		error: (...args) => write('error', scope, args),
		warn: (...args) => write('warn', scope, args),
		info: (...args) => write('info', scope, args),
		debug: (...args) => write('debug', scope, args),
	};
	return logger;
};

exports.error = (...args) => scopeLogger({ level: 'error', name: null }, args);
exports.warn = (...args) => scopeLogger({ level: 'warn', name: null }, args);
exports.info = (...args) => scopeLogger({ level: 'info', name: null }, args);
exports.debug = (...args) => scopeLogger({ level: 'debug', name: null }, args);

exports.redact = redact;

/**
 * Routes the legacy `console.*` call sites (188 of them) through the structured
 * logger. Kept as a small bridge so existing log content and its call sites do
 * not have to be rewritten at once, while still gaining severity, timestamp,
 * cluster identity and secret redaction.
 */
exports.installConsoleBridge = function () {
	if (console.__owoBridged) return;
	console.log = (...args) => write('info', null, args);
	console.info = (...args) => write('info', null, args);
	console.warn = (...args) => write('warn', null, args);
	console.error = (...args) => write('error', null, args);
	console.debug = (...args) => write('debug', null, args);
	Object.defineProperty(console, '__owoBridged', { value: true, enumerable: false });
};

exports.LEVELS = LEVELS;
