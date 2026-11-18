/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * MySQL value semantics on top of JavaScript values.
 *
 * The bot stores Discord snowflakes in `bigint(20) unsigned` columns. A JS
 * number cannot hold 1234567890123456789 exactly, so every integer column is
 * stored as a decimal **string** and compared with BigInt arithmetic. That is
 * the same thing the mysql driver does with `supportBigNumbers: true`, so the
 * command code that already handles ids as strings keeps working.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

const INTEGER_TYPES = new Set([
	'tinyint',
	'smallint',
	'mediumint',
	'int',
	'integer',
	'bigint',
	'bit',
]);
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'float', 'double', 'real']);
const STRING_TYPES = new Set([
	'varchar',
	'char',
	'text',
	'tinytext',
	'mediumtext',
	'longtext',
	'enum',
	'set',
	'json',
]);
const DATE_TYPES = new Set(['timestamp', 'datetime']);

function normalizeType(type) {
	if (!type) return '';
	return String(type).toLowerCase().replace(/\(.*$/, '').replace(/\s+/g, ' ').trim();
}

function isIntegerColumn(type) {
	return INTEGER_TYPES.has(normalizeType(type));
}

function isDecimalColumn(type) {
	return DECIMAL_TYPES.has(normalizeType(type));
}

function isStringColumn(type) {
	return STRING_TYPES.has(normalizeType(type));
}

function isDateColumn(type) {
	return DATE_TYPES.has(normalizeType(type));
}

/** `'123'`, `123`, `123n` → true; `'12.5'`, `true`, `null` → false. */
function isIntegerLike(value) {
	if (typeof value === 'bigint') return true;
	if (typeof value === 'number') return Number.isInteger(value);
	if (typeof value === 'string') return /^-?\d+$/.test(value.trim());
	return false;
}

function isNumericLike(value) {
	if (typeof value === 'bigint' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value === 'string') return value.trim() !== '' && !Number.isNaN(Number(value));
	return false;
}

function toBigInt(value) {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'boolean') return value ? 1n : 0n;
	if (typeof value === 'number') return BigInt(Math.trunc(value));
	return BigInt(String(value).trim());
}

/** Numbers when both sides are integers (exact), otherwise floats. */
function numericEqual(a, b) {
	if (isIntegerLike(a) && isIntegerLike(b)) return toBigInt(a) === toBigInt(b);
	return Number(a) === Number(b);
}

/** -1 / 0 / 1, MySQL style (numeric when both are numeric, else string order). */
function compare(a, b) {
	if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
	if (b === null || b === undefined) return 1;
	if (isNumericLike(a) && isNumericLike(b)) {
		if (isIntegerLike(a) && isIntegerLike(b)) {
			const x = toBigInt(a);
			const y = toBigInt(b);
			return x === y ? 0 : x < y ? -1 : 1;
		}
		const x = Number(a);
		const y = Number(b);
		return x === y ? 0 : x < y ? -1 : 1;
	}
	const x = String(a);
	const y = String(b);
	return x === y ? 0 : x < y ? -1 : 1;
}

function equal(a, b) {
	if (a === null || a === undefined || b === null || b === undefined) {
		return (a === null || a === undefined) && (b === null || b === undefined);
	}
	return compare(a, b) === 0;
}

/** Arithmetic that stays exact for integer operands (cowoncy, counts, ids). */
function arithmetic(op, a, b) {
	const x = a === null || a === undefined ? 0 : a;
	const y = b === null || b === undefined ? 0 : b;
	const bothIntegers = isIntegerLike(x) && isIntegerLike(y);
	if (bothIntegers) {
		const p = toBigInt(x);
		const q = toBigInt(y);
		switch (op) {
			case '+':
				return (p + q).toString();
			case '-':
				return (p - q).toString();
			case '*':
				return (p * q).toString();
			case '/':
				return Number(p) / Number(q);
			case '%':
				return q === 0n ? null : (p % q).toString();
			default:
				return null;
		}
	}
	const p = Number(x);
	const q = Number(y);
	switch (op) {
		case '+':
			return p + q;
		case '-':
			return p - q;
		case '*':
			return p * q;
		case '/':
			return q === 0 ? null : p / q;
		case '%':
			return q === 0 ? null : p % q;
		default:
			return null;
	}
}

/** MySQL `LIKE`: `%` = any run, `_` = one character. */
function likeToRegExp(pattern) {
	const escaped = String(pattern === null || pattern === undefined ? '' : pattern).replace(
		/[.*+?^${}()|[\]\\]/g,
		'\\$&'
	);
	const body = escaped.replace(/%/g, '.*').replace(/_/g, '.');
	return new RegExp(`^${body}$`, 'i');
}

function pad(n, width = 2) {
	return String(n).padStart(width, '0');
}

/** MySQL `NOW()` in UTC, `YYYY-MM-DD HH:mm:ss`. */
function nowString(date = new Date()) {
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
	);
}

/** Date-only string, used by the "expire by setting 2018-01-01" idiom. */
function todayString(date = new Date()) {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Any column value that should be understood as a point in time. MySQL accepts
 * `'2017-01-01 10:10:10'`, `'2017-01-01'`, `Date`, epoch milliseconds.
 */
function toDate(value) {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === 'number') {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	const text = String(value).trim();
	if (!text) return null;
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
		? `${text}T00:00:00.000Z`
		: text.replace(' ', 'T');
	const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
	const parsed = new Date(withZone);
	if (!Number.isNaN(parsed.getTime())) return parsed;
	const fallback = new Date(text);
	return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * TIMESTAMPDIFF(unit, a, b) with MySQL rounding: whole units that fit between
 * the two values, truncated towards zero.
 */
function timestampDiff(unit, from, to) {
	const a = toDate(from);
	const b = toDate(to);
	if (!a || !b) return null;
	const ms = b.getTime() - a.getTime();
	const sign = ms < 0 ? -1 : 1;
	const abs = Math.abs(ms);
	const u = String(unit || 'SECOND').toUpperCase();
	const map = {
		MICROSECOND: 1e-3,
		SECOND: 1000,
		MINUTE: 60000,
		HOUR: 3600000,
		DAY: 86400000,
		WEEK: 604800000,
	};
	if (u === 'MONTH' || u === 'QUARTER' || u === 'YEAR') {
		const months =
			(b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
		let result = months * sign;
		if (sign === 1 && b.getUTCDate() < a.getUTCDate()) result -= 1;
		if (sign === -1 && a.getUTCDate() < b.getUTCDate()) result += 1;
		if (u === 'QUARTER') return Math.trunc(result / 3);
		if (u === 'YEAR') return Math.trunc(result / 12);
		return result;
	}
	const divisor = map[u] || 1000;
	return Math.trunc(abs / divisor) * sign;
}

/** Coerce a JS value to what the column would store. */
function coerceForColumn(type, value) {
	const base = normalizeType(type);
	if (value === undefined || value === null) return null;
	if (isIntegerColumn(base)) {
		// Same representation the mysql driver used with `supportBigNumbers`:
		// a JS number while it is exact, a decimal string when it is not
		// (Discord snowflakes), so `money + 5` in the command code keeps working
		// and ids stay exact.
		let integer;
		if (typeof value === 'boolean') integer = value ? 1n : 0n;
		else if (typeof value === 'bigint') integer = value;
		else if (typeof value === 'number') {
			if (!Number.isFinite(value)) return null;
			integer = BigInt(Math.trunc(value));
		} else {
			const text = String(value).trim();
			if (text === '') return null;
			if (/^-?\d+$/.test(text)) integer = BigInt(text);
			else {
				const num = Number(text);
				if (!Number.isFinite(num)) return null;
				integer = BigInt(Math.trunc(num));
			}
		}
		if (integer <= MAX_SAFE && integer >= MIN_SAFE) return Number(integer);
		return integer.toString();
	}
	if (isDecimalColumn(base)) {
		const num = Number(value);
		return Number.isFinite(num) ? num : null;
	}
	if (isDateColumn(base)) {
		const date = toDate(value);
		if (!date) return typeof value === 'string' ? value : null;
		if (base === 'timestamp') return nowString(date);
		return nowString(date);
	}
	if (isStringColumn(base)) {
		if (value instanceof Date) return nowString(value);
		return String(value);
	}
	return value;
}

module.exports = {
	normalizeType,
	isIntegerColumn,
	isDecimalColumn,
	isStringColumn,
	isDateColumn,
	isIntegerLike,
	isNumericLike,
	toBigInt,
	numericEqual,
	compare,
	equal,
	arithmetic,
	likeToRegExp,
	nowString,
	todayString,
	toDate,
	timestampDiff,
	coerceForColumn,
};
