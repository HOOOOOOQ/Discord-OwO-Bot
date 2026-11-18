/*
 * OwO Bot for Discord
 * Copyright (C) 2020 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */
const config = require('./config.js');
const global = require('./global.js');
const log = require('./log.js');
const metrics = require('./metrics.js');

/***** Datadog (optional — off unless configured) *****/
// This used to create a StatsD socket to localhost:9125 on every boot. StatsD
// is not part of the deployment any more, so the client is only built when the
// operator asks for it; otherwise the in-process counters (src/utils/metrics.js)
// are the only metrics backend.
var statsdClient = null;
if (String(process.env.METRICS_ENABLED || 'false').toLowerCase() === 'true') {
	try {
		var StatsD = require('node-dogstatsd').StatsD;
		statsdClient = new StatsD(process.env.STATSD_HOST || undefined);
	} catch (err) {
		log.warn('logger: StatsD client unavailable:', err.message);
	}
}

exports.increment = function (name, tags) {
	metrics.increment('owo.' + name, 1, tags || {});
	if (!statsdClient) return;
	statsdClient.increment('owo.' + name, tags);
};

exports.decrement = function (name, tags) {
	metrics.decrement('owo.' + name, 1, tags || {});
	if (!statsdClient) return;
	statsdClient.decrement('owo.' + name, tags);
};

exports.value = function (name, amount, tags) {
	if (amount > 0) exports.increment(name, tags);
	else if (amount < 0) exports.decrement(name, tags);
};

/***** winston *****/
/*
const winston = require('winston');
const logger = winston.createLogger({
	level:'verbose',
	transports:[new winston.transports.File({filename:'combined.log'})]
});

winstonLogger = {
	error:function(msg){msg.time=new Date();logger.error(msg)},
	warn:function(msg){msg.time=new Date();logger.warn(msg)},
	info:function(msg){msg.time=new Date();logger.info(msg)},
	verbose:function(msg){msg.time=new Date();logger.verbose(msg)},
	debug:function(msg){msg.time=new Date();logger.debug(msg)},
}

exports.log = winstonLogger;
*/

/***** StatsD (legacy sink, disabled) *****/
// The old client was constructed unconditionally against localhost:9125, i.e. a
// socket to 127.0.0.1 on every boot. Nothing in this deployment runs StatsD, and
// no datastore is allowed to point at loopback, so nothing is created here.

const incr = (exports.incr = function (name, amount = 1, tags = {}, msg) {
	/* eslint-disable-next-line */
	if (amount < 0) {
		decr(name, amount, tags, msg);
		return;
	}
	if (msg) {
		tags.user = msg.author.id;
		tags.channel = msg.channel.id;
		tags.guild = msg.channel.type == 1 ? 'dm' : msg.channel.guild.id;
	}
	metrics.increment(`${name}`, amount, tags);
	if (statsdClient) {
		try {
			statsdClient.increment(`${name}`, amount, tags);
		} catch (err) {
			log.debug('logger: statsd increment failed:', err.message);
		}
	}
});

const decr = (exports.decr = function (name, amount = -1, tags = {}, msg) {
	if (amount > 0) {
		incr(name, amount, tags, msg);
		return;
	}
	/* eslint-disable-next-line */
	if (amount > 0) {
		incr(name, amount, tags, msg);
		return;
	}
	if (msg) {
		tags.user = msg.author.id;
		tags.channel = msg.channel.id;
		tags.guild = msg.channel.type == 1 ? 'dm' : msg.channel.guild.id;
	}
	metrics.decrement(`${name}`, -amount, tags);
	if (statsdClient) {
		try {
			statsdClient.decrement(`${name}`, amount, tags);
		} catch (err) {
			log.debug('logger: statsd decrement failed:', err.message);
		}
	}
});

const request = require('./http.js');

// InfluxDB is an optional log sink of upstream OwO and is NOT part of this
// deployment (no InfluxDB, no extra service). Every logger below used to POST
// to `${INFLUXDB_HOST}/...` even when the variable was unset, which produced an
// HTTP request to "undefined/command" and the noisy
// "InfluxDB is inactive. Log upload will not work." warning on the first
// command. With no host configured the functions now return immediately.
const influxEnabled = () => Boolean(process.env.INFLUXDB_HOST);

// Only display this error once per 5 minutes
let influxErrorShown = false;
// unref() so a short-lived process (tests, --doctor, healthcheck) is never kept
// alive by this housekeeping timer.
const influxResetTimer = setTimeout(() => {
	influxErrorShown = false;
}, 5 * 60 * 60 * 1000);
if (typeof influxResetTimer.unref === 'function') influxResetTimer.unref();

/**
 * POST a log record to the optional InfluxDB sink.
 * No host configured → nothing happens (this is the normal self-hosted case).
 */
function postInflux(path, body, onError) {
	if (!influxEnabled()) return;
	body.password = process.env.INFLUXDB_PASS;
	request(
		{
			method: 'POST',
			uri: `${process.env.INFLUXDB_HOST}${path}`,
			json: true,
			body,
		},
		onError ||
			function (err) {
				if (err && !influxErrorShown) {
					log.warn('InfluxDB is inactive. Log upload will not work.');
					influxErrorShown = true;
				}
			}
	);
}
exports.influxEnabled = influxEnabled;
exports.command = function (command, msg) {
	const body = {
		command: command,
		user: msg.author.id,
	};

	postInflux('/command', body);
};

exports.logstash = function (command, p) {
	const body = {
		user: p.msg.author.id,
		command: command,
		text: p.msg.content,
		guild: p.msg.channel.guild?.id || 'dm',
	};

	postInflux('/metric', body);
};

exports.logstashBanned = function (command, p) {
	const body = {
		user: p.msg.author.id,
		bannedCommand: command,
		text: p.msg.content,
		guild: p.msg.channel.guild?.id || 'dm',
	};

	postInflux('/metric', body);
};

exports.logstashCaptcha = function (metric) {
	postInflux('/captcha', metric);
};

exports.logstashQos = function (metricKey, metric = {}) {
	metric.metric = metricKey;
	metric.server = process.env.SHARDER_SERVER;
	metric.shards = global.getShardString();

	if (config.debug) {
		metric.debug = true;
	}

	postInflux('/qos', metric);
};
