/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');
const { shardFor } = require('../../../utils/shardLookup.js');

const pongEmoji = '🏓';

module.exports = new CommandInterface({
	alias: ['ping', 'pong'],

	args: '',

	desc: 'Shows the shard latency in ms',

	example: [],

	related: ['o stats, o shard'],

	permissions: ['sendMessages'],

	group: ['utility'],

	cooldown: 5000,
	half: 80,
	six: 500,

	execute: async function (p) {
		//query ping from shard (defensive: the guild may not be in guildShardMap yet)
		let ping = shardFor(p.client, p.msg.channel.guild.id).latency;
		let str = p.command === 'ping' ? 'pong' : 'ping';
		p.send(pongEmoji + ' **|** ...' + str + '! In ' + ping + 'ms');
	},
});
