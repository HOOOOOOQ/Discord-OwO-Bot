/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Translation helper.
 *
 * Replaces the `translate-google` package, whose dependency chain included
 * `safe-eval` (critical: sandbox breakout / prototype pollution). The upstream
 * service and response shape are the same, so the command output is unchanged.
 */

const request = require('./http.js');
const log = require('./log.js');

const ENDPOINT = process.env.TRANSLATE_URL || 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT_MS = Number.parseInt(process.env.TRANSLATE_TIMEOUT_MS, 10) || 8000;
const MAX_CHARS = 4000;

// Subset of Google Translate language codes used by `owo listlang`
const languages = {
	auto: 'Automatic',
	af: 'Afrikaans',
	ar: 'Arabic',
	az: 'Azerbaijani',
	be: 'Belarusian',
	bg: 'Bulgarian',
	bn: 'Bengali',
	bs: 'Bosnian',
	ca: 'Catalan',
	ceb: 'Cebuano',
	cs: 'Czech',
	cy: 'Welsh',
	da: 'Danish',
	de: 'German',
	el: 'Greek',
	en: 'English',
	eo: 'Esperanto',
	es: 'Spanish',
	et: 'Estonian',
	eu: 'Basque',
	fa: 'Persian',
	fi: 'Finnish',
	fr: 'French',
	ga: 'Irish',
	gl: 'Galician',
	gu: 'Gujarati',
	ha: 'Hausa',
	hi: 'Hindi',
	hr: 'Croatian',
	ht: 'Haitian Creole',
	hu: 'Hungarian',
	hy: 'Armenian',
	id: 'Indonesian',
	ig: 'Igbo',
	is: 'Icelandic',
	it: 'Italian',
	iw: 'Hebrew',
	ja: 'Japanese',
	jv: 'Javanese',
	jw: 'Javanese',
	ka: 'Georgian',
	kk: 'Kazakh',
	km: 'Khmer',
	kn: 'Kannada',
	ko: 'Korean',
	la: 'Latin',
	lo: 'Lao',
	lt: 'Lithuanian',
	lv: 'Latvian',
	mg: 'Malagasy',
	mi: 'Maori',
	mk: 'Macedonian',
	ml: 'Malayalam',
	mn: 'Mongolian',
	mr: 'Marathi',
	ms: 'Malay',
	mt: 'Maltese',
	my: 'Myanmar (Burmese)',
	ne: 'Nepali',
	nl: 'Dutch',
	no: 'Norwegian',
	ny: 'Chichewa',
	pa: 'Punjabi',
	pl: 'Polish',
	pt: 'Portuguese',
	ro: 'Romanian',
	ru: 'Russian',
	si: 'Sinhala',
	sk: 'Slovak',
	sl: 'Slovenian',
	so: 'Somali',
	sq: 'Albanian',
	sr: 'Serbian',
	st: 'Sesotho',
	su: 'Sundanese',
	sv: 'Swedish',
	sw: 'Swahili',
	ta: 'Tamil',
	te: 'Telugu',
	tg: 'Tajik',
	th: 'Thai',
	tl: 'Filipino',
	tr: 'Turkish',
	uk: 'Ukrainian',
	ur: 'Urdu',
	uz: 'Uzbek',
	vi: 'Vietnamese',
	yi: 'Yiddish',
	yo: 'Yoruba',
	zh: 'Chinese',
	zu: 'Zulu',
};

exports.languages = languages;

function requestTranslation(text, to) {
	return new Promise((resolve, reject) => {
		const query = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: to, dt: 't', q: text });
		request.get(
			`${ENDPOINT}?${query.toString()}`,
			{ timeout: TIMEOUT_MS },
			(err, response, body) => {
				if (err) return reject(err);
				if (!response || response.statusCode !== 200) {
					return reject(new Error(`translate responded with HTTP ${response?.statusCode}`));
				}
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch (parseError) {
					return reject(new Error('translate returned invalid JSON'));
				}
				if (!Array.isArray(parsed?.[0])) return resolve(String(body));
				resolve(parsed[0].map((chunk) => chunk?.[0] || '').join(''));
			}
		);
	});
}

/**
 * Same contract as `translate-google`: accepts a string or an array of
 * fragments, resolves with an array of translated strings.
 */
exports.translate = async function (input, options = {}) {
	const to = options.to || 'en';
	const fragments = Array.isArray(input) ? input : [input];
	const text = fragments.join(' ').trim();
	if (!text) return [''];
	if (text.length > MAX_CHARS) throw new Error('text too long to translate');
	log.debug(`translate: ${text.length} chars -> ${to}`);
	const translated = await requestTranslation(text, to);
	return [translated];
};
