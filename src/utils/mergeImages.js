/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Small drop-in replacement for the `merge-images` package.
 *
 * The original dependency was pulled from a git URL whose devDependencies
 * include `canvas`; npm prepares git dependencies by installing their dev
 * dependencies, so an install on a host without cairo/pango failed even before
 * our own dependencies were considered. This implementation uses the same API:
 *
 *   mergeImages(['a.png', { src: 'b.png', x: 10, y: 20 }], { width, height })
 *     -> Promise<dataURL>
 *
 * `options.Canvas` / `options.Image` can be injected (same as upstream) which is
 * also how the unit tests run without the native module.
 */

const nativeCanvas = require('./nativeCanvas.js');

function loadImage(ImageCtor, source) {
	return new Promise((resolve, reject) => {
		let image;
		try {
			image = new ImageCtor();
		} catch (err) {
			reject(err);
			return;
		}
		image.onload = () => resolve(image);
		image.onerror = (err) =>
			reject(err instanceof Error ? err : new Error('failed to load image source'));
		try {
			image.src = source;
		} catch (err) {
			reject(err);
		}
	});
}

module.exports = function mergeImages(sources, options = {}) {
	return new Promise((resolve, reject) => {
		const canvasLib = options.Canvas && options.Image ? options : nativeCanvas.load();
		if (!canvasLib) {
			reject(new Error('canvas module is not available'));
			return;
		}
		const createCanvas = options.createCanvas || canvasLib.createCanvas;
		const ImageCtor = options.Image || canvasLib.Image;

		const list = (Array.isArray(sources) ? sources : [sources]).map((source) =>
			typeof source === 'string' || Buffer.isBuffer(source)
				? { src: source, x: 0, y: 0 }
				: { x: 0, y: 0, ...source }
		);
		if (list.length === 0 || !list.every((source) => source.src !== undefined)) {
			reject(new Error('mergeImages needs at least one image source'));
			return;
		}

		Promise.all(
			list.map((source) => loadImage(ImageCtor, source.src).then((image) => ({ source, image })))
		)
			.then((loaded) => {
				const first = loaded[0].image;
				const width = options.width || first.width;
				const height = options.height || first.height;
				if (!width || !height) {
					throw new Error('could not determine canvas size from the image sources');
				}

				const canvas = createCanvas(width, height);
				const ctx = canvas.getContext('2d');
				for (const { source, image } of loaded) {
					ctx.drawImage(image, source.x, source.y);
				}

				resolve(canvas.toDataURL(options.format || 'image/png', options.quality));
			})
			.catch(reject);
	});
};
