/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Startup diagnostics for the master process.
 *
 * Two silent failure modes used to be indistinguishable from the panel console:
 *
 *   - an invalid/revoked token (gateway 4004) — the process keeps running but
 *     the bot is never online;
 *   - MESSAGE CONTENT INTENT disabled in the Developer Portal — the bot is
 *     online but every command is ignored because `msg.content` is empty.
 *
 * Both are now logged with the exact remediation, and the privileged intent is
 * only requested when Discord reports it as allowed (requesting it while it is
 * disabled closes the gateway with 4014, i.e. the bot would show offline).
 */

const log = require('./log.js');
const discordApi = require('./discordApi.js');
const { INTENT_MESSAGE_CONTENT } = require('./intents.js');

const DEV_PORTAL_HINT =
	'https://discord.com/developers/applications → your application → Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT → Save, then restart';

/**
 * Aligns the requested intents with what the application is actually allowed to
 * receive. A no-op when the operator pinned ERIS_INTENTS explicitly.
 */
function applyIntents(config, allowed, options = {}) {
	if (!config || !config.eris || !config.eris.clientOptions) return;
	const env = options.env || process.env;
	const logger = options.logger || log;
	if (env.ERIS_INTENTS) return; // explicit operator choice

	const mode = String(env.ERIS_MESSAGE_CONTENT || 'auto').toLowerCase();
	const current = Number(config.eris.clientOptions.intents) || 0;
	const hasBit = (current & INTENT_MESSAGE_CONTENT) !== 0;

	if (allowed === true) {
		if (!hasBit && mode !== 'off') {
			config.eris.clientOptions.intents = current | INTENT_MESSAGE_CONTENT;
		}
		return;
	}

	if (allowed === false) {
		if (mode === 'on') {
			logger.warn(
				'discord: ERIS_MESSAGE_CONTENT=on but MESSAGE CONTENT INTENT is disabled in the portal — ' +
					'Discord will close the gateway with 4014 (bot looks offline) until you enable it: ' +
					DEV_PORTAL_HINT
			);
			return;
		}
		if (hasBit) {
			config.eris.clientOptions.intents = current & ~INTENT_MESSAGE_CONTENT;
			logger.warn(
				'discord: MESSAGE CONTENT INTENT is DISABLED for this application — the bot will connect but ' +
					'ignore every command (message content is empty). Fix: ' +
					DEV_PORTAL_HINT
			);
		}
	}
}

/**
 * Verifies the token and the privileged intents before the sharder starts.
 * Never throws: every failure is logged and returned.
 */
async function check(options = {}) {
	const env = options.env || process.env;
	const logger = options.logger || log;
	const api = options.api || discordApi;
	const config = options.config;
	const result = {};

	const user = await api.getCurrentUser(env.BOT_TOKEN);
	if (user.ok) {
		result.user = user.data;
		logger.info(`discord: token ok — ${api.formatUser(user.data)}`);
	} else if (user.status === 401) {
		result.tokenInvalid = true;
		logger.error(
			'discord: BOT_TOKEN was rejected (HTTP 401). The bot process stays up but never appears online. ' +
				'Copy the token again from the Developer Portal (Bot → Reset/Copy) into BOT_TOKEN.'
		);
	} else {
		result.tokenUnknown = true;
		logger.warn(`discord: could not validate BOT_TOKEN (${user.error})`);
	}

	const application = await api.getApplication(env.BOT_TOKEN);
	if (application.ok) {
		const data = application.data || {};
		const allowed = api.messageContentIntentAllowed(data.flags);
		result.application = data;
		result.messageContentAllowed = allowed;
		logger.info(
			`discord: application ${data.name || 'unknown'} (id ${data.id || '?'}); ` +
				`MESSAGE CONTENT INTENT ${allowed ? 'enabled' : 'DISABLED'}`
		);
		applyIntents(config, allowed, { env, logger });
	} else if (!result.tokenInvalid) {
		logger.warn(`discord: could not read the application object (${application.error})`);
	}

	const gateway = await api.getBotGateway(env.BOT_TOKEN);
	if (gateway.ok) {
		result.gateway = gateway.data;
		const limit = (gateway.data && gateway.data.session_start_limit) || {};
		logger.info(
			`discord: recommends ${gateway.data && gateway.data.shards} shard(s); ` +
				`identify budget ${limit.remaining}/${limit.total} (resets in ${Math.round(
					(limit.reset_after || 0) / 3600000
				)}h)`
		);
		if (limit.remaining === 0) {
			logger.warn(
				'discord: the identify budget is exhausted — new sessions will be rejected until it resets. ' +
					'Deleting and re-creating the server restarts does not reset it.'
			);
		}
	} else if (!result.tokenInvalid) {
		logger.warn(`discord: could not read /gateway/bot (${gateway.error})`);
	}

	return result;
}

module.exports = { check, applyIntents, DEV_PORTAL_HINT };
