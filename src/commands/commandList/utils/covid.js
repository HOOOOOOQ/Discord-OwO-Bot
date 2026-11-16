/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');

const request = require('../../../utils/http.js');
const log = require('../../../utils/log.js');

let cases = {};
// Only poll when the upstream endpoint is configured. Requiring this module
// used to fire a request against "undefined/covid" at load time.
if (process.env.SHARDER_HOST) {
	fetchCases();
	setInterval(fetchCases, 1800000).unref();
}

module.exports = new CommandInterface({
	alias: ['covid', 'cv', 'covid19', 'coronavirus'],

	args: '{countryName}',

	desc: 'Shows the current coronavirus cases. You can specify a country in the arguments. Stay safe out there and please remember to wash your hands. The information is pulled from this github https://www.worldometers.info/coronavirus/',

	example: ['o covid', 'o coronavirus usa'],

	related: [],

	permissions: ['sendMessages'],

	group: ['utility'],

	cooldown: 5000,

	execute: async function (p) {
		if (!p.args.length) {
			showStats(p, 'global');
		} else {
			showStats(p, p.args.join('').toLowerCase());
		}
	},
});

function showStats(p, name) {
	let stat = cases[name];
	if (!stat) {
		p.errorMsg(', I could not find that country/state', 3000);
		return;
	}
	let title = 'Global cases for COVID19';
	if (stat.country || stat.state) {
		title = 'COVID19 cases for ' + (stat.country || stat.state);
	}
	const embed = {
		author: {
			name: title,
			url: 'https://www.worldometers.info/coronavirus',
		},
		color: p.config.embed_color,
		timestamp: new Date(stat.updated),
		footer: {
			text: 'Updated on ',
		},
		thumbnail: {
			url: stat.countryInfo ? stat.countryInfo.flag : null,
		},
		fields: [],
	};

	if (stat.country || name === 'global') {
		let percent = Math.round(stat.casesPerOneMillion / 1000) / 1000;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			name: 'Total Cases',
			value:
				'**' +
				p.global.toFancyNum(stat.cases) +
				'** (+' +
				p.global.toFancyNum(stat.todayCases) +
				') [' +
				percent +
				'%]',
		});

		percent = Math.round(stat.deathsPerOneMillion / 1000) / 1000;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			name: 'Total Deaths',
			value:
				'**' +
				p.global.toFancyNum(stat.deaths) +
				'** (+' +
				p.global.toFancyNum(stat.todayDeaths) +
				') [' +
				percent +
				'%]',
		});

		percent = Math.round((stat.recovered / stat.cases) * 1000) / 10;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			inline: true,
			name: 'Recovered',
			value: '**' + stat.recovered + '** [' + percent + '%]',
		});

		percent = Math.round((stat.active / stat.cases) * 1000) / 10;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			inline: true,
			name: 'Infected',
			value: '**' + stat.active + '** [' + percent + '%]',
		});

		percent = Math.round((stat.critical / stat.cases) * 1000) / 10;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			inline: true,
			name: 'Critical',
			value: '**' + stat.critical + '** [' + percent + '%]',
		});
	} else if (stat.state) {
		embed.fields.push({
			name: 'Total Cases',
			value:
				'**' +
				p.global.toFancyNum(stat.cases) +
				'** (+' +
				p.global.toFancyNum(stat.todayCases) +
				')',
		});

		embed.fields.push({
			name: 'Total Deaths',
			value:
				'**' +
				p.global.toFancyNum(stat.deaths) +
				'** (+' +
				p.global.toFancyNum(stat.todayDeaths) +
				')',
		});

		let percent = Math.round(((stat.cases - stat.active) / stat.cases) * 1000) / 10;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			inline: true,
			name: 'Recovered',
			value: '**' + (stat.cases - stat.active) + '** [' + percent + '%]',
		});

		percent = Math.round((stat.active / stat.cases) * 1000) / 10;
		if (!percent) percent = '<0.001';
		embed.fields.push({
			inline: true,
			name: 'Infected',
			value: '**' + stat.active + '** [' + percent + '%]',
		});
	} else {
		p.errorMsg(', I could not find that country/state', 3000);
		return;
	}

	p.send({ embed });
}

async function fetchCases() {
	request(
		{
			method: 'GET',
			uri: process.env.SHARDER_HOST + '/covid',
			json: true,
		},
		(error, res, body) => {
			if (error) {
				log.warn('covid: could not refresh case data:', error.message);
				return;
			}
			if (body && typeof body === 'object') cases = body;
		}
	);
}
