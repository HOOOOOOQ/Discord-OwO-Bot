/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * In-process metric registry.
 *
 * The previous implementation silently dropped every metric (`return;` as the
 * first statement). This module keeps real counters in memory and exposes a
 * snapshot, and only forwards to StatsD/Datadog when METRICS_ENABLED=true and
 * the transport is reachable. Nothing here reports success when nothing was
 * actually sent.
 */

const log = require('./log.js');

const counters = new Map();
const timers = new Map();
let statsd = null;
let enabled = false;
let forwardErrors = 0;

exports.init = function (options = {}) {
	enabled = options.enabled === true;
	if (!enabled) return false;
	try {
		const StatsD = require('node-dogstatsd').StatsD;
		statsd = new StatsD(options.host, options.port);
		return true;
	} catch (err) {
		log.warn(
			'metrics: StatsD transport unavailable, keeping in-process counters only:',
			err.message
		);
		statsd = null;
		return false;
	}
};

exports.isEnabled = () => enabled;

exports.increment = function (name, amount = 1, tags = {}) {
	counters.set(name, (counters.get(name) || 0) + amount);
	if (statsd) {
		try {
			statsd.increment(name, tags);
		} catch (err) {
			forwardErrors++;
			if (forwardErrors === 1) log.warn('metrics: failed to forward metric', err.message);
		}
	}
};

exports.decrement = function (name, amount = 1, tags = {}) {
	exports.increment(name, -amount, tags);
};

exports.timing = function (name, durationMs) {
	const timer = timers.get(name) || { count: 0, total: 0, max: 0 };
	timer.count++;
	timer.total += durationMs;
	timer.max = Math.max(timer.max, durationMs);
	timers.set(name, timer);
	if (statsd) {
		try {
			statsd.histogram(name, durationMs);
		} catch (err) {
			forwardErrors++;
		}
	}
};

exports.snapshot = function () {
	const out = { counters: {}, timers: {} };
	for (const [key, value] of counters) out.counters[key] = value;
	for (const [key, value] of timers) {
		out.timers[key] = {
			count: value.count,
			avg: value.count ? Math.round(value.total / value.count) : 0,
			max: value.max,
		};
	}
	return out;
};

exports.reset = function () {
	counters.clear();
	timers.clear();
};
