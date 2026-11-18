/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * Tokenizer + recursive-descent parser for the SQL dialect this bot uses.
 *
 * The bot has ~350 call sites written in SQL. Instead of keeping a MySQL server
 * alive, every statement is parsed here and executed as document operations
 * against MongoDB (see `executor.js`). The grammar covered is the one that
 * actually appears in the code base:
 *
 *   SELECT [DISTINCT] items FROM table [alias] [INNER|LEFT JOIN ... ON ...] ...
 *   INSERT [IGNORE] INTO t (cols) VALUES (...)[, (...)] [ON DUPLICATE KEY UPDATE ...]
 *   REPLACE INTO t (cols) VALUES (...)
 *   UPDATE [IGNORE] t [alias] [JOIN ...] SET a = expr, ... [WHERE ...] [LIMIT n]
 *   DELETE [alias] FROM t [alias] [JOIN ...] [WHERE ...]
 *   START TRANSACTION / COMMIT / ROLLBACK / SET ...
 */

/**
 * Number literals exactly as MySQL sees them.
 *
 * The bot builds SQL by concatenation, so snowflakes are written **unquoted**:
 * `INSERT INTO user (id,count) VALUES (${msg.author.id},1)`. `Number()` would
 * round an 18–19 digit id (777777777777777777 → 777777777777777792), which
 * silently merges two different Discord accounts into one row. Integers that a
 * double cannot hold are therefore kept as exact decimal strings; the value
 * helpers (`values.js`) already compare and add those with BigInt.
 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function exactNumberLiteral(text) {
	if (/^-?\d+$/.test(text)) {
		const big = BigInt(text);
		if (big > MAX_SAFE || big < MIN_SAFE) return text;
	}
	return Number(text);
}

const KEYWORDS = new Set([
	'SELECT',
	'DISTINCT',
	'FROM',
	'WHERE',
	'GROUP',
	'BY',
	'HAVING',
	'ORDER',
	'ASC',
	'DESC',
	'LIMIT',
	'OFFSET',
	'JOIN',
	'INNER',
	'LEFT',
	'RIGHT',
	'OUTER',
	'CROSS',
	'ON',
	'AND',
	'OR',
	'NOT',
	'IN',
	'LIKE',
	'BETWEEN',
	'IS',
	'NULL',
	'TRUE',
	'FALSE',
	'AS',
	'INSERT',
	'IGNORE',
	'INTO',
	'VALUES',
	'VALUE',
	'DUPLICATE',
	'KEY',
	'UPDATE',
	'SET',
	'DELETE',
	'REPLACE',
	'START',
	'TRANSACTION',
	'COMMIT',
	'ROLLBACK',
	'BEGIN',
	'UNION',
	'ALL',
	'CASE',
	'WHEN',
	'THEN',
	'ELSE',
	'END',
	'USING',
	'EXISTS',
	'FOR',
	'LOCK',
	'SHARE',
	'MODE',
	'INTERVAL',
]);

const AGGREGATES = new Set(['COUNT', 'SUM', 'MAX', 'MIN', 'AVG', 'GROUP_CONCAT']);

function tokenize(sql) {
	const tokens = [];
	let i = 0;
	const length = sql.length;
	while (i < length) {
		const ch = sql[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		// comments
		if (ch === '-' && sql[i + 1] === '-') {
			while (i < length && sql[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && sql[i + 1] === '*') {
			i += 2;
			while (i < length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const quote = ch;
			let value = '';
			i++;
			while (i < length) {
				const c = sql[i];
				if (c === '\\') {
					const next = sql[i + 1];
					const map = { n: '\n', r: '\r', t: '\t', 0: '\0', '\\': '\\', "'": "'", '"': '"' };
					value += map[next] !== undefined ? map[next] : next;
					i += 2;
					continue;
				}
				if (c === quote) {
					if (sql[i + 1] === quote) {
						value += quote;
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += c;
				i++;
			}
			tokens.push({ type: 'string', value });
			continue;
		}
		if (ch === '`') {
			let value = '';
			i++;
			while (i < length && sql[i] !== '`') {
				value += sql[i++];
			}
			i++;
			tokens.push({ type: 'ident', value, quoted: true });
			continue;
		}
		if (ch === '?') {
			tokens.push({ type: 'param' });
			i++;
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
			let text = '';
			while (i < length && /[0-9.]/.test(sql[i])) text += sql[i++];
			tokens.push({ type: 'number', value: exactNumberLiteral(text) });
			continue;
		}
		if (/[A-Za-z_$@]/.test(ch)) {
			// `table.column` is emitted as three tokens so the parser can qualify it
			let text = '';
			while (i < length && /[A-Za-z0-9_$@]/.test(sql[i])) text += sql[i++];
			const upper = text.toUpperCase();
			tokens.push({ type: KEYWORDS.has(upper) ? 'keyword' : 'ident', value: text, upper });
			continue;
		}
		const three = sql.slice(i, i + 3);
		if (three === '<=>') {
			tokens.push({ type: 'operator', value: '<=>' });
			i += 3;
			continue;
		}
		const two = sql.slice(i, i + 2);
		if (['<<', '>>'].includes(two)) {
			tokens.push({ type: 'operator', value: two });
			i += 2;
			continue;
		}
		if (['<=', '>=', '<>', '!=', '||', '&&', '=='].includes(two)) {
			tokens.push({ type: 'operator', value: two === '&&' ? 'AND' : two === '||' ? 'OR' : two });
			i += 2;
			continue;
		}
		if ('(),.;*=<>+-/%!|&^~'.includes(ch)) {
			tokens.push({ type: 'operator', value: ch });
			i++;
			continue;
		}
		// Unknown character: skip it rather than failing the whole statement
		i++;
	}
	tokens.push({ type: 'eof' });
	return tokens;
}

class Parser {
	constructor(sql) {
		this.sql = sql;
		this.tokens = tokenize(sql);
		this.pos = 0;
	}

	peek(offset = 0) {
		return this.tokens[this.pos + offset] || { type: 'eof' };
	}

	next() {
		return this.tokens[this.pos++];
	}

	isKeyword(word, offset = 0) {
		const token = this.peek(offset);
		return token.type === 'keyword' && token.upper === word;
	}

	isOperator(value, offset = 0) {
		const token = this.peek(offset);
		return token.type === 'operator' && token.value === value;
	}

	matchKeyword(word) {
		if (this.isKeyword(word)) {
			this.pos++;
			return true;
		}
		return false;
	}

	matchOperator(value) {
		if (this.isOperator(value)) {
			this.pos++;
			return true;
		}
		return false;
	}

	expectKeyword(word) {
		if (!this.matchKeyword(word)) {
			throw this.error(`expected ${word}`);
		}
	}

	expectOperator(value) {
		if (!this.matchOperator(value)) {
			throw this.error(`expected "${value}"`);
		}
	}

	error(message) {
		const token = this.peek();
		return new Error(
			`SQL parse error: ${message} near "${token.value !== undefined ? token.value : token.type}"`
		);
	}

	parseStatements() {
		const statements = [];
		while (this.peek().type !== 'eof') {
			if (this.matchOperator(';')) continue;
			statements.push(this.parseStatement());
			this.matchOperator(';');
		}
		return statements;
	}

	parseStatement() {
		const token = this.peek();
		const word = token.type === 'keyword' ? token.upper : '';
		if (word === 'SELECT') return this.parseSelect();
		if (word === 'INSERT') return this.parseInsert(false);
		if (word === 'REPLACE') return this.parseInsert(true);
		if (word === 'UPDATE') return this.parseUpdate();
		if (word === 'DELETE') return this.parseDelete();
		if (['START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'UNLOCK', 'LOCK'].includes(word)) {
			while (this.peek().type !== 'eof' && !this.isOperator(';')) this.pos++;
			return { type: 'control', keyword: word };
		}
		throw this.error(`unsupported statement "${token.value}"`);
	}

	parseIdentifier() {
		const token = this.next();
		if (token.type === 'ident' || token.type === 'keyword' || token.type === 'string') {
			return token.value;
		}
		throw this.error('expected identifier');
	}

	/** `table.column` in an assignment target resolves to the bare column. */
	parseAssignmentTarget() {
		let name = this.parseIdentifier();
		while (this.matchOperator('.')) name = this.parseIdentifier();
		return name;
	}

	parseSelect() {
		this.expectKeyword('SELECT');
		const select = {
			type: 'select',
			distinct: this.matchKeyword('DISTINCT'),
			items: [],
			from: null,
			joins: [],
			where: null,
			groupBy: [],
			having: null,
			orderBy: [],
			limit: null,
			offset: 0,
		};
		if (this.matchKeyword('ALL')) {
			/* no-op */
		}
		select.items = this.parseSelectItems();
		if (this.matchKeyword('FROM')) {
			select.from = this.parseTableRef();
			while (this.isJoinStart()) {
				select.joins.push(this.parseJoin());
			}
		}
		if (this.matchKeyword('WHERE')) select.where = this.parseExpression();
		if (this.isKeyword('GROUP')) {
			this.pos++;
			this.expectKeyword('BY');
			select.groupBy.push(this.parseExpression());
			while (this.matchOperator(',')) select.groupBy.push(this.parseExpression());
		}
		if (this.matchKeyword('HAVING')) select.having = this.parseExpression();
		if (this.isKeyword('ORDER')) {
			this.pos++;
			this.expectKeyword('BY');
			do {
				const expr = this.parseExpression();
				let direction = 1;
				if (this.matchKeyword('DESC')) direction = -1;
				else this.matchKeyword('ASC');
				select.orderBy.push({ expr, direction });
			} while (this.matchOperator(','));
		}
		if (this.matchKeyword('LIMIT')) {
			const first = this.parseExpression();
			if (this.matchOperator(',') || this.matchKeyword('OFFSET')) {
				select.offset = this.toNumber(first);
				select.limit = this.toNumber(this.parseExpression());
			} else {
				select.limit = this.toNumber(first);
			}
		}
		// Row locks are meaningless without a MySQL server; the MongoDB
		// transaction covers them. Consume the words so the statement parses.
		if (this.matchKeyword('FOR')) {
			this.matchKeyword('UPDATE');
			select.lock = 'update';
		} else if (this.isKeyword('LOCK')) {
			while (this.peek().type !== 'eof' && !this.isOperator(';')) this.pos++;
		}
		return select;
	}

	toNumber(node) {
		if (node && node.type === 'literal') {
			if (typeof node.value === 'number') return node.value;
			if (typeof node.value === 'string' && /^-?\d+$/.test(node.value.trim())) {
				return Number(node.value);
			}
		}
		return node;
	}

	parseSelectItems() {
		const items = [];
		do {
			if (this.isOperator('*')) {
				this.pos++;
				items.push({ expr: { type: 'star' }, alias: null });
				continue;
			}
			const expr = this.parseExpression();
			let alias = null;
			if (this.matchKeyword('AS')) alias = this.parseIdentifier();
			else {
				const token = this.peek();
				const reserved = ['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'JOIN', 'ON'];
				if (token.type === 'string') alias = this.next().value;
				else if (token.type === 'ident' && !reserved.includes(token.upper))
					alias = this.next().value;
			}
			items.push({ expr, alias });
		} while (this.matchOperator(','));
		return items;
	}

	isJoinStart() {
		return (
			this.isKeyword('JOIN') ||
			this.isKeyword('INNER') ||
			this.isKeyword('LEFT') ||
			this.isKeyword('RIGHT') ||
			this.isKeyword('CROSS') ||
			(this.isOperator(',') && !this.isKeyword('VALUES'))
		);
	}

	parseJoin() {
		let kind = 'INNER';
		if (this.matchKeyword('INNER')) this.expectKeyword('JOIN');
		else if (this.matchKeyword('LEFT')) {
			this.matchKeyword('OUTER');
			this.expectKeyword('JOIN');
			kind = 'LEFT';
		} else if (this.matchKeyword('RIGHT')) {
			this.matchKeyword('OUTER');
			this.expectKeyword('JOIN');
			kind = 'RIGHT';
		} else if (this.matchKeyword('CROSS')) {
			this.expectKeyword('JOIN');
			kind = 'CROSS';
		} else this.expectKeyword('JOIN');
		const target = this.parseTableRef();
		let on = null;
		if (this.matchKeyword('ON')) on = this.parseExpression();
		return { kind, target, on };
	}

	parseTableRef() {
		if (this.isOperator('(')) {
			const save = this.pos;
			this.pos++;
			if (this.isKeyword('SELECT')) {
				const select = this.parseSelect();
				this.expectOperator(')');
				const alias = this.matchKeyword('AS') ? this.parseIdentifier() : this.parseOptionalAlias();
				return { subselect: select, alias: alias || 'sub' };
			}
			this.pos = save;
		}
		const table = this.parseIdentifier();
		const alias = this.matchKeyword('AS') ? this.parseIdentifier() : this.parseOptionalAlias();
		return { table, alias: alias || table };
	}

	parseOptionalAlias() {
		const token = this.peek();
		if (token.type !== 'ident') return null;
		const reserved = [
			'WHERE',
			'GROUP',
			'ORDER',
			'LIMIT',
			'HAVING',
			'JOIN',
			'ON',
			'SET',
			'VALUES',
			'AND',
			'OR',
		];
		if (reserved.includes(token.upper)) return null;
		this.pos++;
		return token.value;
	}

	parseInsert(isReplace) {
		if (isReplace) this.expectKeyword('REPLACE');
		else this.expectKeyword('INSERT');
		const ignore = this.matchKeyword('IGNORE');
		this.expectKeyword('INTO');
		const table = this.parseIdentifier();
		let columns = null;
		if (this.matchOperator('(')) {
			columns = [];
			do {
				columns.push(this.parseIdentifier());
			} while (this.matchOperator(','));
			this.expectOperator(')');
		}
		let rows = [];
		if (this.matchKeyword('VALUES') || this.matchKeyword('VALUE')) {
			do {
				this.expectOperator('(');
				const row = [];
				if (!this.isOperator(')')) {
					do {
						row.push(this.parseExpression());
					} while (this.matchOperator(','));
				}
				this.expectOperator(')');
				rows.push(row);
			} while (this.matchOperator(','));
		} else if (this.isKeyword('SELECT')) {
			rows = { select: this.parseSelect() };
		}
		const onDuplicate = [];
		if (this.isKeyword('ON')) {
			this.pos++;
			this.expectKeyword('DUPLICATE');
			this.expectKeyword('KEY');
			this.expectKeyword('UPDATE');
			do {
				const column = this.parseAssignmentTarget();
				this.expectOperator('=');
				onDuplicate.push({ column, value: this.parseExpression() });
			} while (this.matchOperator(','));
		}
		return { type: 'insert', replace: isReplace, ignore, table, columns, rows, onDuplicate };
	}

	parseUpdate() {
		this.expectKeyword('UPDATE');
		const ignore = this.matchKeyword('IGNORE');
		const table = this.parseIdentifier();
		let alias = table;
		const joins = [];
		if (this.isJoinStart()) {
			while (this.isJoinStart()) joins.push(this.parseJoin());
		} else {
			alias = this.matchKeyword('AS') ? this.parseIdentifier() : this.parseOptionalAlias() || table;
			while (this.isJoinStart()) joins.push(this.parseJoin());
		}
		this.expectKeyword('SET');
		const sets = [];
		do {
			const column = this.parseAssignmentTarget();
			this.expectOperator('=');
			sets.push({ column, value: this.parseExpression() });
		} while (this.matchOperator(','));
		let where = null;
		if (this.matchKeyword('WHERE')) where = this.parseExpression();
		const orderBy = [];
		if (this.isKeyword('ORDER')) {
			this.pos++;
			this.expectKeyword('BY');
			do {
				const expr = this.parseExpression();
				let direction = 1;
				if (this.matchKeyword('DESC')) direction = -1;
				else this.matchKeyword('ASC');
				orderBy.push({ expr, direction });
			} while (this.matchOperator(','));
		}
		let limit = null;
		if (this.matchKeyword('LIMIT')) limit = this.toNumber(this.parseExpression());
		return { type: 'update', ignore, table, alias, joins, sets, where, orderBy, limit };
	}

	parseDelete() {
		this.expectKeyword('DELETE');
		const ignore = this.matchKeyword('IGNORE');
		const targets = [];
		if (!this.isKeyword('FROM')) {
			do {
				targets.push(this.parseIdentifier());
			} while (this.matchOperator(','));
		}
		this.expectKeyword('FROM');
		const from = this.parseTableRef();
		const joins = [];
		while (this.isJoinStart()) joins.push(this.parseJoin());
		let where = null;
		if (this.matchKeyword('WHERE')) where = this.parseExpression();
		const orderBy = [];
		if (this.isKeyword('ORDER')) {
			this.pos++;
			this.expectKeyword('BY');
			do {
				const expr = this.parseExpression();
				let direction = 1;
				if (this.matchKeyword('DESC')) direction = -1;
				else this.matchKeyword('ASC');
				orderBy.push({ expr, direction });
			} while (this.matchOperator(','));
		}
		let limit = null;
		if (this.matchKeyword('LIMIT')) limit = this.toNumber(this.parseExpression());
		return { type: 'delete', ignore, targets, from, joins, where, orderBy, limit };
	}

	parseExpression() {
		return this.parseOr();
	}

	parseOr() {
		let left = this.parseAnd();
		while (this.isKeyword('OR')) {
			this.pos++;
			left = { type: 'binary', op: 'OR', left, right: this.parseAnd() };
		}
		return left;
	}

	parseAnd() {
		let left = this.parseNot();
		while (this.isKeyword('AND')) {
			this.pos++;
			left = { type: 'binary', op: 'AND', left, right: this.parseNot() };
		}
		return left;
	}

	parseNot() {
		if (this.matchKeyword('NOT')) return { type: 'unary', op: 'NOT', expr: this.parseNot() };
		if (this.matchOperator('!')) return { type: 'unary', op: 'NOT', expr: this.parseNot() };
		return this.parseComparison();
	}

	parseComparison() {
		let left = this.parseBitOr();
		for (;;) {
			const token = this.peek();
			if (
				token.type === 'operator' &&
				['=', '!=', '<>', '<', '>', '<=', '>=', '<=>'].includes(token.value)
			) {
				this.pos++;
				left = {
					type: 'binary',
					op: token.value === '<>' ? '!=' : token.value,
					left,
					right: this.parseBitOr(),
				};
				continue;
			}
			if (this.isKeyword('IS')) {
				this.pos++;
				const not = this.matchKeyword('NOT');
				if (this.matchKeyword('NULL')) {
					left = { type: 'is', expr: left, not, what: 'null' };
					continue;
				}
				if (this.matchKeyword('TRUE')) {
					left = { type: 'is', expr: left, not, what: 'true' };
					continue;
				}
				if (this.matchKeyword('FALSE')) {
					left = { type: 'is', expr: left, not, what: 'false' };
					continue;
				}
				throw this.error('expected NULL/TRUE/FALSE after IS');
			}
			let not = false;
			if (this.isKeyword('NOT')) {
				const save = this.pos;
				this.pos++;
				if (this.isKeyword('IN') || this.isKeyword('LIKE') || this.isKeyword('BETWEEN')) {
					not = true;
				} else {
					this.pos = save;
					break;
				}
			}
			if (this.matchKeyword('IN')) {
				this.expectOperator('(');
				if (this.isKeyword('SELECT')) {
					const select = this.parseSelect();
					this.expectOperator(')');
					left = { type: 'in', expr: left, subquery: select, not };
				} else {
					const values = [];
					if (!this.isOperator(')')) {
						do {
							values.push(this.parseExpression());
						} while (this.matchOperator(','));
					}
					this.expectOperator(')');
					left = { type: 'in', expr: left, values, not };
				}
				continue;
			}
			if (this.matchKeyword('LIKE')) {
				left = { type: 'like', expr: left, pattern: this.parseBitOr(), not };
				continue;
			}
			if (this.matchKeyword('BETWEEN')) {
				const low = this.parseBitOr();
				this.expectKeyword('AND');
				const high = this.parseBitOr();
				left = { type: 'between', expr: left, low, high, not };
				continue;
			}
			break;
		}
		return left;
	}

	parseBitOr() {
		let left = this.parseBitXor();
		while (this.isOperator('|')) {
			this.pos++;
			left = { type: 'binary', op: '|', left, right: this.parseBitXor() };
		}
		return left;
	}

	parseBitXor() {
		let left = this.parseBitAnd();
		while (this.isOperator('^')) {
			this.pos++;
			left = { type: 'binary', op: '^', left, right: this.parseBitAnd() };
		}
		return left;
	}

	parseBitAnd() {
		let left = this.parseShift();
		while (this.isOperator('&')) {
			this.pos++;
			left = { type: 'binary', op: '&', left, right: this.parseShift() };
		}
		return left;
	}

	parseShift() {
		let left = this.parseAdditive();
		while (this.isOperator('<<') || this.isOperator('>>')) {
			const op = this.next().value;
			left = { type: 'binary', op, left, right: this.parseAdditive() };
		}
		return left;
	}

	parseAdditive() {
		let left = this.parseMultiplicative();
		while (this.isOperator('+') || this.isOperator('-')) {
			const op = this.next().value;
			left = { type: 'binary', op, left, right: this.parseMultiplicative() };
		}
		return left;
	}

	parseMultiplicative() {
		let left = this.parseUnary();
		while (this.isOperator('*') || this.isOperator('/') || this.isOperator('%')) {
			const op = this.next().value;
			left = { type: 'binary', op, left, right: this.parseUnary() };
		}
		return left;
	}

	parseUnary() {
		if (this.isOperator('~')) {
			this.pos++;
			return { type: 'unary', op: '~', expr: this.parseUnary() };
		}
		if (this.isOperator('-')) {
			this.pos++;
			return { type: 'unary', op: '-', expr: this.parseUnary() };
		}
		if (this.isOperator('+')) {
			this.pos++;
			return this.parseUnary();
		}
		return this.parsePrimary();
	}

	parsePrimary() {
		const token = this.peek();
		if (token.type === 'number') {
			this.pos++;
			return { type: 'literal', value: token.value };
		}
		if (token.type === 'string') {
			this.pos++;
			return { type: 'literal', value: token.value };
		}
		if (token.type === 'param') {
			this.pos++;
			return { type: 'param', index: null };
		}
		if (this.isKeyword('NULL')) {
			this.pos++;
			return { type: 'literal', value: null };
		}
		if (this.isKeyword('TRUE')) {
			this.pos++;
			return { type: 'literal', value: true };
		}
		if (this.isKeyword('FALSE')) {
			this.pos++;
			return { type: 'literal', value: false };
		}
		if (this.isOperator('(')) {
			this.pos++;
			if (this.isKeyword('SELECT')) {
				const select = this.parseSelect();
				this.expectOperator(')');
				return { type: 'subquery', select };
			}
			const inner = this.parseExpression();
			this.expectOperator(')');
			return inner;
		}
		if (this.isKeyword('EXISTS')) {
			this.pos++;
			this.expectOperator('(');
			const select = this.parseSelect();
			this.expectOperator(')');
			return { type: 'exists', select };
		}
		if (this.isKeyword('CASE')) return this.parseCase();
		if (
			token.type === 'keyword' &&
			['START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SET'].includes(token.upper)
		) {
			throw this.error('unexpected control statement');
		}
		if (token.type === 'ident' || token.type === 'keyword') {
			this.pos++;
			let name = token.value;
			// function call
			if (this.isOperator('(')) {
				this.pos++;
				const args = [];
				const distinct = this.matchKeyword('DISTINCT') ? true : false;
				if (!this.isOperator(')')) {
					do {
						if (this.isOperator('*')) {
							this.pos++;
							args.push({ type: 'star' });
						} else {
							args.push(this.parseExpression());
						}
					} while (this.matchOperator(','));
				}
				this.expectOperator(')');
				const upper = name.toUpperCase();
				if (AGGREGATES.has(upper)) {
					let isDistinct = distinct;
					let arg = args[0] || null;
					if (arg && arg.type === 'unary' && arg.op === 'DISTINCT') {
						isDistinct = true;
						arg = arg.expr;
					}
					return {
						type: 'aggregate',
						name: upper,
						arg,
						distinct: isDistinct || (arg && arg.distinct),
					};
				}
				return { type: 'func', name: upper, args };
			}
			// column reference, possibly qualified
			if (this.matchOperator('.')) {
				if (this.isOperator('*')) {
					this.pos++;
					return { type: 'star', table: name };
				}
				const column = this.parseIdentifier();
				return { type: 'column', table: name, name: column };
			}
			return { type: 'column', table: null, name };
		}
		throw this.error('unexpected token');
	}

	parseCase() {
		this.expectKeyword('CASE');
		const node = { type: 'case', operand: null, whens: [], elseValue: null };
		if (!this.isKeyword('WHEN')) node.operand = this.parseExpression();
		while (this.matchKeyword('WHEN')) {
			const when = this.parseExpression();
			this.expectKeyword('THEN');
			node.whens.push({ when, then: this.parseExpression() });
		}
		if (this.matchKeyword('ELSE')) node.elseValue = this.parseExpression();
		this.expectKeyword('END');
		return node;
	}
}

function parse(sql) {
	const parser = new Parser(String(sql));
	const statements = parser.parseStatements();
	if (!Array.isArray(statements) || statements.length === 0) {
		throw new Error('SQL parse error: empty statement');
	}
	return statements;
}

module.exports = {
	parse,
	tokenize,
	Parser,
	isAggregateName: (name) => AGGREGATES.has(String(name).toUpperCase()),
};
