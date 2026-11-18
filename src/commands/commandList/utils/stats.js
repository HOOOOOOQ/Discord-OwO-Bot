/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');
const { shardFor } = require('../../../utils/shardLookup.js');
const request = require('../../../utils/http.js');

module.exports = new CommandInterface({
	alias: ['stats', 'stat', 'info'],

	args: '',

	desc: 'Some bot stats!',

	example: [],

	related: [],

	permissions: ['sendMessages', 'embedLinks'],

	group: ['utility'],

	cooldown: 60000,
	half: 100,
	six: 500,

	execute: async function (p) {
		let client = p.client,
			msg = p.msg;
		let sql = 'SELECT COUNT(*) user,sum(count) AS total FROM user;';
		sql +=
			'SELECT SUM(common) AS common, SUM(uncommon) AS uncommon, SUM(rare) AS rare, SUM(epic) AS epic, SUM(mythical) AS mythical, SUM(legendary) AS legendary FROM animal_count;';
		sql += 'SELECT command FROM disabled WHERE channel = ' + msg.channel.id + ';';

		// Without upstream's sharder server, report this process' own view.
		let info = process.env.SHARDER_HOST ? await fetchInfo().catch(() => null) : null;
		let guilds = info ? info.guilds : p.client.guilds.size;
		let users = info ? info.users : p.client.users.size;

		let ping = shardFor(p.client, p.msg.channel.guild.id).latency;

		let rows = await p.query(sql);
		// `SUM(...)` is NULL while a table is still empty, which is exactly the
		// state of a freshly created database: `o stats` used to throw
		// "Cannot read properties of null" on a new install. Missing/NULL sums
		// are read as 0.
		const sums = rows[1] && rows[1][0] ? rows[1][0] : {};
		const total = rows[0] && rows[0][0] ? rows[0][0] : {};
		const num = (value) => {
			const parsed = Number.parseInt(value, 10);
			return Number.isFinite(parsed) ? parsed : 0;
		};
		let totalAnimals =
			num(sums.common) +
			num(sums.uncommon) +
			num(sums.rare) +
			num(sums.epic) +
			num(sums.mythical) +
			num(sums.legendary);
		let disabled = '';
		for (let i in rows[2]) {
			disabled += rows[2][i].command + ', ';
		}
		disabled = disabled.slice(0, -2);
		if (disabled == '') disabled = 'no disabled commands';

		let embed = {
			description:
				"Here's a little bit of information! If you need help with commands, type `o help`.",
			color: p.config.embed_color,
			timestamp: new Date(),
			author: {
				name: 'OwO Bot Information',
				url: 'https://discordapp.com/api/oauth2/authorize?client_id=408785106942164992&permissions=444480&scope=bot',
				icon_url:
					'https://cdn.discordapp.com/app-icons/408785106942164992/00d934dce5e41c9e956aca2fd3461212.png',
			},
			fields: [
				{
					name: 'Current Guild',
					value:
						'```md\n<userID:  ' +
						msg.author.id +
						'>\n<channelID: ' +
						msg.channel.id +
						'>\n<guildID:   ' +
						msg.channel.guild.id +
						'>```',
				},
				{
					name: 'Global information',
					value:
						'```md\n<TotalOwOs:  ' +
						p.global.toFancyNum(num(total.total)) +
						'>\n<OwOUsers:   ' +
						p.global.toFancyNum(num(total.user)) +
						'>``````md\n<animalsCaught: ' +
						p.global.toFancyNum(totalAnimals) +
						'>\n<common: ' +
						p.global.toFancyNum(num(sums.common)) +
						'>\n<uncommon: ' +
						p.global.toFancyNum(num(sums.uncommon)) +
						'>\n<rare: ' +
						p.global.toFancyNum(num(sums.rare)) +
						'>\n<epic: ' +
						p.global.toFancyNum(num(sums.epic)) +
						'>\n<mythical: ' +
						p.global.toFancyNum(num(sums.mythical)) +
						'>\n<legendary: ' +
						p.global.toFancyNum(num(sums.legendary)) +
						'>```',
				},
				{
					name: 'Bot Information',
					value:
						'```md\n<Guilds:    ' +
						p.global.toFancyNum(guilds) +
						'>\n<Channels:  alot>\n<Users:     ' +
						p.global.toFancyNum(users) +
						'>``````md\n<Ping:       ' +
						ping +
						'ms>\n<UpdatedOn:  ' +
						new Date(client.startTime) +
						'>\n<Uptime:     ' +
						client.uptime +
						'>```',
				},
			],
		};
		p.send({ embed });
	},
});

function fetchInfo() {
	return new Promise((resolve, reject) => {
		if (!process.env.SHARDER_HOST) {
			reject(new Error('SHARDER_HOST is not configured'));
			return;
		}
		setTimeout(function () {
			request(
				{
					method: 'GET',
					uri: process.env.SHARDER_HOST + '/botinfo',
				},
				(error, res, body) => {
					if (error) {
						reject();
						return;
					}
					if (res.statusCode == 200) resolve(JSON.parse(body));
					else reject();
				}
			);
		}, 500);
	});
}
