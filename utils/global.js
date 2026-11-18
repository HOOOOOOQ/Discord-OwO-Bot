/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Operator helper: broadcasts `endProcess` to every cluster so the whole bot
 * shuts down cleanly. The message used to go through Redis; it now goes through
 * the MongoDB-backed pub/sub in `src/utils/pubsub.js`.
 */

const PubSub = require('../src/utils/pubsub.js');

exports.resetBot = async function () {
	await PubSub.publish('endProcess', true);
};
