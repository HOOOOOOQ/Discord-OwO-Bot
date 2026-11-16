const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { freshRequire, withEnvAsync } = require('./helpers.js');

let server;
let baseUrl;
let lastQuery;

test.before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		lastQuery = Object.fromEntries(url.searchParams.entries());
		res.writeHead(200, { 'content-type': 'application/json' });
		// Shape returned by the Google translate endpoint
		res.end(JSON.stringify([[['halo dunia', 'hello world', null, null, 10]], null, 'en']));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function loadClient() {
	return withEnvAsync({ TRANSLATE_URL: baseUrl }, () => freshRequire('../src/utils/translate.js'));
}

test('translate() returns the joined translation as an array', async () => {
	const client = await loadClient();
	const result = await client.translate(['hello world', ''], { to: 'id' });
	assert.deepStrictEqual(result, ['halo dunia']);
	assert.strictEqual(lastQuery.tl, 'id');
	assert.strictEqual(lastQuery.q, 'hello world');
});

test('an empty input short-circuits without a request', async () => {
	const client = await loadClient();
	assert.deepStrictEqual(await client.translate(['   '], { to: 'en' }), ['']);
});

test('language list is exposed for `owo listlang`', async () => {
	const client = await loadClient();
	assert.strictEqual(client.languages.ja, 'Japanese');
	assert.ok(Object.keys(client.languages).length > 50);
});
