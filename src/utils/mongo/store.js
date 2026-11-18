/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * A very small document-store interface so the SQL engine can run on top of
 * real MongoDB **and** on top of an in-memory store used by the test suite
 * (`test/mongoStore.js`). Both implement exactly the operations the engine and
 * the key/value layer need — nothing else.
 *
 * Supported update operators: `$set`, `$unset`, `$inc`, `$setOnInsert`, `$push`.
 * Supported query operators: `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex
 * $and $or $not $all`.
 */

const { compare } = require('./values.js');

function getPath(doc, path) {
	if (!path.includes('.')) return doc ? doc[path] : undefined;
	let current = doc;
	for (const part of path.split('.')) {
		if (current === null || current === undefined) return undefined;
		current = current[part];
	}
	return current;
}

function setPath(doc, path, value) {
	if (!path.includes('.')) {
		doc[path] = value;
		return;
	}
	const parts = path.split('.');
	let current = doc;
	for (let i = 0; i < parts.length - 1; i++) {
		if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) current[parts[i]] = {};
		current = current[parts[i]];
	}
	current[parts[parts.length - 1]] = value;
}

function unsetPath(doc, path) {
	if (!path.includes('.')) {
		delete doc[path];
		return;
	}
	const parts = path.split('.');
	let current = doc;
	for (let i = 0; i < parts.length - 1; i++) {
		current = current[parts[i]];
		if (!current) return;
	}
	delete current[parts[parts.length - 1]];
}

function conditionMatches(value, condition) {
	if (condition === null || condition === undefined) return value === null || value === undefined;
	if (typeof condition !== 'object' || condition instanceof Date) {
		if (value === null || value === undefined) return condition === null;
		return compare(value, condition) === 0;
	}
	if (Array.isArray(condition)) {
		return condition.some((item) => compare(value, item) === 0);
	}
	const keys = Object.keys(condition);
	if (!keys.length) return true;
	return keys.every((op) => {
		const operand = condition[op];
		switch (op) {
			case '$eq':
				return compare(value, operand) === 0;
			case '$ne':
				return compare(value, operand) !== 0;
			case '$gt':
				return value !== null && value !== undefined && compare(value, operand) > 0;
			case '$gte':
				return value !== null && value !== undefined && compare(value, operand) >= 0;
			case '$lt':
				return value !== null && value !== undefined && compare(value, operand) < 0;
			case '$lte':
				return value !== null && value !== undefined && compare(value, operand) <= 0;
			case '$in':
				return (operand || []).some((item) => compare(value, item) === 0);
			case '$nin':
				return !(operand || []).some((item) => compare(value, item) === 0);
			case '$exists':
				return operand ? value !== undefined : value === undefined;
			case '$regex': {
				const regex =
					operand instanceof RegExp ? operand : new RegExp(operand, condition.$options || '');
				return typeof value === 'string' && regex.test(value);
			}
			case '$options':
				return true;
			case '$not':
				return !conditionMatches(value, operand);
			case '$all':
				return (
					Array.isArray(value) && operand.every((item) => value.some((v) => compare(v, item) === 0))
				);
			case '$size':
				return Array.isArray(value) && value.length === operand;
			default:
				return false;
		}
	});
}

function documentMatches(doc, filter) {
	if (!filter) return true;
	if (Array.isArray(filter)) return filter.every((part) => documentMatches(doc, part));
	return Object.keys(filter).every((key) => {
		if (key === '$and') return (filter.$and || []).every((part) => documentMatches(doc, part));
		if (key === '$or') return (filter.$or || []).some((part) => documentMatches(doc, part));
		if (key === '$nor') return !(filter.$nor || []).some((part) => documentMatches(doc, part));
		return conditionMatches(getPath(doc, key), filter[key]);
	});
}

function applyUpdate(doc, update) {
	const result = Object.assign({}, doc);
	if (!update) return result;
	if (update.$set) {
		for (const path of Object.keys(update.$set)) setPath(result, path, update.$set[path]);
	}
	if (update.$unset) {
		for (const path of Object.keys(update.$unset)) unsetPath(result, path);
	}
	if (update.$inc) {
		for (const path of Object.keys(update.$inc)) {
			const current = getPath(result, path);
			const base = typeof current === 'number' ? current : Number(current || 0);
			setPath(result, path, base + Number(update.$inc[path]));
		}
	}
	if (update.$addToSet) {
		for (const path of Object.keys(update.$addToSet)) {
			const current = getPath(result, path);
			const list = Array.isArray(current) ? current.slice() : [];
			if (!list.some((item) => compare(item, update.$addToSet[path]) === 0)) {
				list.push(update.$addToSet[path]);
			}
			setPath(result, path, list);
		}
	}
	if (update.$pull) {
		for (const path of Object.keys(update.$pull)) {
			const current = getPath(result, path);
			if (!Array.isArray(current)) continue;
			setPath(
				result,
				path,
				current.filter((item) => compare(item, update.$pull[path]) !== 0)
			);
		}
	}
	if (update.$push) {
		for (const path of Object.keys(update.$push)) {
			const current = getPath(result, path);
			const list = Array.isArray(current) ? current.slice() : [];
			list.push(update.$push[path]);
			setPath(result, path, list);
		}
	}
	return result;
}

function sortDocuments(docs, sort) {
	if (!sort) return docs;
	const entries = typeof sort === 'string' ? [[sort, 1]] : Object.entries(sort);
	return docs.slice().sort((a, b) => {
		for (const [field, direction] of entries) {
			const factor = direction === -1 || direction === 'desc' || direction === 'DESC' ? -1 : 1;
			const cmp = compare(getPath(a, field), getPath(b, field));
			if (cmp !== 0) return cmp * factor;
		}
		return 0;
	});
}

/** In-memory store with the same async API as the MongoDB store. */
class MemoryStore {
	constructor() {
		this.collections = new Map();
		this.uniqueIndexes = new Map();
	}

	async connect() {
		return this;
	}

	async close() {
		return undefined;
	}

	collection(name) {
		if (!this.collections.has(name)) this.collections.set(name, new Map());
		if (!this.uniqueIndexes.has(name)) this.uniqueIndexes.set(name, []);
		const docs = this.collections.get(name);
		const indexes = this.uniqueIndexes.get(name);

		const checkUnique = (doc, ignoreId) => {
			for (const index of indexes) {
				const same = [...docs.values()].find(
					(other) =>
						other._id !== ignoreId &&
						index.fields.every((field) => compare(getPath(other, field), getPath(doc, field)) === 0)
				);
				if (same) {
					const err = new Error(`E11000 duplicate key error index: ${name}.${index.name}`);
					err.code = 11000;
					throw err;
				}
			}
		};

		return {
			name,
			async find(filter = {}, options = {}) {
				let result = [...docs.values()].filter((doc) => documentMatches(doc, filter));
				if (options.sort) result = sortDocuments(result, options.sort);
				if (options.skip) result = result.slice(options.skip);
				if (options.limit) result = result.slice(0, options.limit);
				return result.map((doc) => JSON.parse(JSON.stringify(doc)));
			},
			async findOne(filter = {}, options = {}) {
				const found = await this.find(filter, Object.assign({}, options, { limit: 1 }));
				return found[0] || null;
			},
			async insertOne(doc) {
				const record = JSON.parse(JSON.stringify(doc));
				if (record._id === undefined) record._id = `${name}-${docs.size}-${Date.now()}`;
				if (docs.has(record._id)) {
					const err = new Error(`E11000 duplicate key error index: ${name}._id_`);
					err.code = 11000;
					throw err;
				}
				checkUnique(record, record._id);
				docs.set(record._id, record);
				return { insertedId: record._id };
			},
			async insertMany(list) {
				const ids = [];
				for (const doc of list) ids.push((await this.insertOne(doc)).insertedId);
				return { insertedIds: ids };
			},
			async updateOne(filter = {}, update = {}, options = {}) {
				const existing = [...docs.values()].find((doc) => documentMatches(doc, filter));
				if (!existing) {
					if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
					const base = {};
					for (const path of Object.keys(update.$setOnInsert || {}))
						setPath(base, path, update.$setOnInsert[path]);
					const merged = applyUpdate(Object.assign(base, filter), update);
					await this.insertOne(merged);
					return { matchedCount: 0, modifiedCount: 0, upsertedId: merged._id, upserted: true };
				}
				const next = applyUpdate(existing, update);
				checkUnique(next, existing._id);
				if (next._id !== existing._id) docs.delete(existing._id);
				docs.set(next._id, next);
				return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
			},
			async updateMany(filter = {}, update = {}) {
				const targets = [...docs.values()].filter((doc) => documentMatches(doc, filter));
				for (const doc of targets) {
					const next = applyUpdate(doc, update);
					if (next._id !== doc._id) docs.delete(doc._id);
					docs.set(next._id, next);
				}
				return { matchedCount: targets.length, modifiedCount: targets.length };
			},
			async findOneAndUpdate(filter = {}, update = {}, options = {}) {
				// Same contract as the MongoDB driver with includeResultMetadata:false
				// plus returnDocument:'after' — the updated document (or null).
				await this.updateOne(filter, update, options);
				return this.findOne(filter);
			},
			async deleteMany(filter = {}) {
				const targets = [...docs.values()].filter((doc) => documentMatches(doc, filter));
				for (const doc of targets) docs.delete(doc._id);
				return { deletedCount: targets.length };
			},
			async deleteOne(filter = {}) {
				const target = [...docs.values()].find((doc) => documentMatches(doc, filter));
				if (!target) return { deletedCount: 0 };
				docs.delete(target._id);
				return { deletedCount: 1 };
			},
			async countDocuments(filter = {}) {
				return [...docs.values()].filter((doc) => documentMatches(doc, filter)).length;
			},
			async distinct(field, filter = {}) {
				const values = [];
				for (const doc of docs.values()) {
					if (!documentMatches(doc, filter)) continue;
					const value = getPath(doc, field);
					if (!values.some((existing) => compare(existing, value) === 0)) values.push(value);
				}
				return values;
			},
			async createIndex(fields, options = {}) {
				if (options.unique)
					indexes.push({
						name: options.name || Object.keys(fields).join('_'),
						fields: Object.keys(fields),
					});
				return options.name || Object.keys(fields).join('_');
			},
		};
	}
}

/** Real MongoDB store, used by the bot. */
class MongoStore {
	constructor(options = {}) {
		this.uri = options.uri;
		this.dbName = options.dbName;
		this.log = options.log || console;
		this.client = null;
		this.db = null;
		this._collections = new Map();
	}

	async connect() {
		if (this.db) return this;
		const { MongoClient } = require('mongodb');
		this.client = new MongoClient(this.uri, {
			serverSelectionTimeoutMS: Number.parseInt(process.env.MONGODB_TIMEOUT_MS, 10) || 15000,
			maxPoolSize: Number.parseInt(process.env.MONGODB_POOL_SIZE, 10) || 20,
			retryWrites: true,
			retryReads: true,
		});
		await this.client.connect();
		this.db = this.client.db(this.dbName);
		await this.db.command({ ping: 1 });
		return this;
	}

	async close() {
		if (!this.client) return;
		try {
			await this.client.close();
		} finally {
			this.client = null;
			this.db = null;
		}
	}

	collection(name, session) {
		if (!this.db) throw new Error('MongoDB is not connected yet');
		const key = session ? `${name}@${session.id}` : name;
		const collection = this.db.collection(name);
		const wrap = {
			name,
			async find(filter = {}, options = {}) {
				let cursor = collection.find(filter || {});
				if (options.sort) cursor = cursor.sort(options.sort);
				if (options.skip) cursor = cursor.skip(options.skip);
				if (options.limit) cursor = cursor.limit(options.limit);
				if (options.projection) cursor = cursor.project(options.projection);
				return cursor.toArray();
			},
			async findOne(filter = {}, options = {}) {
				return collection.findOne(
					filter || {},
					options.projection ? { projection: options.projection } : {}
				);
			},
			async insertOne(doc) {
				return collection.insertOne(doc, session ? { session } : {});
			},
			async insertMany(list) {
				return collection.insertMany(
					list,
					Object.assign({ ordered: true }, session ? { session } : {})
				);
			},
			async updateOne(filter = {}, update = {}, options = {}) {
				return collection.updateOne(filter || {}, update, {
					upsert: !!options.upsert,
					...(session ? { session } : {}),
				});
			},
			async updateMany(filter = {}, update = {}) {
				return collection.updateMany(filter || {}, update, session ? { session } : {});
			},
			async findOneAndUpdate(filter = {}, update = {}, options = {}) {
				return collection.findOneAndUpdate(filter || {}, update, {
					upsert: !!options.upsert,
					returnDocument: options.returnDocument || 'after',
					includeResultMetadata: false,
					...(session ? { session } : {}),
				});
			},
			async deleteMany(filter = {}) {
				return collection.deleteMany(filter || {}, session ? { session } : {});
			},
			async deleteOne(filter = {}) {
				return collection.deleteOne(filter || {}, session ? { session } : {});
			},
			async countDocuments(filter = {}) {
				return collection.countDocuments(filter || {}, session ? { session } : {});
			},
			async distinct(field, filter = {}) {
				return collection.distinct(field, filter || {}, session ? { session } : {});
			},
			async createIndex(fields, options = {}) {
				return collection.createIndex(fields, options);
			},
		};
		this._collections.set(key, wrap);
		return wrap;
	}

	/** A MongoDB session + transaction, or `null` when the server has no support. */
	async startSession() {
		if (!this.client) throw new Error('MongoDB is not connected yet');
		let session;
		try {
			session = this.client.startSession();
		} catch (err) {
			this.log.warn(`[MONGO] transactions unavailable: ${err.message}`);
			return null;
		}
		try {
			session.startTransaction();
			return session;
		} catch (err) {
			await session.endSession().catch(() => {});
			this.log.warn(`[MONGO] transactions unavailable: ${err.message}`);
			return null;
		}
	}
}

module.exports = {
	MemoryStore,
	MongoStore,
	documentMatches,
	applyUpdate,
	sortDocuments,
	getPath,
	setPath,
};
