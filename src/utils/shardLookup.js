/*
 * OwO Bot for Discord
 * Copyright (C) 2024 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The shard that serves a guild, resolved defensively.
 *
 * `client.guildShardMap` is only filled once GUILD_CREATE has been processed for
 * that guild. `o ping` / `o stats` used to do
 * `client.shards.get(client.guildShardMap[guildId]).latency` and threw
 * `TypeError: Cannot read properties of undefined` for a guild that was not in
 * the map yet (fresh invite, resumed session, cache miss) — the user then got
 * "something went wrong while running that command" instead of a ping.
 */
function shardFor(client, guildId) {
	const map = (client && client.guildShardMap) || {};
	let id = map[guildId];
	if (id === undefined || id === null) {
		// Fall back to the first shard of this worker: it is the shard that
		// delivered the message, and its latency is the number the user wants.
		if (client && client.shards) {
			const first = client.shards.first ? client.shards.first() : undefined;
			id = first && first.id !== undefined ? first.id : 0;
		} else {
			id = 0;
		}
	}
	const shard = client && client.shards && client.shards.get ? client.shards.get(id) : undefined;
	return {
		id,
		shard,
		latency:
			shard && typeof shard.latency === 'number'
				? shard.latency
				: typeof client?.latency === 'number'
				? client.latency
				: 0,
	};
}

module.exports = { shardFor };
