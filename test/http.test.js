const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const request = require('../src/utils/http.js');

let server;
let baseUrl;

test.before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname === '/json') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ hello: 'world', q: url.searchParams.get('q') }));
			return;
		}
		if (url.pathname === '/binary') {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(Buffer.from([1, 2, 3, 4]));
			return;
		}
		if (url.pathname === '/slow') {
			setTimeout(() => {
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end('late');
			}, 300);
			return;
		}
		if (url.pathname === '/error') {
			res.writeHead(500, { 'content-type': 'text/plain' });
			res.end('nope');
			return;
		}
		if (url.pathname === '/echo' && req.method === 'POST') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ body, contentType: req.headers['content-type'] }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function call(options) {
	return new Promise((resolve, reject) => {
		request(options, (err, response, body) => (err ? reject(err) : resolve({ response, body })));
	});
}

test('json:true parses the response body and supports qs', async () => {
	const { response, body } = await call({ url: `${baseUrl}/json`, qs: { q: 'owo' }, json: true });
	assert.strictEqual(response.statusCode, 200);
	assert.deepStrictEqual(body, { hello: 'world', q: 'owo' });
});

test('encoding:null returns a Buffer (image downloads)', async () => {
	const { body } = await call({ url: `${baseUrl}/binary`, encoding: null });
	assert.ok(Buffer.isBuffer(body));
	assert.deepStrictEqual([...body], [1, 2, 3, 4]);
});

test('defaults({encoding:null}) is honoured', async () => {
	const client = request.defaults({ encoding: null });
	const { body } = await new Promise((resolve, reject) =>
		client.get(`${baseUrl}/binary`, (err, response, value) =>
			err ? reject(err) : resolve({ response, body: value })
		)
	);
	assert.ok(Buffer.isBuffer(body));
});

test('timeouts produce an ETIMEDOUT error instead of hanging', async () => {
	await assert.rejects(call({ url: `${baseUrl}/slow`, timeout: 50 }), (err) => {
		assert.strictEqual(err.code, 'ETIMEDOUT');
		return true;
	});
});

test('non-2xx responses are returned, not thrown (request semantics)', async () => {
	const { response, body } = await call({ url: `${baseUrl}/error` });
	assert.strictEqual(response.statusCode, 500);
	assert.strictEqual(body, 'nope');
});

test('POST with json body sets content-type and serialises the payload', async () => {
	const { body } = await call({
		url: `${baseUrl}/echo`,
		method: 'POST',
		json: true,
		body: { a: 1 },
	});
	assert.strictEqual(body.contentType, 'application/json');
	assert.deepStrictEqual(JSON.parse(body.body), { a: 1 });
});

test('the callback fires exactly once', async () => {
	let calls = 0;
	await new Promise((resolve) => {
		request.get(`${baseUrl}/json`, () => {
			calls++;
			setTimeout(resolve, 100);
		});
	});
	assert.strictEqual(calls, 1);
});

test('connection failures surface as errors, never as exceptions', async () => {
	await assert.rejects(call({ url: 'http://127.0.0.1:1/nope', timeout: 500 }), (err) => {
		assert.ok(err instanceof Error);
		return true;
	});
});
