/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Executes the parsed SQL statements against MongoDB collections.
 *
 * Design rules:
 *
 * 1. A SQL table is a MongoDB collection of the same name; one document per row,
 *    one field per column. `_id` is the primary key encoded as a string, so a
 *    primary-key lookup is a single indexed `_id` query and `ON DUPLICATE KEY`
 *    is an upsert on that `_id`.
 * 2. Exact integer arithmetic: Discord ids do not fit in a JS number, so integer
 *    values that exceed the safe range are stored as decimal strings and
 *    compared with BigInt (see `values.js`).
 * 3. Atomic money/inventory updates: `col = col + ?` becomes `$inc`, which
 *    MongoDB applies atomically. Complex expressions fall back to a guarded
 *    read-modify-write with retries.
 * 4. WHERE is always re-checked in JS after an optional index-friendly
 *    pre-filter, so a pushdown can never change the result set.
 */

const { parse } = require('./parser.js');
const values = require('../values.js');
const { getTable } = require('../schema.js');
const log = require('../../log.js');

const MAX_RETRIES = 4;
const SEQUENCE_COLLECTION = '_sequences';
const DEFAULT_SCAN_LIMIT = Number.parseInt(process.env.MONGO_MAX_SCAN, 10) || 200000;

class SqlError extends Error {
	constructor(message, statement) {
		super(message);
		this.name = 'SqlError';
		this.statement = statement;
	}
}

function isOkPacket(result) {
	return result && result.__ok === true;
}

function okPacket(insertId, affectedRows, changedRows) {
	return {
		__ok: true,
		fieldCount: 0,
		affectedRows: affectedRows === undefined ? 0 : affectedRows,
		insertId: insertId === undefined ? 0 : insertId,
		info: '',
		serverStatus: 0,
		warningCount: 0,
		message: '',
		changedRows: changedRows === undefined ? affectedRows || 0 : changedRows,
	};
}

function truthy(value) {
	if (value === null || value === undefined) return false;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') return value !== '' && value !== '0';
	return true;
}

function columnKey(node) {
	if (!node || node.type !== 'column') return null;
	return node.table ? `${node.table}.${node.name}` : node.name;
}

/** Collect the column names an expression reads, to detect self-references. */
function referencedColumns(node, out = []) {
	if (!node || typeof node !== 'object') return out;
	if (node.type === 'column') {
		out.push(node.name);
		return out;
	}
	for (const key of Object.keys(node)) {
		const value = node[key];
		if (Array.isArray(value)) value.forEach((item) => referencedColumns(item, out));
		else if (value && typeof value === 'object') referencedColumns(value, out);
	}
	return out;
}

class Executor {
	constructor(options = {}) {
		this.store = options.store;
		this.schema = options.schema || getTable;
		this.log = options.log || log;
		this.session = options.session || null;
		this.paramIndex = 0;
		this.params = [];
		this.outer = null;
		this.generatedCache = new Map();
	}

	table(name) {
		const table = this.schema(name);
		if (!table) throw new SqlError(`unknown table "${name}"`);
		return table;
	}

	collection(name) {
		return this.store.collection(name, this.session);
	}

	async execute(sql, params = []) {
		const statements = this.parseCached(sql);
		// Placeholders are bound once, before any row is visited: a WHERE clause
		// must not consume the same `?` again for every document it inspects.
		const counter = { value: 0 };
		const bound = statements.map((statement) => this.bindParams(statement, params || [], counter));
		const results = [];
		for (const statement of bound) {
			results.push(await this.run(statement, params, sql));
		}
		return statements.length === 1 ? results[0] : results;
	}

	/** Replaces every `?` with the parameter it stands for, in source order. */
	bindParams(node, params, counter) {
		if (Array.isArray(node)) return node.map((item) => this.bindParams(item, params, counter));
		if (!node || typeof node !== 'object') return node;
		if (node.type === 'param') {
			const value = params[counter.value++];
			return { type: 'literal', value: value === undefined ? null : value };
		}
		const copy = {};
		for (const key of Object.keys(node)) copy[key] = this.bindParams(node[key], params, counter);
		return copy;
	}

	parseCached(sql) {
		if (!this._cache) this._cache = new Map();
		const key = sql;
		if (this._cache.has(key)) return this._cache.get(key);
		const statements = parse(key);
		if (this._cache.size > 500) this._cache.clear();
		this._cache.set(key, statements);
		return statements;
	}

	async run(statement, params, sql) {
		this.params = params || [];
		try {
			switch (statement.type) {
				case 'control':
					return okPacket(0, 0);
				case 'select':
					return this.runSelect(statement);
				case 'insert':
					return this.runInsert(statement);
				case 'update':
					return this.runUpdate(statement);
				case 'delete':
					return this.runDelete(statement);
				default:
					throw new SqlError(`unsupported statement type "${statement.type}"`, sql);
			}
		} catch (err) {
			if (err instanceof SqlError) throw err;
			throw new SqlError(`${err.message} :: ${sql.trim().slice(0, 200)}`, sql);
		}
	}

	// ------------------------------------------------------------------ values

	param() {
		// Binding happens in bindParams() before execution; anything left is a bug
		// in the parser, so return null instead of shifting a shared index.
		return null;
	}

	/** Every alias that a row context knows about, in FROM order. */
	aliasNames(ctx) {
		return ctx.aliases;
	}

	resolveColumn(node, ctx) {
		if (node.table) {
			const doc = ctx.values[node.table];
			if (doc === undefined) {
				const doc2 = ctx.values[node.table.toLowerCase()];
				if (doc2 === undefined) return null;
				return doc2[node.name] === undefined ? null : doc2[node.name];
			}
			return doc[node.name] === undefined ? null : doc[node.name];
		}
		for (const alias of ctx.aliases) {
			const doc = ctx.values[alias];
			if (doc && Object.prototype.hasOwnProperty.call(doc, node.name)) return doc[node.name];
		}
		// not in the row: maybe it is an alias of a projection (ORDER BY alias)
		if (ctx.projection && Object.prototype.hasOwnProperty.call(ctx.projection, node.name)) {
			return ctx.projection[node.name];
		}
		return null;
	}

	async evalExpr(node, ctx) {
		if (node === null || node === undefined) return null;
		switch (node.type) {
			case 'literal':
				return node.value;
			case 'param':
				return this.param();
			case 'star':
				return null;
			case 'column': {
				// Virtual columns are always recomputed, never trusted from the
				// document (MySQL does exactly that for GENERATED ... VIRTUAL).
				const table = node.table || ctx.primaryAlias;
				const generated = this.generatedValue(table, node.name, ctx);
				if (generated !== null && generated !== undefined) return generated;
				return this.resolveColumn(node, ctx);
			}
			case 'unary': {
				if (node.op === 'NOT') return !truthy(await this.evalExpr(node.expr, ctx));
				const value = await this.evalExpr(node.expr, ctx);
				if (node.op === '-') return values.arithmetic('*', value, -1);
				if (node.op === '~') return ~Number(value || 0);
				return value;
			}
			case 'binary':
				return this.evalBinary(node, ctx);
			case 'is': {
				const value = await this.evalExpr(node.expr, ctx);
				let result;
				if (node.what === 'null') result = value === null || value === undefined;
				else if (node.what === 'true') result = truthy(value);
				else result = !truthy(value);
				return node.not ? !result : result;
			}
			case 'between': {
				const value = await this.evalExpr(node.expr, ctx);
				const low = await this.evalExpr(node.low, ctx);
				const high = await this.evalExpr(node.high, ctx);
				if (value === null) return null;
				const inside = values.compare(value, low) >= 0 && values.compare(value, high) <= 0;
				return node.not ? !inside : inside;
			}
			case 'like': {
				const value = await this.evalExpr(node.expr, ctx);
				const pattern = await this.evalExpr(node.pattern, ctx);
				if (value === null || pattern === null) return null;
				const matches = values.likeToRegExp(pattern).test(String(value));
				return node.not ? !matches : matches;
			}
			case 'in': {
				const value = await this.evalExpr(node.expr, ctx);
				if (value === null) return null;
				let list = node.values;
				if (node.subquery) {
					const rows = await this.runSelect(node.subquery, ctx);
					list = [];
					for (const row of rows) {
						const first = Object.values(row)[0];
						list.push({ type: 'literal', value: first });
					}
				}
				let found = false;
				for (const item of list) {
					const candidate = await this.evalExpr(item, ctx);
					if (values.compare(value, candidate) === 0) {
						found = true;
						break;
					}
				}
				return node.not ? !found : found;
			}
			case 'exists': {
				const rows = await this.runSelect(node.select, ctx);
				const exists = rows.length > 0;
				return node.not ? !exists : exists;
			}
			case 'subquery': {
				const rows = await this.runSelect(node.select, ctx);
				if (!rows.length) return null;
				return Object.values(rows[0])[0];
			}
			case 'case': {
				const operand = node.operand ? await this.evalExpr(node.operand, ctx) : undefined;
				for (const branch of node.whens) {
					const when = await this.evalExpr(branch.when, ctx);
					const hit =
						node.operand === null
							? truthy(when)
							: operand !== null && values.compare(operand, when) === 0;
					if (hit) return this.evalExpr(branch.then, ctx);
				}
				return node.elseValue ? this.evalExpr(node.elseValue, ctx) : null;
			}
			case 'aggregate':
				return this.evalAggregate(node, ctx);
			case 'func':
				return this.evalFunc(node, ctx);
			default:
				throw new SqlError(`unsupported expression "${node.type}"`);
		}
	}

	async evalBinary(node, ctx) {
		if (node.op === 'AND') {
			const left = await this.evalExpr(node.left, ctx);
			if (left !== null && !truthy(left)) return false;
			const right = await this.evalExpr(node.right, ctx);
			if (right !== null && !truthy(right)) return false;
			if (left === null || right === null) return null;
			return truthy(left) && truthy(right);
		}
		if (node.op === 'OR') {
			const left = await this.evalExpr(node.left, ctx);
			if (truthy(left)) return true;
			const right = await this.evalExpr(node.right, ctx);
			if (truthy(right)) return true;
			if (left === null || right === null) return null;
			return false;
		}
		const left = await this.evalExpr(node.left, ctx);
		const right = await this.evalExpr(node.right, ctx);
		switch (node.op) {
			case '+':
			case '-':
			case '*':
			case '/':
			case '%':
				return values.arithmetic(node.op, left, right);
			case '=':
				if (left === null || right === null) return null;
				return values.compare(left, right) === 0;
			case '<=>':
				return values.compare(left, right) === 0 && (left === null) === (right === null);
			case '!=':
				if (left === null || right === null) return null;
				return values.compare(left, right) !== 0;
			case '<':
				if (left === null || right === null) return null;
				return values.compare(left, right) < 0;
			case '>':
				if (left === null || right === null) return null;
				return values.compare(left, right) > 0;
			case '<=':
				if (left === null || right === null) return null;
				return values.compare(left, right) <= 0;
			case '>=':
				if (left === null || right === null) return null;
				return values.compare(left, right) >= 0;
			case '&':
				return Number(left || 0) & Number(right || 0);
			case '|':
				return Number(left || 0) | Number(right || 0);
			case '^':
				return Number(left || 0) ^ Number(right || 0);
			case '<<':
				return Number(left || 0) << Number(right || 0);
			case '>>':
				return Number(left || 0) >> Number(right || 0);
			default:
				throw new SqlError(`unsupported operator "${node.op}"`);
		}
	}

	async evalFunc(node, ctx) {
		const name = node.name;
		if (name === 'NOW' || name === 'CURRENT_TIMESTAMP' || name === 'SYSDATE')
			return values.nowString();
		if (name === 'CURDATE' || name === 'CURRENT_DATE') return values.todayString();
		const args = [];
		for (const arg of node.args) args.push(await this.evalExpr(arg, ctx));
		switch (name) {
			case 'IF':
				return truthy(args[0]) ? args[1] : args[2];
			case 'IFNULL':
				return args[0] === null || args[0] === undefined ? args[1] : args[0];
			case 'NULLIF':
				return values.compare(args[0], args[1]) === 0 ? null : args[0];
			case 'COALESCE': {
				for (const value of args) if (value !== null && value !== undefined) return value;
				return null;
			}
			case 'GREATEST': {
				let best = null;
				for (const value of args) {
					if (value === null || value === undefined) continue;
					if (best === null || values.compare(value, best) > 0) best = value;
				}
				return best;
			}
			case 'LEAST': {
				let best = null;
				for (const value of args) {
					if (value === null || value === undefined) continue;
					if (best === null || values.compare(value, best) < 0) best = value;
				}
				return best;
			}
			case 'ABS':
				return Math.abs(Number(args[0] || 0));
			case 'ROUND':
				return args.length > 1
					? Number(Number(args[0] || 0).toFixed(Number(args[1])))
					: Math.round(Number(args[0] || 0));
			case 'FLOOR':
				return Math.floor(Number(args[0] || 0));
			case 'CEIL':
			case 'CEILING':
				return Math.ceil(Number(args[0] || 0));
			case 'CONCAT':
				return args.every((v) => v === null || v === undefined)
					? null
					: args.map((v) => (v === null || v === undefined ? '' : v)).join('');
			case 'LOWER':
			case 'LCASE':
				return args[0] === null ? null : String(args[0]).toLowerCase();
			case 'UPPER':
			case 'UCASE':
				return args[0] === null ? null : String(args[0]).toUpperCase();
			case 'TRIM':
				return args[0] === null ? null : String(args[0]).trim();
			case 'LENGTH':
			case 'CHAR_LENGTH':
				return args[0] === null ? null : String(args[0]).length;
			case 'SUBSTRING':
			case 'SUBSTR': {
				if (args[0] === null) return null;
				const text = String(args[0]);
				const start = Math.max(0, Number(args[1] || 1) - 1);
				return args.length > 2 ? text.substr(start, Number(args[2])) : text.substr(start);
			}
			case 'TIMESTAMPDIFF':
				return values.timestampDiff(args[0], args[1], args[2]);
			case 'DATE':
				return args[0] === null ? null : values.todayString(values.toDate(args[0]) || undefined);
			case 'UNIX_TIMESTAMP': {
				const date =
					args[0] === null || args[0] === undefined ? new Date() : values.toDate(args[0]);
				return date ? Math.floor(date.getTime() / 1000) : null;
			}
			case 'VALUES': {
				// handled through contexts: keep the insert value available
				const key = String(args[0]);
				if (ctx.insertedRow && Object.prototype.hasOwnProperty.call(ctx.insertedRow, key)) {
					return ctx.insertedRow[key];
				}
				return this.resolveColumn({ type: 'column', table: null, name: key }, ctx);
			}
			case 'RAND':
				return Math.random();
			case 'CAST':
			case 'CONVERT':
				return args[0];
			default:
				throw new SqlError(`unsupported SQL function "${name}"`);
		}
	}

	async evalAggregate(node, ctx) {
		const group = ctx.group;
		if (!group) throw new SqlError(`aggregate ${node.name} used outside of a grouped query`);
		if (node.name === 'COUNT') {
			if (!node.arg || node.arg.type === 'star') return group.length;
			let count = 0;
			const seen = new Set();
			for (const row of group) {
				const value = await this.evalExpr(node.arg, row);
				if (value === null || value === undefined) continue;
				if (node.distinct) {
					const key = String(value);
					if (seen.has(key)) continue;
					seen.add(key);
				}
				count++;
			}
			return count;
		}
		const numbers = [];
		const raw = [];
		for (const row of group) {
			const value = await this.evalExpr(node.arg, row);
			if (value === null || value === undefined) continue;
			raw.push(value);
			numbers.push(Number(value));
		}
		if (!raw.length) return null;
		switch (node.name) {
			case 'SUM':
				return numbers.reduce((sum, value) => sum + value, 0);
			case 'MAX':
				return raw.reduce((best, value) => (values.compare(value, best) > 0 ? value : best));
			case 'MIN':
				return raw.reduce((best, value) => (values.compare(value, best) < 0 ? value : best));
			case 'AVG':
				return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
			case 'GROUP_CONCAT':
				return raw.join(',');
			default:
				throw new SqlError(`unsupported aggregate "${node.name}"`);
		}
	}

	// ------------------------------------------------------------- generated

	generatedValue(tableName, columnName, ctx) {
		const table = this.schema(tableName) || this.schema(String(tableName).toLowerCase());
		if (!table) return null;
		const column = table.columnsByName[columnName];
		if (!column || !column.generated) return null;
		const key = `${table.name}.${columnName}`;
		let expression = this.generatedCache.get(key);
		if (!expression) {
			const cleaned = column.generated.replace(/`/g, '');
			const statements = parse(`SELECT ${cleaned}`);
			expression = statements[0].items[0].expr;
			this.generatedCache.set(key, expression);
		}
		return this.evalExpr(expression, ctx);
	}

	// ------------------------------------------------------------------ rows

	async fetchTable(tableName, alias, _outer) {
		const table = this.table(tableName);
		const docs = await this.collection(table.name).find({}, { limit: DEFAULT_SCAN_LIMIT });
		const rows = docs.map((doc) => {
			const ctx = { aliases: [alias], values: {}, primaryAlias: alias };
			ctx.values[alias] = doc;
			return ctx;
		});
		if (rows.length >= DEFAULT_SCAN_LIMIT) {
			this.log.warn(
				`[MONGO] table ${table.name} exceeded MONGO_MAX_SCAN (${DEFAULT_SCAN_LIMIT} rows); ` +
					'results may be incomplete — raise MONGO_MAX_SCAN'
			);
		}
		return rows;
	}

	async buildRows(statement, outer = null) {
		let rows;
		if (!statement.from) {
			rows = [{ aliases: [], values: {}, primaryAlias: null }];
		} else {
			rows = await this.sourceRows(statement.from, outer);
		}
		for (const join of statement.joins || []) {
			const next = [];
			const joined = await this.sourceRows(join.target, outer);
			for (const left of rows) {
				let matched = false;
				for (const right of joined) {
					const merged = this.mergeContexts(left, right);
					if (!join.on || truthy(await this.evalExpr(join.on, merged))) {
						next.push(merged);
						matched = true;
					}
				}
				if (!matched && (join.kind === 'LEFT' || join.kind === 'OUTER')) {
					next.push(this.mergeContexts(left, this.nullContext(join.target)));
				}
			}
			rows = next;
		}
		return rows;
	}

	mergeContexts(left, right) {
		const merged = {
			// `left` is the inner scope: an unqualified column resolves against it
			// first, so a correlated subquery sees its own table's columns.
			aliases: left.aliases.concat(right.aliases),
			values: Object.assign({}, right.values, left.values),
			primaryAlias: left.primaryAlias,
			group: left.group,
			projection: left.projection,
			insertedRow: left.insertedRow,
		};
		return merged;
	}

	nullContext(target) {
		const alias = target.alias || (target.table ? target.table : 'sub');
		return { aliases: [alias], values: { [alias]: {} }, primaryAlias: alias };
	}

	async sourceRows(source, outer) {
		if (source.subselect) {
			const rows = await this.runSelect(source.subselect, outer || null);
			return rows.map((row) => {
				const ctx = {
					aliases: [source.alias],
					values: { [source.alias]: row },
					primaryAlias: source.alias,
				};
				return ctx;
			});
		}
		return this.fetchTable(source.table, source.alias || source.table, outer);
	}

	async filterRows(statement, rows, outer) {
		if (!statement.where) return rows;
		const kept = [];
		for (const row of rows) {
			if (outer) {
				row.outerValues = outer.values;
				row.outerAliases = outer.aliases;
			}
			if (truthy(await this.evalExpr(statement.where, this.withOuter(row, outer)))) kept.push(row);
		}
		return kept;
	}

	withOuter(row, outer) {
		if (!outer) return row;
		const merged = this.mergeContexts(row, outer);
		merged.primaryAlias = row.primaryAlias;
		merged.group = row.group;
		merged.insertedRow = row.insertedRow;
		return merged;
	}

	// ----------------------------------------------------------------- select

	async runSelect(statement, outer = null) {
		let rows = await this.buildRows(statement, outer);
		if (statement.where) {
			const kept = [];
			for (const row of rows) {
				const ctx = this.withOuter(row, outer);
				if (truthy(await this.evalExpr(statement.where, ctx))) kept.push(row);
			}
			rows = kept;
		}

		const grouped =
			statement.groupBy.length > 0 ||
			statement.items.some((item) => this.containsAggregate(item.expr));

		// Each entry keeps the source row context so ORDER BY can still read the
		// original columns, not just the projected aliases.
		const entries = [];
		if (grouped) {
			const groups = new Map();
			if (!statement.groupBy.length) {
				groups.set('__all__', rows);
			} else {
				for (const row of rows) {
					const ctx = this.withOuter(row, outer);
					const keyParts = [];
					for (const expr of statement.groupBy)
						keyParts.push(String(await this.evalExpr(expr, ctx)));
					const key = keyParts.join('\u0001');
					if (!groups.has(key)) groups.set(key, []);
					groups.get(key).push(row);
				}
			}
			for (const group of groups.values()) {
				const base = group[0] || { aliases: [], values: {}, primaryAlias: null };
				const ctx = this.withOuter(Object.assign({}, base), outer);
				ctx.group = group;
				if (statement.having && !truthy(await this.evalExpr(statement.having, ctx))) continue;
				entries.push({ row: await this.project(statement, ctx), ctx });
			}
		} else {
			for (const row of rows) {
				const ctx = this.withOuter(row, outer);
				entries.push({ row: await this.project(statement, ctx), ctx });
			}
		}

		let output = entries;
		if (statement.distinct) {
			const seen = new Set();
			output = output.filter((entry) => {
				const key = JSON.stringify(entry.row);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		if (statement.orderBy && statement.orderBy.length) {
			const decorated = [];
			for (let i = 0; i < output.length; i++) {
				const entry = output[i];
				const keys = [];
				for (const order of statement.orderBy) keys.push(await this.orderKey(order.expr, entry));
				decorated.push({ entry, keys, index: i });
			}
			decorated.sort((a, b) => {
				for (let i = 0; i < a.keys.length; i++) {
					const direction = statement.orderBy[i].direction;
					const cmp = values.compare(a.keys[i], b.keys[i]);
					if (cmp !== 0) return cmp * direction;
				}
				return a.index - b.index;
			});
			output = decorated.map((item) => item.entry);
		}

		let result = output.map((entry) => entry.row);
		const offset = Number(statement.offset) || 0;
		if (offset) result = result.slice(offset);
		if (statement.limit !== null && statement.limit !== undefined) {
			const limit = Number(statement.limit);
			if (!Number.isNaN(limit)) result = result.slice(0, limit);
		}
		return result;
	}

	/** ORDER BY prefers a projected alias, then the source row, then an expression. */
	async orderKey(expr, entry) {
		if (expr.type === 'column' && !expr.table) {
			if (Object.prototype.hasOwnProperty.call(entry.row, expr.name)) return entry.row[expr.name];
			if (entry.ctx && entry.ctx.values) {
				for (const alias of entry.ctx.aliases) {
					const doc = entry.ctx.values[alias];
					if (doc && Object.prototype.hasOwnProperty.call(doc, expr.name)) return doc[expr.name];
				}
			}
			return null;
		}
		return this.evalExpr(expr, entry.ctx);
	}

	containsAggregate(node) {
		if (!node || typeof node !== 'object') return false;
		if (node.type === 'aggregate') return true;
		if (node.type === 'subquery') return false;
		for (const key of Object.keys(node)) {
			const value = node[key];
			if (Array.isArray(value)) {
				if (value.some((item) => this.containsAggregate(item))) return true;
			} else if (value && typeof value === 'object') {
				if (this.containsAggregate(value)) return true;
			}
		}
		return false;
	}

	referencesRow(node) {
		if (!node || typeof node !== 'object') return false;
		if (node.type === 'column') return true;
		for (const key of Object.keys(node)) {
			const value = node[key];
			if (Array.isArray(value)) {
				if (value.some((item) => this.referencesRow(item))) return true;
			} else if (value && typeof value === 'object') {
				if (this.referencesRow(value)) return true;
			}
		}
		return false;
	}

	async project(statement, ctx) {
		const row = {};
		for (const item of statement.items) {
			if (item.expr.type === 'star') {
				const sources = item.expr.table ? [item.expr.table] : ctx.aliases;
				for (const alias of sources) {
					const doc = ctx.values[alias];
					if (!doc) continue;
					for (const key of Object.keys(doc)) {
						if (key === '_id' || key.startsWith('_')) continue;
						if (row[key] === undefined) row[key] = doc[key];
					}
					const table = this.schema(alias);
					if (!table) continue;
					for (const column of table.columns) {
						if (!column.generated || row[column.name] !== undefined) continue;
						row[column.name] = await this.generatedValue(alias, column.name, ctx);
					}
				}
				continue;
			}
			const value = await this.evalExpr(item.expr, ctx);
			const name = item.alias || this.defaultName(item.expr);
			row[name] = value;
		}
		return row;
	}

	defaultName(expr) {
		if (expr.type === 'column') return expr.name;
		if (expr.type === 'aggregate')
			return `${expr.name}(${
				expr.arg && expr.arg.type === 'star' ? '*' : expr.arg && expr.arg.name ? expr.arg.name : ''
			})`;
		if (expr.type === 'func') return `${expr.name}(...)`;
		return 'expr';
	}

	// ----------------------------------------------------------------- insert

	prepareDocument(table, assignments) {
		const doc = {};
		for (const column of table.columns) {
			if (column.generated) continue;
			if (Object.prototype.hasOwnProperty.call(assignments, column.name)) {
				doc[column.name] = values.coerceForColumn(column.type, assignments[column.name]);
				continue;
			}
			if (column.defaultValue === undefined) continue;
			if (column.defaultValue === '@now') doc[column.name] = values.nowString();
			else doc[column.name] = values.coerceForColumn(column.type, column.defaultValue);
		}
		for (const key of Object.keys(assignments)) {
			if (doc[key] === undefined) doc[key] = assignments[key];
		}
		return doc;
	}

	encodeId(table, doc) {
		if (!table.primaryKey.length) return undefined;
		const parts = [];
		for (const column of table.primaryKey) {
			const value = doc[column];
			parts.push(value === null || value === undefined ? '' : String(value));
		}
		return parts.join('\u0001');
	}

	async nextAutoIncrement(table, column) {
		const sequenceName = `${table.name}.${column}`;
		const sequences = this.collection(SEQUENCE_COLLECTION);
		const existing = await sequences.findOne({ _id: sequenceName });
		if (!existing) {
			// Seed from the data so ids never collide with rows written earlier
			const docs = await this.collection(table.name).find({}, { limit: DEFAULT_SCAN_LIMIT });
			let max = 0;
			for (const doc of docs) {
				const value = Number(doc[column]);
				if (Number.isFinite(value) && value > max) max = value;
			}
			await sequences.updateOne(
				{ _id: sequenceName },
				{ $setOnInsert: { value: max } },
				{ upsert: true }
			);
		}
		const updated = await sequences.findOneAndUpdate(
			{ _id: sequenceName },
			{ $inc: { value: 1 } },
			{ upsert: true, returnDocument: 'after' }
		);
		const value = updated && updated.value !== undefined ? updated.value : null;
		const doc = updated && updated.value === undefined ? updated : value;
		return Number(doc && doc.value !== undefined ? doc.value : doc);
	}

	async runInsert(statement) {
		const table = this.table(statement.table);
		let rows = statement.rows;
		if (rows && rows.select) {
			const selected = await this.runSelect(rows.select, this.outer);
			rows = selected.map((row) =>
				Object.keys(row).map((key) => ({ type: 'literal', value: row[key] }))
			);
		}
		let affectedRows = 0;
		let insertId = 0;
		let matchedExisting = 0;

		for (const row of rows) {
			const assignments = {};
			if (statement.columns) {
				for (let i = 0; i < statement.columns.length; i++) {
					assignments[statement.columns[i]] = await this.evalExpr(row[i], {
						aliases: [],
						values: {},
						primaryAlias: null,
					});
				}
			} else {
				for (let i = 0; i < table.columns.length; i++) {
					assignments[table.columns[i].name] = await this.evalExpr(row[i], {
						aliases: [],
						values: {},
						primaryAlias: null,
					});
				}
			}

			for (const autoColumn of table.autoIncrement) {
				if (
					assignments[autoColumn] === undefined ||
					assignments[autoColumn] === null ||
					assignments[autoColumn] === 0 ||
					assignments[autoColumn] === '0'
				) {
					assignments[autoColumn] = await this.nextAutoIncrement(table, autoColumn);
					if (!insertId) insertId = assignments[autoColumn];
				}
			}

			const doc = this.prepareDocument(table, assignments);
			const id = this.encodeId(table, doc);
			if (id !== undefined) doc._id = id;

			const collection = this.collection(table.name);
			const existing = id === undefined ? null : await collection.findOne({ _id: id });

			if (existing) {
				matchedExisting++;
				if (statement.replace) {
					await collection.deleteMany({ _id: id });
					await collection.insertOne(doc);
					affectedRows += 2;
					continue;
				}
				if (!statement.onDuplicate.length) {
					if (statement.ignore) continue;
					// MySQL raises a duplicate-key error; callers rely on the throw
					const err = new Error(`E11000 duplicate key error collection: ${table.name} _id_: ${id}`);
					err.code = 'ER_DUP_ENTRY';
					throw err;
				}
				const applied = await this.applyAssignments(
					table,
					collection,
					{ _id: id },
					existing,
					statement.onDuplicate,
					doc
				);
				affectedRows += applied.changed ? 2 : 0;
				continue;
			}

			try {
				await collection.insertOne(doc);
				affectedRows += 1;
			} catch (err) {
				if (err && err.code === 11000 && (statement.ignore || statement.onDuplicate.length)) {
					const current = id === undefined ? null : await collection.findOne({ _id: id });
					if (current && statement.onDuplicate.length) {
						await this.applyAssignments(
							table,
							collection,
							{ _id: id },
							current,
							statement.onDuplicate,
							doc
						);
						affectedRows += 2;
					}
					continue;
				}
				throw err;
			}
		}

		if (statement.onDuplicate.length && matchedExisting) {
			return okPacket(insertId, affectedRows, affectedRows);
		}
		return okPacket(insertId, affectedRows);
	}

	/**
	 * Applies `ON DUPLICATE KEY UPDATE` / `SET` assignments.
	 * `col = col + n` becomes `$inc` (atomic), `col = VALUES(col)` becomes `$set`
	 * from the row being inserted, everything else is a guarded
	 * read-modify-write with retries.
	 */
	async applyAssignments(
		table,
		collection,
		filter,
		current,
		assignments,
		insertedRow,
		contextValues
	) {
		const increment = {};
		const set = {};
		const complex = [];
		for (const assignment of assignments) {
			const column = table.columnsByName[assignment.column];
			if (!column) continue;
			const value = assignment.value;
			const selfRef =
				value.type === 'binary' &&
				['+', '-'].includes(value.op) &&
				columnKey(value.left) === assignment.column &&
				!referencedColumns(value.right).includes(assignment.column);
			if (selfRef) {
				const delta = await this.evalExpr(value.right, {
					aliases: [],
					values: {},
					primaryAlias: null,
					insertedRow,
				});
				const amount = Number(delta);
				if (Number.isFinite(amount)) {
					increment[assignment.column] =
						(increment[assignment.column] || 0) + (value.op === '-' ? -amount : amount);
					continue;
				}
			}
			const isValuesCall = value.type === 'func' && value.name === 'VALUES';
			if (isValuesCall) {
				const target = value.args[0] && value.args[0].name;
				set[assignment.column] =
					insertedRow[target] !== undefined ? insertedRow[target] : insertedRow[assignment.column];
				continue;
			}
			const constant = !this.referencesRow(value);
			if (constant) {
				const evaluated = await this.evalExpr(value, {
					aliases: [],
					values: {},
					primaryAlias: null,
					insertedRow,
				});
				set[assignment.column] = values.coerceForColumn(column.type, evaluated);
				continue;
			}
			complex.push(assignment);
		}

		const update = {};
		if (Object.keys(set).length) update.$set = set;
		if (Object.keys(increment).length) {
			for (const key of Object.keys(increment)) {
				if (set[key] !== undefined) {
					set[key] = values.coerceForColumn(
						table.columnsByName[key].type,
						values.arithmetic('+', set[key], increment[key])
					);
					delete increment[key];
				}
			}
			if (Object.keys(increment).length) update.$inc = increment;
		}

		let changed = false;
		if (Object.keys(update).length) {
			try {
				const result = await collection.updateOne(filter, update, { upsert: false });
				changed = changed || result.matchedCount > 0;
			} catch (err) {
				// $inc on a string field (legacy big value) → fall back to RMW
				if (!(err && /inc/i.test(err.message))) throw err;
				for (const key of Object.keys(update.$inc || {})) {
					complex.push({
						column: key,
						value: {
							type: 'binary',
							op: '+',
							left: { type: 'column', name: key },
							right: { type: 'literal', value: update.$inc[key] },
						},
					});
				}
				update.$inc = undefined;
			}
		}

		if (complex.length) {
			for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
				const fresh = await collection.findOne(filter);
				if (!fresh) break;
				const ctx = {
					aliases: [table.name],
					values: { [table.name]: Object.assign({}, fresh, contextValues || {}) },
					primaryAlias: table.name,
					insertedRow,
				};
				const patch = {};
				for (const assignment of complex) {
					const column = table.columnsByName[assignment.column];
					if (!column) continue;
					const evaluated = await this.evalExpr(assignment.value, ctx);
					patch[assignment.column] = values.coerceForColumn(column.type, evaluated);
				}
				const guard = Object.assign({}, filter);
				// optimistic lock on the values we read
				for (const key of Object.keys(patch))
					guard[key] = fresh[key] === undefined ? null : fresh[key];
				const result = await collection.updateOne(guard, { $set: patch }, { upsert: false });
				if (result.matchedCount > 0) {
					changed = true;
					break;
				}
			}
		}

		return { changed };
	}

	// ----------------------------------------------------------------- update

	async runUpdate(statement) {
		const table = this.table(statement.table);
		const rows = await this.buildRows(
			{
				from: { table: statement.table, alias: statement.alias },
				joins: statement.joins,
				where: statement.where,
			},
			this.outer
		);
		let filtered = [];
		for (const row of rows) {
			if (!statement.where || truthy(await this.evalExpr(statement.where, row))) filtered.push(row);
		}

		if (statement.orderBy && statement.orderBy.length) {
			const decorated = [];
			for (const row of filtered) {
				const keys = [];
				for (const order of statement.orderBy) keys.push(await this.evalExpr(order.expr, row));
				decorated.push({ row, keys });
			}
			decorated.sort((a, b) => {
				for (let i = 0; i < a.keys.length; i++) {
					const cmp = values.compare(a.keys[i], b.keys[i]) * statement.orderBy[i].direction;
					if (cmp !== 0) return cmp;
				}
				return 0;
			});
			filtered = decorated.map((entry) => entry.row);
		}
		if (statement.limit !== null && statement.limit !== undefined) {
			const limit = Number(statement.limit);
			if (!Number.isNaN(limit)) filtered = filtered.slice(0, limit);
		}

		const collection = this.collection(table.name);
		let affectedRows = 0;
		for (const row of filtered) {
			const doc = row.values[statement.alias] || row.values[statement.table];
			if (!doc || doc._id === undefined) continue;
			const before = Object.assign({}, doc);
			const result = await this.applyAssignments(
				table,
				collection,
				{ _id: doc._id },
				doc,
				statement.sets,
				null,
				before
			);
			if (result.changed) affectedRows += 1;
			else if (statement.ignore) continue;
		}
		return okPacket(0, affectedRows);
	}

	// ----------------------------------------------------------------- delete

	async runDelete(statement) {
		this.table(statement.from.table); // validates the table exists
		const rows = await this.buildRows(statement, this.outer);
		let filtered = [];
		for (const row of rows) {
			if (!statement.where || truthy(await this.evalExpr(statement.where, row))) filtered.push(row);
		}
		if (statement.limit !== null && statement.limit !== undefined) {
			const limit = Number(statement.limit);
			if (!Number.isNaN(limit)) filtered = filtered.slice(0, limit);
		}

		// Multi-table delete only removes rows from the named targets; `DELETE
		// pta FROM pet_team_animal pta JOIN ...` deletes pet_team_animal rows.
		const targets =
			statement.targets && statement.targets.length ? statement.targets : [statement.from.alias];
		const idsByTable = new Map();
		for (const row of filtered) {
			for (const target of targets) {
				const doc = row.values[target];
				if (!doc || doc._id === undefined) continue;
				const tableName = this.aliasTableName(statement, target);
				if (!idsByTable.has(tableName)) idsByTable.set(tableName, new Set());
				idsByTable.get(tableName).add(doc._id);
			}
		}
		let deleted = 0;
		for (const [tableName, ids] of idsByTable) {
			const result = await this.collection(tableName).deleteMany({ _id: { $in: [...ids] } });
			deleted += result.deletedCount || 0;
		}
		return okPacket(0, deleted);
	}

	aliasTableName(statement, alias) {
		if (statement.from.alias === alias) return statement.from.table;
		for (const join of statement.joins || []) {
			const joinedAlias = join.target.alias || join.target.table;
			if (joinedAlias === alias) return join.target.table;
		}
		if (statement.from.table === alias) return statement.from.table;
		return statement.from.table;
	}
}

module.exports = { Executor, SqlError, okPacket, isOkPacket };
