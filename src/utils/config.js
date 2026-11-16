/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Configuration loader.
 *
 * `src/data/config.json` is the committed default file. Anything that grants
 * privileges (owners, staff roles, mod channels) is overridden by environment
 * variables, and no privileged id ships in the public defaults. The loader
 * mutates the shared config object so every existing `config.*` consumer keeps
 * working unchanged.
 */

const log = require('./log.js');
const { resolveIntents } = require('./intents.js');
// Pristine committed defaults. Never mutated, so repeated loads (tests, cluster
// respawns) always start from the same baseline.
const defaults = require('../data/config.json');

const SNOWFLAKE = /^\d{17,20}$/;
const SNOWFLAKE_LIST = /^\d{17,20}(,\d{17,20})*$/;

function parseBool(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	const normalized = String(value).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	log.warn(`config: ignoring invalid boolean value "${value}", using ${fallback}`);
	return fallback;
}

function parseIdList(name, values, { allowEmpty = true } = {}) {
	const ids = [];
	for (const value of values) {
		for (const part of String(value).split(',')) {
			const id = part.trim();
			if (!id) continue;
			if (!SNOWFLAKE.test(id)) {
				log.warn(`config: ignoring invalid Discord id in ${name}: "${id}"`);
				continue;
			}
			ids.push(id);
		}
	}
	if (ids.length === 0 && !allowEmpty) {
		log.warn(`config: ${name} is empty, related commands will be unavailable`);
	}
	return [...new Set(ids)];
}

function envIds(envNames, fallback) {
	const values = [];
	let provided = false;
	for (const name of envNames) {
		if (process.env[name]) {
			values.push(process.env[name]);
			provided = true;
		}
	}
	if (!provided) return fallback;
	return parseIdList(envNames[0], values);
}

// Exported object is a copy: privileged fields are replaced, not mutated in
// the required JSON module.
const config = {
	...defaults,
	role: {
		admin: [],
		manager: [],
		helper: [],
	},
	modChannels: [],
	giveawayChannels: [],
	owners: [],
};

// ---- Eris client options / gateway intents --------------------------------
// Cloned so mutating them here never touches the required JSON module.
config.eris = {
	...(defaults.eris || {}),
	clientOptions: {
		...((defaults.eris && defaults.eris.clientOptions) || {}),
	},
};
// Upstream shipped no `intents` at all, so eris used allNonPrivileged and the
// bot never saw message text (every command silently ignored). MESSAGE_CONTENT
// is requested here unless ERIS_MESSAGE_CONTENT=off or the startup diagnostics
// detect that the portal toggle is disabled.
config.eris.intents = resolveIntents();
config.eris.clientOptions.intents = config.eris.intents.value;
if (config.eris.intents.unknown && config.eris.intents.unknown.length) {
	log.warn(
		`config: ERIS_INTENTS contains unknown intent name(s): ${config.eris.intents.unknown.join(
			', '
		)}`
	);
}

// ---- Privileged identities -------------------------------------------------
const legacyOwners = []
	.concat(Array.isArray(defaults.owners) ? defaults.owners : [])
	.concat(defaults.owner ? [defaults.owner] : []);

config.owners = envIds(['OWNER_IDS', 'OWNER_ID'], parseIdList('OWNER_IDS', legacyOwners));
// Legacy single-owner field, still read by older code paths
config.owner = config.owners[0] || '';

config.role.admin = envIds(
	['ADMIN_ROLE_IDS'],
	parseIdList('ADMIN_ROLE_IDS', defaults.role?.admin || [])
);
config.role.manager = envIds(
	['MANAGER_ROLE_IDS'],
	parseIdList('MANAGER_ROLE_IDS', defaults.role?.manager || [])
);
config.role.helper = envIds(
	['HELPER_ROLE_IDS'],
	parseIdList('HELPER_ROLE_IDS', defaults.role?.helper || [])
);

config.modChannels = envIds(
	['MOD_CHANNEL_IDS'],
	parseIdList('MOD_CHANNEL_IDS', defaults.modChannels || [])
);
config.giveawayChannels = envIds(
	['GIVEAWAY_CHANNEL_IDS'],
	parseIdList('GIVEAWAY_CHANNEL_IDS', defaults.giveawayChannels || [])
);

// Users/roles allowed to create cowoncy (`grant` command). Empty lists keep the
// command owner-only, so a fork never inherits another instance's allowlist.
config.cowoncyAdmins = envIds(
	['COWONCY_ADMIN_IDS'],
	parseIdList('COWONCY_ADMIN_IDS', defaults.cowoncyAdmins || [])
);
config.cowoncyAdminRoles = envIds(
	['COWONCY_ADMIN_ROLE_IDS'],
	parseIdList('COWONCY_ADMIN_ROLE_IDS', defaults.cowoncyAdminRoles || [])
);

// ---- Runtime flags --------------------------------------------------------
config.debug = parseBool(process.env.DEBUG, defaults.debug === true);
// Owner-only dynamic evaluation. Off unless explicitly enabled.
config.evalEnabled = parseBool(process.env.ALLOW_EVAL, defaults.evalEnabled === true);
config.prefix = (process.env.PREFIX || defaults.prefix || 'o').toLowerCase();
config.clusters = Number.parseInt(process.env.CLUSTERS, 10) || defaults.clusters || 60;
if (!Number.isInteger(config.clusters) || config.clusters < 1 || config.clusters > 200) {
	log.warn(`config: invalid CLUSTERS value, falling back to 60`);
	config.clusters = 60;
}
// Guilds that are allowed to use the bot while DEBUG is on
config.debugWhitelist = parseIdList(
	'DEBUG_WHITELIST',
	(process.env.DEBUG_WHITELIST ? [process.env.DEBUG_WHITELIST] : defaults.debugWhitelist) || []
);
config.metricsEnabled = parseBool(process.env.METRICS_ENABLED, defaults.metricsEnabled === true);
config.exitOnFatal = parseBool(process.env.EXIT_ON_FATAL, true);

// Largest amount a single `grant` may create (default 1,000,000,000).
config.cowoncyGrantMax =
	Number.parseInt(process.env.COWONCY_GRANT_MAX, 10) || defaults.cowoncyGrantMax || 1000000000;
if (!Number.isSafeInteger(config.cowoncyGrantMax) || config.cowoncyGrantMax < 1) {
	log.warn('config: invalid COWONCY_GRANT_MAX value, falling back to 1000000000');
	config.cowoncyGrantMax = 1000000000;
}

config.config = config;

config.validate = function () {
	if (config.owners.length === 0) {
		log.warn(
			'config: no owner configured (set OWNER_IDS=your_discord_id). ' +
				'Owner-only commands including eval are disabled.'
		);
	}
	if (config.evalEnabled) {
		log.warn('config: ALLOW_EVAL is enabled. Owner-only eval commands are ACTIVE in this process.');
	}
	if ((config.cowoncyAdmins || []).length === 0 && (config.cowoncyAdminRoles || []).length === 0) {
		log.info('config: no COWONCY_ADMIN_IDS/COWONCY_ADMIN_ROLE_IDS set; `grant` is owner-only');
	}
	if (config.debug) {
		log.info(
			`config: DEBUG mode is on; the bot only responds in ${config.debugWhitelist.length} whitelisted guild(s)`
		);
	}
	if (SNOWFLAKE_LIST.test(String(config.owner || ''))) return true;
	return config.owners.length > 0;
};

module.exports = config;
