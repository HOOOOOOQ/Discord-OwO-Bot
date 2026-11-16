/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');

const auth = require('../../../utils/auth.js');
const log = require('../../../utils/log.js');
const grantUtils = require('./utils/grantUtils.js');

module.exports = new CommandInterface({
	alias: ['grant', 'addcash', 'addmoney', 'topup'],

	args: '{@user} {amount}',

	desc: 'Adds cowoncy to a user out of nowhere! Only the bot owners and the users/roles listed in `COWONCY_ADMIN_IDS` / `COWONCY_ADMIN_ROLE_IDS` can use it.',

	example: ['o grant @Scuttler 1000', 'o addcash @Scuttler 25'],

	related: ['o give', 'o money'],

	permissions: ['sendMessages'],

	group: ['economy'],

	cooldown: 3000,
	half: 100,
	six: 500,
	bot: true,

	execute: async function () {
		const decision = auth.canGrantCowoncy(this.msg.author.id, this.msg.member, this.config);
		if (!decision.allowed) {
			auth.audit('cowoncy-grant-denied', this.msg, { command: this.command });
			return this.errorMsg(', you do NOT have permission to add cowoncy! >:c', 4000);
		}

		const targetId = grantUtils.parseTargetId(this.args[0]);
		const parsedAmount = grantUtils.parseAmount(this.args[1]);
		const validation = grantUtils.validateGrant(
			targetId,
			parsedAmount,
			this.config.cowoncyGrantMax
		);

		if (!validation.ok) {
			return this.errorMsg(
				`, invalid syntax! The correct use is \`${this.config.prefix} grant {@user} {amount}\`` +
					` — example: \`${this.config.prefix} grant @Scuttler 1000\``,
				5000
			);
		}

		const amount = validation.amount;
		const target = this.getMention(this.args[0]) || this.client.users.get(targetId);
		const targetName = target ? this.getUniqueName(target) : `<@${targetId}>`;

		try {
			// Make sure the receiver exists as a user, then create/increment the balance.
			// Both statements are parameterized: no ids or amounts are concatenated.
			await this.query('INSERT IGNORE INTO user (id, count) VALUES (?, 0);', [targetId]);
			await this.query(
				'INSERT INTO cowoncy (id, money) VALUES (?, ?) ON DUPLICATE KEY UPDATE money = money + ?;',
				[targetId, amount, amount]
			);

			const rows = await this.query('SELECT money FROM cowoncy WHERE id = ?;', [targetId]);
			const balance = this.global.toFancyNum(rows && rows[0] ? rows[0].money : amount);

			await this.send(
				`${this.config.emoji.cowoncy} **| ${this.getName()}** added **${this.global.toFancyNum(
					amount
				)} cowoncy** to **${targetName}**!\n${
					this.config.emoji.blank
				} **|** Their new balance is **${balance} cowoncy**`
			);

			auth.audit('cowoncy-grant', this.msg, { command: this.command, result: decision.reason });
			// Amount and ids only; no tokens, config values or message content.
			log.info(
				`cowoncy grant: by=${this.msg.author.id} to=${targetId} amount=${amount} via=${decision.reason}`
			);
		} catch (err) {
			log.error(`cowoncy grant failed: by=${this.msg.author.id} to=${targetId} amount=${amount}`);
			log.error(err);
			return this.errorMsg(', failed to add cowoncy! Please try again later.', 4000);
		}
	},
});
