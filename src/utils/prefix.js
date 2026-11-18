/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Prefix parsing, kept in its own module so it can be tested without loading
 * the whole command tree (which queries the database at require time).
 *
 * Accepted forms with the default prefix `o`:
 *   `ohelp`, `o help`, `O HELP`   -> matches
 *   `thelp`, `ohelp` with PREFIX=t -> does not match
 *
 * A guild may also configure its own prefix (`tsetprefix`), stored in Redis
 * under `prefix`. A Redis failure falls back to the default prefix instead of
 * dropping the message.
 */

const log = require('./log.js');

function getContext(args, prefix, content) {
	return content.trim().replace(prefix, '').trim().replace(/^\S+/i, '').trim();
}

function match(content, prefix) {
	if (!prefix || !content.startsWith(prefix)) return undefined;
	const args = content.slice(prefix.length).trim().split(/ +/g);
	return args;
}

async function checkPrefix(main, msg) {
	const raw = typeof msg?.content === 'string' ? msg.content : '';
	const content = raw.toLowerCase();

	// Default prefix. `ohelp` and `o help` both parse: the prefix is stripped and
	// the remainder is trimmed before it is split on whitespace.
	const args = match(content, main?.prefix);
	if (args) {
		return {
			args,
			context: getContext(args, main.prefix, raw),
			prefix: main.prefix,
			source: 'default',
		};
	}

	if (!msg.channel?.guild) return {};

	const guild = msg.channel.guild;

	// If prefix isn't saved, fetch it
	if (guild.prefix === undefined) {
		try {
			const prefix = await main.redis.hget(guild.id, 'prefix');
			guild.prefix = prefix || false;
		} catch (err) {
			guild.prefix = false;
			log.error(
				`[CMD] guild prefix lookup failed for guild ${guild.id}: ${err && err.message} ` +
					'— falling back to the default prefix'
			);
		}
	}

	// check with custom prefix
	const guildArgs = match(content, guild.prefix);
	if (guildArgs) {
		return {
			args: guildArgs,
			context: getContext(guildArgs, guild.prefix, raw),
			prefix: guild.prefix,
			source: 'guild',
		};
	}

	return {};
}

module.exports = { checkPrefix, getContext };
