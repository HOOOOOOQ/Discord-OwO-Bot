/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Authorization helpers.
 *
 * Privileges are never granted from a hardcoded id. Everything resolves through
 * the (env-overridable) config, and an empty owner list denies access instead of
 * falling back to anything permissive.
 */

const config = require('./config.js');
const log = require('./log.js');

const SNOWFLAKE = /^\d{17,20}$/;

exports.isValidId = (id) => typeof id === 'string' && SNOWFLAKE.test(id);

exports.isOwner = function (userId, cfg = config) {
	if (!exports.isValidId(userId)) return false;
	return (cfg.owners || []).includes(userId);
};

exports.hasAnyRole = function (member, roleIds) {
	if (!member || !Array.isArray(member.roles) || !roleIds || roleIds.length === 0) return false;
	return roleIds.some((id) => member.roles.includes(id));
};

/**
 * Full admin-command gate: owner, then staff role inside a configured mod
 * channel. Returns a decision object so callers can log why access was denied.
 */
exports.canRunAdmin = function (commandObj, msg, cfg = config) {
	if (!commandObj || !msg || !msg.author) return { allowed: false, reason: 'no-context' };

	const userId = msg.author.id;
	if (commandObj.owner) {
		if (!cfg.evalEnabled && isEvalCommand(commandObj)) {
			return { allowed: false, reason: 'eval-disabled' };
		}
		return exports.isOwner(userId, cfg)
			? { allowed: true, reason: 'owner' }
			: { allowed: false, reason: 'not-owner' };
	}

	const channelId = msg.channel && msg.channel.id;
	if (!channelId || !(cfg.modChannels || []).includes(channelId)) {
		return { allowed: false, reason: 'not-mod-channel' };
	}

	if (commandObj.admin && exports.hasAnyRole(msg.member, cfg.role?.admin)) {
		return { allowed: true, reason: 'admin-role' };
	}
	if (commandObj.manager && exports.hasAnyRole(msg.member, cfg.role?.manager)) {
		return { allowed: true, reason: 'manager-role' };
	}
	if (commandObj.helper && exports.hasAnyRole(msg.member, cfg.role?.helper)) {
		return { allowed: true, reason: 'helper-role' };
	}
	return { allowed: false, reason: 'missing-role' };
};

function isEvalCommand(commandObj) {
	const aliases = commandObj.alias || [];
	return aliases.includes('eval') || aliases.includes('broadcasteval');
}

/**
 * Sensitive administrative actions get an audit line. Only ids and the action
 * name are recorded; command content and secrets are never logged.
 */
exports.audit = function (action, msg, extra = {}) {
	const userId = msg?.author?.id || 'unknown';
	const channelId = msg?.channel?.id || 'unknown';
	const guildId = msg?.channel?.guild?.id || 'dm';
	log.info(
		`audit action=${action} user=${userId} channel=${channelId} guild=${guildId}` +
			(extra.command ? ` command=${extra.command}` : '') +
			(extra.result ? ` result=${extra.result}` : '')
	);
};
