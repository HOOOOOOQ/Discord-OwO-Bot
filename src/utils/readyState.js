/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Bookkeeping for the one-time READY replay.
 *
 * eris-sharder builds the bot application from inside the client's own `ready`
 * listener (`bot.once("ready", () => this.loadCode(bot))`), so every handler the
 * application registers for `ready` is attached after that event has already
 * fired. Without a replay the first boot never runs the ready handler: no
 * presence (eris identified as "offline"), no `bot ready` marker for the panel
 * and no health line.
 *
 * Kept as a small pure module so it can be unit tested without pulling in the
 * whole event-handler graph (which opens database connections at require time).
 */

function needsReplay(main, bot) {
	if (!main || !bot) return false;
	if (!bot.ready) return false;
	return main.__readyReplayed !== true;
}

function markReplayed(main) {
	if (main) main.__readyReplayed = true;
}

module.exports = { needsReplay, markReplayed };
