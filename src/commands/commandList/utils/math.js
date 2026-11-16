/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const CommandInterface = require('../../CommandInterface.js');

const mathEmoji = '<a:naruhodo:593971680737624065>';

const workerpool = require('workerpool');
const log = require('../../../utils/log.js');
const { classifyMathError } = require('../../../utils/mathResult.js');

// Single source of truth for the evaluation budget. The pool is created once
// per process and stays alive: terminating it after every request forced a new
// worker spawn (and rejected in-flight work) on every subsequent invocation.
const MATH_TIMEOUT_MS = Number.parseInt(process.env.MATH_TIMEOUT_MS, 10) || 3000;
const pool = workerpool.pool(__dirname + '/mathWorker.js');

module.exports = new CommandInterface({
	alias: ['math', 'calc', 'calculate'],

	args: '{equation}',

	desc: 'Let me do your math homework! Add an expression for me to solve! More in-depth syntax can be found here: https://mathjs.org/docs/expressions/syntax.html',

	example: ['o math 2 + 2'],

	related: [],

	permissions: ['sendMessages'],

	group: ['utility'],

	cooldown: 5000,
	half: 100,
	six: 500,

	execute: function (p) {
		// quick and dirty fix for function calls and tags
		let expression = p.args.join(' ').replace(/\.(?=[a-zA-Z_]+\()/gm, '\\.');
		pool
			.exec('compute', [expression])
			.timeout(MATH_TIMEOUT_MS)
			.then(function (result) {
				if (result.mathjs) {
					if (result.data) result = JSON.stringify(result.data);
					else if (result.entries) result = result.entries + '';
					else if (result.unit && result.value) result = result.value + ' ' + result.unit;
					else if (result.value) result = result.value + '';
					if (result.length > 1000)
						p.replyMsg(
							mathEmoji,
							p.replaceMentions(', the answer is: **' + result.substr(0, 1000) + '**...')
						);
					else p.replyMsg(mathEmoji, p.replaceMentions(', the answer is: **' + result + '**'));
				} else if (typeof result == 'object')
					p.replyMsg(
						mathEmoji,
						p.replaceMentions(', the answer is: **' + JSON.stringify(result) + '**')
					);
				else p.replyMsg(mathEmoji, p.replaceMentions(', the answer is: **' + result + '**'));
			})
			.catch(function (err) {
				if (classifyMathError(err) === 'timeout') {
					log.debug(`math: evaluation timeout after ${MATH_TIMEOUT_MS}ms`);
					p.errorMsg(
						`, that expression is too difficult for me... :c (limit ${MATH_TIMEOUT_MS}ms)`,
						3000
					);
				} else {
					p.errorMsg("... I don't think that's an expression silly head", 3000);
				}
			});
	},
});

// Exposed for tests and for graceful shutdown of the worker process
module.exports.pool = pool;
