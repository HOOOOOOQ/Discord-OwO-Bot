/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const workerpool = require('workerpool');
const { create, all } = require('mathjs');
const math = create(all);
const limitedEvaluate = math.evaluate;
math.import(
	{
		import: function () {
			throw new Error('Function import is disabled');
		},
		createUnit: function () {
			throw new Error('Function createUnit is disabled');
		},
		evaluate: function () {
			throw new Error('Function evaluate is disabled');
		},
		parse: function () {
			throw new Error('Function parse is disabled');
		},
		simplify: function () {
			throw new Error('Function simplify is disabled');
		},
		derivative: function () {
			throw new Error('Function derivative is disabled');
		},
	},
	{ override: true }
);

function compute(expression) {
	return limitedEvaluate(expression);
}

// This file is auto-loaded by the command loader as well, so it must only
// install the workerpool message handler when it is actually running as the
// worker process. Otherwise requiring it inside a shard hijacks the cluster IPC
// channel and can break sharder communication.
// REGITER_COMMANDS is the historical (misspelled) flag kept for compatibility.
const isWorkerProcess =
	require.main === module || /mathWorker\.js$/.test(String(process.argv[1] || ''));
if (isWorkerProcess && !process.env.REGISTER_COMMANDS && !process.env.REGITER_COMMANDS) {
	workerpool.worker({ compute: compute });
}
