/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Source fingerprint.
 *
 * Pterodactyl runs whatever is in `/home/container`, which is NOT updated by
 * restarting the server: uploading a new zip, extracting it and pressing Start
 * are three separate steps, and an old `index.js` keeps running happily. Every
 * boot now prints one short fingerprint of the files that matter for the
 * gateway, and `--doctor` prints the same list. If the two differ, the panel is
 * running different code than the one being diagnosed — which no amount of log
 * reading can reveal otherwise.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Files whose content decides whether the bot can reach READY and come online.
const TRACKED_FILES = [
	'package.json',
	'index.js',
	'src/owo.js',
	'src/utils/config.js',
	'src/utils/gatewayBoot.js',
	'src/utils/presence.js',
	'src/utils/readyState.js',
	'src/utils/intents.js',
	'src/utils/shardConfig.js',
	'src/eventHandlers/ready.js',
	'src/data/config.json',
];

function hashFile(relative, root = ROOT) {
	try {
		const content = fs.readFileSync(path.join(root, relative));
		return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
	} catch (err) {
		return 'MISSING';
	}
}

function snapshot(options = {}) {
	const root = options.root || ROOT;
	const files = (options.files || TRACKED_FILES).map((file) => ({
		file,
		hash: hashFile(file, root),
	}));
	return files;
}

/** One short id for the whole tree, printed at boot and by --doctor. */
function fingerprint(options = {}) {
	const files = snapshot(options);
	const combined = files.map((entry) => `${entry.file}:${entry.hash}`).join('|');
	return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 12);
}

function describe(options = {}) {
	const missing = snapshot(options).filter((entry) => entry.hash === 'MISSING');
	const suffix = missing.length
		? ` (missing: ${missing.map((entry) => entry.file).join(', ')})`
		: '';
	return `build ${fingerprint(options)}${suffix}`;
}

module.exports = { ROOT, TRACKED_FILES, hashFile, snapshot, fingerprint, describe };
