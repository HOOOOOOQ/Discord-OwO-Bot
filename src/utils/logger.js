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

/***** Datadog *****/
var StatsD = require('node-dogstatsd').StatsD;
var statsdClient = null;
try {
	statsdClient = new StatsD();
} catch (err) {
	log.warn('logger: StatsD client unavailable:', err.message);
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

/***** StatsD *****/
const SDC = require('statsd-client');
const sdc = new SDC({
	host: 'localhost',
	port: 9125,
	prefix: 'owo',
	socketTimeout: 5000,
});

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
	try {
		sdc.increment(`${name}`, amount, tags);
	} catch (err) {
		log.debug('logger: statsd increment failed:', err.message);
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
	try {
		sdc.decrement(`${name}`, amount, tags);
	} catch (err) {
		log.debug('logger: statsd decrement failed:', err.message);
	}
});

const request = require('./http.js');
// Only display this error once per 5 minutes
let influxErrorShown = false;
setTimeout(() => {
	influxErrorShown = false;
}, 5 * 60 * 60 * 1000);
exports.command = function (command, msg) {
	const body = {
		password: process.env.INFLUXDB_PASS,
		command: command,
		user: msg.author.id,
	};

	request(
		{
			method: 'POST',
			uri: `${process.env.INFLUXDB_HOST}/command`,
			json: true,
			body: body,
		},
		function (err) {
			if (err && !influxErrorShown) {
				log.warn('InfluxDB is inactive. Log upload will not work.');
				influxErrorShown = true;
			}
		}
	);
};

exports.logstash = function (command, p) {
	const body = {
		password: process.env.INFLUXDB_PASS,
		user: p.msg.author.id,
		command: command,
		text: p.msg.content,
		guild: p.msg.channel.guild?.id || 'dm',
	};

	request(
		{
			method: 'POST',
			uri: `${process.env.INFLUXDB_HOST}/metric`,
			json: true,
			body: body,
		},
		function (err) {
			if (err && !influxErrorShown) {
				log.warn('InfluxDB is inactive. Log upload will not work.');
				influxErrorShown = true;
			}
		}
	);
};

exports.logstashBanned = function (command, p) {
	const body = {
		password: process.env.INFLUXDB_PASS,
		user: p.msg.author.id,
		bannedCommand: command,
		text: p.msg.content,
		guild: p.msg.channel.guild?.id || 'dm',
	};

	request(
		{
			method: 'POST',
			uri: `${process.env.INFLUXDB_HOST}/metric`,
			json: true,
			body: body,
		},
		function (err) {
			if (err && !influxErrorShown) {
				log.warn('InfluxDB is inactive. Log upload will not work.');
				influxErrorShown = true;
			}
		}
	);
};

exports.logstashCaptcha = function (metric) {
	metric.password = process.env.INFLUXDB_PASS;

	request(
		{
			method: 'POST',
			uri: `${process.env.INFLUXDB_HOST}/captcha`,
			json: true,
			body: metric,
		},
		function (err) {
			if (err && !influxErrorShown) {
				log.warn('InfluxDB is inactive. Log upload will not work.');
				influxErrorShown = true;
			}
		}
	);
};

exports.logstashQos = function (metricKey, metric = {}) {
	metric.password = process.env.INFLUXDB_PASS;
	metric.metric = metricKey;
	metric.server = process.env.SHARDER_SERVER;
	metric.shards = global.getShardString();

	if (config.debug) {
		metric.debug = true;
	}

	request(
		{
			method: 'POST',
			uri: `${process.env.INFLUXDB_HOST}/qos`,
			json: true,
			body: metric,
		},
		function (err) {
			if (err && !influxErrorShown) {
				log.warn('InfluxDB is inactive. Log upload will not work.');
				influxErrorShown = true;
			}
		}
	);
};
