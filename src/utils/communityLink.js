/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The support/community invite.
 *
 * Discord renders the `url` of a link button (style 5) as a real clickable
 * button — unlike the activity text, which is plain text and can never be
 * clicked. Embeds get both: the URL inside the text and the button.
 *
 * A guildlink that is empty, a placeholder, or not an https URL yields no
 * button at all, so a fork without a configured invite never sends an invalid
 * component (Discord rejects the whole message in that case).
 */

const DEFAULT_LINK = 'https://discord.gg/666family';

function inviteUrl(config) {
	const raw = String((config && config.guildlink) || '').trim();
	if (!raw) return DEFAULT_LINK;
	if (!/^https?:\/\/[^\s]+$/i.test(raw)) return null;
	if (/your|example|placeholder|xxx/i.test(raw)) return null;
	return raw;
}

/**
 * Components to attach to a help/info message.
 * Returns `undefined` (not an empty array) when there is nothing to attach,
 * because Discord rejects `components: []` on a normal send.
 */
function components(config) {
	const url = inviteUrl(config);
	if (!url) return undefined;
	return [
		{
			type: 1,
			components: [
				{
					type: 2,
					style: 5, // link button — no interaction, Discord opens the URL
					label: 'Join Community',
					url,
				},
			],
		},
	];
}

/**
 * Attach the community button to an outgoing message payload without touching
 * anything else on it.
 */
function attach(payload, config) {
	const buttons = components(config);
	if (!buttons) return payload;
	if (!payload || typeof payload !== 'object') return payload;
	payload.components = buttons;
	return payload;
}

module.exports = { inviteUrl, components, attach, DEFAULT_LINK };
