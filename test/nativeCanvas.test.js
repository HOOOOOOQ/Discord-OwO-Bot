const test = require('node:test');
const assert = require('node:assert');

const { freshRequire, withEnv } = require('./helpers.js');

function loadNativeCanvas(env = {}) {
	return withEnv({ LOG_LEVEL: 'error', ...env }, () => {
		freshRequire('../src/utils/log.js');
		return freshRequire('../src/utils/nativeCanvas.js');
	});
}

// --- optional canvas loader ----------------------------------------------

test('a missing canvas module degrades to null instead of throwing', () => {
	const nativeCanvas = loadNativeCanvas();
	assert.strictEqual(
		nativeCanvas.load(() => {
			throw new Error('Cannot find module canvas');
		}),
		null
	);
	const fake = { createCanvas: () => ({}) };
	assert.strictEqual(
		nativeCanvas.load(() => fake),
		fake
	);
	assert.strictEqual(typeof nativeCanvas.isAvailable(), 'boolean');
	assert.doesNotThrow(() => nativeCanvas.isAvailable());
});

test('the command registry still loads without the native canvas module', () => {
	// memegen commands used to require('canvas') at load time; a host without
	// cairo/pango would therefore fail to boot at all.
	assert.doesNotThrow(() => require('../src/commands/commandList/memegen/canvasUtil.js'));
	assert.doesNotThrow(() => require('../src/commands/commandList/memegen/isthisa.js'));
	assert.doesNotThrow(() => require('../src/commands/commandList/memegen/slapcar.js'));
	assert.doesNotThrow(() => require('../src/commands/commandList/memegen/spongebobchicken.js'));
});

test('memegen commands are gated when canvas is unavailable', async () => {
	const CommandInterface = require('../src/commands/CommandInterface.js');
	let replied = 0;
	const params = {
		msg: { channel: { type: 1 } },
		errorMsg: () => replied++,
	};
	const command = new CommandInterface({
		alias: ['fake'],
		group: ['memegeneration'],
		execute: () => {
			throw new Error('should never run without canvas');
		},
	});
	if (!require('../src/utils/nativeCanvas.js').isAvailable()) {
		await command.execute(params);
		assert.strictEqual(replied, 1);
	}
});

// --- merge-images replacement --------------------------------------------

function fakeCanvasLib() {
	const drawn = [];
	class FakeImage {
		constructor() {
			this.width = 10;
			this.height = 20;
		}
		set src(value) {
			this._src = value;
			if (value === 'broken') setImmediate(() => this.onerror && this.onerror('boom'));
			else setImmediate(() => this.onload && this.onload());
		}
		get src() {
			return this._src;
		}
	}
	const createCanvas = (width, height) => ({
		width,
		height,
		getContext: () => ({ drawImage: (image, x, y) => drawn.push({ src: image.src, x, y }) }),
		toDataURL: (type) => `data:${type};base64,AAAA`,
	});
	return { Image: FakeImage, createCanvas, drawn };
}

test('mergeImages composes sources and returns a data url', async () => {
	const mergeImages = require('../src/utils/mergeImages.js');
	const lib = fakeCanvasLib();

	const dataUrl = await mergeImages(['a.png', { src: 'b.png', x: 5, y: 7 }], {
		Canvas: lib,
		Image: lib.Image,
		createCanvas: lib.createCanvas,
	});

	assert.strictEqual(dataUrl, 'data:image/png;base64,AAAA');
	assert.deepStrictEqual(lib.drawn, [
		{ src: 'a.png', x: 0, y: 0 },
		{ src: 'b.png', x: 5, y: 7 },
	]);
});

test('mergeImages honours explicit size and format', async () => {
	const mergeImages = require('../src/utils/mergeImages.js');
	const lib = fakeCanvasLib();
	const sizes = [];
	const createCanvas = (width, height) => {
		sizes.push([width, height]);
		return lib.createCanvas(width, height);
	};

	const dataUrl = await mergeImages(['a.png'], {
		Canvas: lib,
		Image: lib.Image,
		createCanvas,
		width: 640,
		height: 480,
		format: 'image/jpeg',
	});

	assert.deepStrictEqual(sizes, [[640, 480]]);
	assert.strictEqual(dataUrl, 'data:image/jpeg;base64,AAAA');
});

test('mergeImages rejects invalid input instead of hanging', async () => {
	const mergeImages = require('../src/utils/mergeImages.js');
	const lib = fakeCanvasLib();
	const options = { Canvas: lib, Image: lib.Image, createCanvas: lib.createCanvas };

	await assert.rejects(mergeImages([], options), /at least one image source/);
	await assert.rejects(mergeImages([{}], options), /at least one image source/);
	await assert.rejects(mergeImages(['broken'], options), /failed to load image source/);
});
