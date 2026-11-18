/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * The bot's data model, read from the MySQL dump that ships with the repo
 * (`secret/CREATE-OWO-TABLES.sql`). Nothing about the model changed during the
 * migration to MongoDB: the same 87 tables, columns, primary keys, unique keys
 * and indexes are used, so every command keeps its original data layout. The
 * MongoDB layer reads this file to know
 *
 *   - which columns exist and what type they have (ids are exact integers),
 *   - which columns form the primary/unique keys (that is what
 *     `ON DUPLICATE KEY UPDATE` means in MongoDB: upsert on those keys),
 *   - which columns are `AUTO_INCREMENT` (a counter document per column),
 *   - which columns are virtual/generated (recomputed instead of stored).
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.join(__dirname, '..', '..', '..', 'secret', 'CREATE-OWO-TABLES.sql');

function splitTopLevel(body) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let current = '';
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (quote) {
			current += ch;
			if (ch === quote && body[i - 1] !== '\\') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function columnList(text) {
	const inner = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
	return inner
		.split(',')
		.map((part) => part.trim().replace(/^`|`$/g, ''))
		.filter(Boolean);
}

function parseColumn(line) {
	const match = line.match(/^`([^`]+)`\s+([a-zA-Z]+)(\([^)]*\))?([\s\S]*)$/);
	if (!match) return null;
	const name = match[1];
	const type = `${match[2]}${match[3] || ''}`;
	const rest = match[4] || '';
	const column = {
		name,
		type,
		autoIncrement: /AUTO_INCREMENT/i.test(rest),
		notNull: /NOT\s+NULL/i.test(rest),
		defaultValue: undefined,
		generated: null,
	};
	const generated = rest.match(/GENERATED\s+ALWAYS\s+AS\s+\(([\s\S]*)\)\s*(?:VIRTUAL|STORED)/i);
	if (generated) {
		column.generated = generated[1].trim();
		return column;
	}
	const def = rest.match(
		/DEFAULT\s+('(?:[^'\\]|\\.)*'|NULL|CURRENT_TIMESTAMP(?:\(\d*\))?|[-\w.]+)/i
	);
	if (def) {
		const raw = def[1];
		if (/^'.*'$/s.test(raw)) column.defaultValue = raw.slice(1, -1).replace(/\\'/g, "'");
		else if (/^NULL$/i.test(raw)) column.defaultValue = null;
		else if (/^CURRENT_TIMESTAMP/i.test(raw)) column.defaultValue = '@now';
		else if (!Number.isNaN(Number(raw))) column.defaultValue = Number(raw);
		else column.defaultValue = raw;
	}
	return column;
}

function parseCreateTable(body) {
	const columns = [];
	const primaryKey = [];
	const uniques = [];
	const indexes = [];
	for (const rawLine of splitTopLevel(body)) {
		const line = rawLine.replace(/\s+/g, ' ').trim();
		if (/^PRIMARY KEY/i.test(line)) {
			primaryKey.push(...columnList(line));
			continue;
		}
		const unique = line.match(/^UNIQUE KEY\s+`?([^`(\s]+)`?\s*\(([\s\S]*)\)/i);
		if (unique) {
			uniques.push({ name: unique[1], columns: columnList(`(${unique[2]})`) });
			continue;
		}
		const index = line.match(/^KEY\s+`?([^`(\s]+)`?\s*\(([\s\S]*)\)/i);
		if (index) {
			indexes.push({ name: index[1], columns: columnList(`(${index[2]})`) });
			continue;
		}
		if (/^(CONSTRAINT|FULLTEXT|SPATIAL|CHECK)/i.test(line)) continue;
		const column = parseColumn(line);
		if (column) columns.push(column);
	}
	return { columns, primaryKey, uniques, indexes };
}

function parseSchema(sql) {
	const tables = {};
	const createTable = /CREATE TABLE\s+`([^`]+)`\s*\(([\s\S]*?)\n\)\s*ENGINE/gi;
	let match;
	while ((match = createTable.exec(sql)) !== null) {
		const name = match[1];
		const parsed = parseCreateTable(match[2]);
		const columnsByName = {};
		const autoIncrement = [];
		for (const column of parsed.columns) {
			columnsByName[column.name] = column;
			if (column.autoIncrement) autoIncrement.push(column.name);
		}
		tables[name] = {
			name,
			columns: parsed.columns,
			columnsByName,
			primaryKey: parsed.primaryKey,
			uniques: parsed.uniques,
			indexes: parsed.indexes,
			autoIncrement,
		};
	}
	return tables;
}

let cached = null;

function loadSchema() {
	if (cached) return cached;
	let sql = '';
	try {
		sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
	} catch (err) {
		sql = '';
	}
	cached = parseSchema(sql);
	return cached;
}

function getTable(name) {
	if (!name) return undefined;
	const schema = loadSchema();
	return schema[name] || schema[String(name).toLowerCase()];
}

function hasTable(name) {
	return !!getTable(name);
}

function tableNames() {
	return Object.keys(loadSchema());
}

module.exports = { loadSchema, getTable, hasTable, tableNames, parseSchema, SCHEMA_FILE };
