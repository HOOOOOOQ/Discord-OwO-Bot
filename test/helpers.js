/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Shared test helpers. Modules that read process.env at require time have to be
 * re-required after changing the environment, hence the cache-busting helper.
 */

function freshRequire(modulePath) {
	const resolved = require.resolve(modulePath);
	for (const key of Object.keys(require.cache)) {
		if (key === resolved) delete require.cache[key];
	}
	return require(resolved);
}

function withEnv(vars, fn) {
	const previous = {};
	for (const key of Object.keys(vars)) {
		previous[key] = process.env[key];
		if (vars[key] === undefined) delete process.env[key];
		else process.env[key] = vars[key];
	}
	try {
		return fn();
	} finally {
		for (const key of Object.keys(vars)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

async function withEnvAsync(vars, fn) {
	const previous = {};
	for (const key of Object.keys(vars)) {
		previous[key] = process.env[key];
		if (vars[key] === undefined) delete process.env[key];
		else process.env[key] = vars[key];
	}
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(vars)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

const OWNER_A = '111111111111111111';
const OWNER_B = '222222222222222222';
const MOD_CHANNEL = '333333333333333333';
const ADMIN_ROLE = '444444444444444444';
const MOD_ROLE = '555555555555555555';
const HELPER_ROLE = '666666666666666666';

function adminEnv(extra = {}) {
	return {
		OWNER_IDS: `${OWNER_A}, ${OWNER_B}`,
		MOD_CHANNEL_IDS: MOD_CHANNEL,
		ADMIN_ROLE_IDS: ADMIN_ROLE,
		MANAGER_ROLE_IDS: MOD_ROLE,
		HELPER_ROLE_IDS: HELPER_ROLE,
		ALLOW_EVAL: undefined,
		...extra,
	};
}

function fakeMessage({ userId = '999999999999999999', channelId = MOD_CHANNEL, roles = [] } = {}) {
	return {
		author: { id: userId },
		member: { roles },
		channel: { id: channelId, guild: { id: '777777777777777777' } },
	};
}

module.exports = {
	freshRequire,
	withEnv,
	withEnvAsync,
	OWNER_A,
	OWNER_B,
	MOD_CHANNEL,
	ADMIN_ROLE,
	MOD_ROLE,
	HELPER_ROLE,
	adminEnv,
	fakeMessage,
};
