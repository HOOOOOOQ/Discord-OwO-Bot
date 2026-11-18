/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');
const communityLink = require('../../../utils/communityLink.js');

module.exports = new CommandInterface({
	alias: ['invite', 'link'],

	args: '',

	desc: 'Want to invite this bot to another server? Use this command!',

	example: [],

	related: ['o guildlink'],

	permissions: ['sendMessages', 'embedLinks'],

	group: ['utility'],

	cooldown: 5000,
	half: 100,
	six: 500,

	execute: async function (p) {
		// Built from this bot's own application id, so a fork never sends users to
		// the upstream bot. `config.invitelink` is only a fallback for the case
		// where the client is not ready yet.
		const clientId = p.bot?.user?.id || '';
		const link = clientId
			? `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`
			: String(p.config.invitelink || '').replace('{CLIENT_ID}', '');
		const icon = p.bot?.user?.avatarURL || undefined;
		const embed = {
			title: 'Click here to invite OCEAN to your server!',
			url: link,
			description: `Need help or want to hang out? Join us: ${p.config.guildlink}`,
			color: p.config.embed_color,
			thumbnail: icon ? { url: icon } : undefined,
		};
		p.send(communityLink.attach({ embed }, p.config));
	},
});
