const test = require('node:test');
const assert = require('node:assert');

const CommandInterface = require('../src/commands/CommandInterface.js');
const { analyze, flatten, KNOWN_SHADOWED_ALIASES } = require('../scripts/verifyCommands.js');

function command(aliases, extra = {}) {
	return new CommandInterface({ alias: aliases, execute: () => {}, ...extra });
}

test('clean registries produce no issues', () => {
	const result = analyze([
		{ source: 'a', command: command(['alpha']) },
		{ source: 'b', command: command(['beta', 'b']) },
	]);
	assert.deepStrictEqual(result.issues, []);
	assert.strictEqual(result.instances, 2);
	assert.strictEqual(result.aliases, 3);
	assert.deepStrictEqual(result.aliasList, ['alpha', 'b', 'beta']);
});

test('duplicate aliases across modules are reported', () => {
	const result = analyze([
		{ source: 'first', command: command(['same']) },
		{ source: 'second', command: command(['same']) },
	]);
	assert.strictEqual(result.issues.length, 1);
	assert.match(result.issues[0], /duplicate alias "same" in first and second/);
});

test('the documented collectible collision is a warning, not a failure', () => {
	for (const alias of KNOWN_SHADOWED_ALIASES) {
		const result = analyze([
			{ source: 'collectible', command: command([alias]) },
			{ source: 'collectibleClasses', command: command([alias]) },
		]);
		assert.deepStrictEqual(result.issues, [], `${alias} must be treated as known shadowing`);
		assert.strictEqual(result.shadowed.length, 1);
	}
});

test('the same instance reachable twice is only counted once', () => {
	const shared = command(['shared']);
	const result = analyze([
		{ source: 'x', command: shared },
		{ source: 'y', command: shared },
	]);
	assert.deepStrictEqual(result.issues, []);
	assert.strictEqual(result.instances, 1, 'the same instance is counted once');
	assert.strictEqual(result.aliases, 1);
});

test('empty aliases and mixed case aliases are rejected', () => {
	const result = analyze([
		{ source: 'bad', command: command(['']) },
		{ source: 'worse', command: command(['NotLower']) },
	]);
	assert.strictEqual(result.issues.length, 2);
});

test('flatten walks nested directories and arrays without duplicates', () => {
	const one = command(['one']);
	const two = command(['two']);
	const dir = { a: one, nested: { b: two }, list: [one, two] };
	const flat = flatten(dir);
	assert.strictEqual(flat.length, 2);
	const flattened = flat.map((entry) => entry.command.alias[0]).sort();
	assert.deepStrictEqual(flattened, ['one', 'two']);
});

test('owner and staff command counts are reported', () => {
	const result = analyze([
		{ source: 'owner', command: command(['own'], { owner: true }) },
		{ source: 'admin', command: command(['adm'], { admin: true }) },
		{ source: 'user', command: command(['usr']) },
	]);
	assert.strictEqual(result.ownerCommands, 1);
	assert.strictEqual(result.adminCommands, 2);
	assert.deepStrictEqual(result.ownerAliasList, ['own']);
});
