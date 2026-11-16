/*
 * OwO Bot for Discord
 * Copyright (C) 2023 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');
const sandbox = require('../../../utils/sandbox.js');
const auth = require('../../../utils/auth.js');

module.exports = new CommandInterface({
	alias: ['eval'],

	owner: true,

	execute: async function () {
		if (!sandbox.isEnabled()) {
			this.errorMsg(', eval is disabled on this instance (ALLOW_EVAL is not set).', 4000);
			return;
		}
		if (!auth.isOwner(this.msg.author.id)) {
			this.errorMsg(', only the configured owner may use eval.', 4000);
			return;
		}

		const js = this.context.replace(/^```\w*/gi, '').replace(/```$/gi, '');
		let result;
		try {
			result = sandbox.run(js, this);
		} catch (err) {
			result = err;
		}

		// Output is redacted and length capped before it ever reaches Discord
		auth.audit('eval', this.msg, {
			command: 'eval',
			result: result instanceof Error ? 'error' : 'ok',
		});
		this.send(sandbox.formatResult(result));
	},
});
