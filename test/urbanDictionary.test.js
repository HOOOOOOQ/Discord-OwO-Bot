const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { freshRequire, withEnvAsync } = require('./helpers.js');

let server;
let baseUrl;

test.before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const term = url.searchParams.get('term');
		res.writeHead(200, { 'content-type': 'application/json' });
		if (term === 'nothing') return res.end(JSON.stringify({ list: [] }));
		res.end(
			JSON.stringify({
				list: [
					{
						word: term,
						definition: 'a definition of ' + term,
						example: 'an example',
						permalink: 'https://www.urbandictionary.com/define.php?term=' + term,
						thumbs_up: 10,
						thumbs_down: 2,
					},
				],
			})
		);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function loadClient() {
	return withEnvAsync({ URBAN_DICTIONARY_URL: baseUrl }, () =>
		freshRequire('../src/utils/urbanDictionary.js')
	);
}

function defineWith(client, word) {
	return new Promise((resolve, reject) => {
		client.define(word, (err, entries) => (err ? reject(err) : resolve(entries)));
	});
}

test('define() preserves the callback contract of the removed package', async () => {
	const client = await loadClient();
	const entries = await defineWith(client, 'tsundere');
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].definition, 'a definition of tsundere');
	assert.strictEqual(entries[0].example, 'an example');
	assert.ok(entries[0].permalink.includes('tsundere'));
});

test('an empty result set rejects with a NOT_FOUND error', async () => {
	const client = await loadClient();
	await assert.rejects(defineWith(client, 'nothing'), (err) => {
		assert.strictEqual(err.code, 'NOT_FOUND');
		return true;
	});
});

test('missing word is rejected without a network call', async () => {
	const client = await loadClient();
	await assert.rejects(defineWith(client, '   '), /word is required/);
});
