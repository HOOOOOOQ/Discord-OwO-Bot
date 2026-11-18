/*
 * OwO Bot for Discord
 * Copyright (C) 2020 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

const requireDir = require('require-dir');
const dir = requireDir('./commandList', { recurse: true });

const CommandInterface = require('./CommandInterface.js');
const auth = require('../utils/auth.js');
const errors = require('../utils/errors.js');
const log = require('../utils/log.js');

const trace = require('../utils/commandTrace.js');
const { checkPrefix } = require('../utils/prefix.js');

const commands = {};
const adminCommands = {};

const aliasToCommand = {};
const mcommands = {};
const commandGroups = {};
const appCommandNameToCommand = {};

class Command {
	constructor(main) {
		this.main = main;
		this.prefix = main.prefix;
		initCommands();
		this.commands = commands;
	}

	async execute(msg, raw) {
		try {
			return await this.dispatch(msg, raw);
		} catch (err) {
			// Never let a dispatch failure escape into the event loop
			errors.logFailure(err, { stage: 'dispatch', user: msg?.author?.id });
			return undefined;
		}
	}

	async dispatch(msg, raw) {
		// Parse content info
		let { args, context, prefix: usedPrefix, source } = (await checkPrefix(this.main, msg)) || {};
		const containsPoints =
			msg.content.toLowerCase().includes('owo') || msg.content.toLowerCase().includes('uwu');
		if (!args) {
			// The message did not start with the default or the guild prefix
			trace.rejected('prefix_not_matched', msg, {
				expected: this.main.prefix,
				guild_prefix: msg.channel?.guild?.prefix || 'unset',
			});
			//if user said owo/uwu
			if (containsPoints) {
				executeCommand(this.main, initParam(msg, 'points', [], this.main));
			}
			return;
		}

		//Get command name
		let command = args.shift().toLowerCase();
		trace.matched(msg, usedPrefix, source, command);

		//  Check if that command exists
		if (!commands[command]) {
			trace.parsed(msg, command, false);
			if (containsPoints) {
				executeCommand(this.main, initParam(msg, 'points', [], this.main));
			}
			return;
		}
		trace.parsed(msg, command, true, commands[command].alias?.[0]);

		// Make sure user accepts rules first
		if (!(await acceptedRules(this.main, msg))) {
			trace.rejected('rules_not_accepted', msg, { command });
			executeCommand(this.main, initParam(msg, 'rule', [], this.main));
			return;
		}

		// Init params to pass into command
		let param = initParam(msg, command, args, this.main, context);

		// Parse user raw data, so our cache is up to date
		this.checkRaw(raw);

		// Execute the command
		await executeCommand(this.main, param);
	}

	async executeInteraction(interaction) {
		//Get command name
		let command = interaction.command.toLowerCase();

		// Make sure user accepts rules first
		if (!(await acceptedRules(this.main, interaction))) {
			executeCommand(this.main, initParam(interaction, 'rule', [], this.main));
			return;
		}

		// Init params to pass into command
		let param = initParam(interaction, command, interaction.args, this.main);

		// Execute the command
		await executeCommand(this.main, param);
	}

	async executeAdmin(msg) {
		const cfg = this.main.config;
		if (!msg?.content || msg.content.toLowerCase().indexOf(this.prefix) !== 0) {
			return false;
		}
		let { args, context } = (await checkPrefix(this.main, msg)) || {};
		if (!args) return false;
		let command = args.shift().toLowerCase();
		let commandObj = adminCommands[command];
		if (!commandObj) {
			return false;
		}
		let param = initParam(msg, command, args, this.main, context);

		const decision = auth.canRunAdmin(commandObj, msg, cfg);
		if (!decision.allowed) {
			if (decision.reason === 'eval-disabled') {
				auth.audit('eval-blocked', msg, { command });
				log.warn(`eval command "${command}" blocked: ALLOW_EVAL is not enabled`);
			}
			return false;
		}

		auth.audit('admin-command', msg, { command, result: decision.reason });
		try {
			await commandObj.execute(param);
		} catch (err) {
			errors.logFailure(err, { stage: 'admin-command', command, user: msg.author.id });
		}
		return true;
	}

	checkRaw(raw) {
		if (raw?.author) {
			this.updateUser(raw.author);
		}
		raw?.mentions?.forEach((user) => this.updateUser(user));
	}

	updateUser(rawUser) {
		const user = this.main.bot.users.get(rawUser.id);
		let update = false;
		if (
			user &&
			(user.username !== rawUser.username ||
				user.avatar !== rawUser.avatar ||
				user.discriminator !== rawUser.discriminator ||
				user.globalname !== rawUser.global_name)
		) {
			update = true;
		}
		if (!user || update) {
			this.main.bot.users.update(rawUser, this.main.bot);
		}
	}

	messageUserInteractionToCommand(interaction) {
		return appCommandNameToCommand[interaction.name];
	}
}

async function executeCommand(main, p) {
	let { ban, cooldown, logger } = main;
	const commandName = p.commandAlias || p.command;

	try {
		// Check if the command/user/channel is banned
		if (!(await ban.check(p, p.commandAlias))) {
			trace.rejected('banned', p.msg, { command: commandName });
			return;
		}

		// Check for cooldowns
		if (!(await cooldown.check(p, p.commandAlias))) {
			trace.rejected('cooldown', p.msg, { command: commandName });
			return;
		}

		// Execute command. A thrown command is logged and answered once, never
		// propagated to the event loop where it would kill the cluster.
		trace.executed(p.msg, commandName, { phase: 'start' });
		await errors.runCommandSafely(p, () => commands[p.command].execute(p));
		trace.executed(p.msg, commandName, { phase: 'done' });

		// Log stats to statsd
		logger.command(commandName, p.msg);
		logger.logstash(commandName, p);
	} catch (err) {
		// ban/cooldown/metrics failures must not crash the process either
		errors.logFailure(err, { stage: 'command-pipeline', command: commandName });
	}
}

/**
 * Reads and initializes the commands
 * Will sort them by type and aliases
 */
function initCommands() {
	let groupCommand = function (command, name) {
		let groups = command.group;
		if (groups && groups.length) {
			for (let i in groups) {
				let group = groups[i];
				if (!commandGroups[group]) commandGroups[group] = [];
				commandGroups[group].push(name);
			}
		} else {
			if (!commandGroups['undefined']) commandGroups['undefined'] = [];
			commandGroups['undefined'].push(name);
		}
	};

	let addCommand = function (command) {
		if (command.owner || command.admin || command.manager || command.helper) {
			return addAdminCommand(command);
		}
		let alias = command.alias;
		let name = alias[0];
		if (alias) {
			for (let i = 0; i < alias.length; i++) {
				const existing = commands[alias[i]];
				if (existing && existing !== command) {
					// Two modules registering the same alias used to be resolved
					// silently (last one wins). Keep that behaviour but make the
					// shadowing visible.
					log.warn(
						`duplicate alias "${alias[i]}" registered by ${alias[0]}; it shadows another command`
					);
				}
				commands[alias[i]] = command;
				if (command.distinctAlias) {
					aliasToCommand[alias[i]] = alias[i];
					groupCommand(command, alias[i]);
					mcommands[alias[i]] = {
						botcheck: command.bot,
						cd: command.cooldown,
						ban: 12,
						half: command.half,
						six: command.six,
						group: command.group,
					};
				} else aliasToCommand[alias[i]] = name;
			}
		}
		if (!command.distinctAlias) groupCommand(command, name);
		mcommands[name] = {
			botcheck: command.bot,
			cd: command.cooldown,
			ban: 12,
			half: command.half,
			six: command.six,
			group: command.group,
		};

		command.appCommands?.forEach((appCommand) => {
			// Message or User commands
			if (appCommand.type === 3 || appCommand.type === 2) {
				appCommandNameToCommand[appCommand.name] = name;
			}
		});
	};

	let addAdminCommand = function (command) {
		let alias = command.alias;
		if (alias) {
			for (let i = 0; i < alias.length; i++) {
				adminCommands[alias[i]] = command;
			}
		}
	};
	for (let key in dir) {
		if (dir[key] instanceof CommandInterface) {
			addCommand(dir[key]);
		} else if (Array.isArray(dir[key])) {
			dir[key].forEach((val) => {
				if (val instanceof CommandInterface) {
					addCommand(val);
				}
			});
		} else {
			for (let key2 in dir[key]) {
				if (dir[key][key2] instanceof CommandInterface) {
					addCommand(dir[key][key2]);
				} else if (Array.isArray(dir[key][key2])) {
					dir[key][key2].forEach((val) => {
						if (val instanceof CommandInterface) {
							addCommand(val);
						}
					});
				}
			}
		}
	}
}

/**
 * Initializes the resources/utilities required for each command
 */
function initParam(msg, command, args, main, context) {
	let param = {
		msg: msg,
		options: msg.options || {},
		interaction: msg.interaction,
		args: args,
		context: context,
		command: command,
		client: main.bot,
		animalUtil: main.animalUtil,
		dbl: main.dbl,
		mysql: main.mysql,
		con: main.mysql.con,
		startTransaction: main.mysqlhandler.startTransaction,
		redis: main.redis,
		query: main.query,
		send: main.sender.send(msg),
		replyMsg: main.sender.reply(msg),
		errorMsg: main.sender.error(main.config.emoji.invalid, msg),
		sender: main.sender,
		macro: main.macro,
		global: main.global,
		event: main.event,
		aliasToCommand: aliasToCommand,
		commandAlias: aliasToCommand[command],
		commands: commands,
		mcommands: mcommands,
		commandGroups: commandGroups,
		logger: main.logger,
		log: main.logger.log,
		config: main.config,
		fetch: main.fetch,
		pubsub: main.pubsub,
		DataResolver: main.DataResolver,
		EmojiAdder: main.EmojiAdder,
		badwords: main.badwords,
		quest: function (questName, count, extra) {
			main.questHandler.increment(msg, questName, count, extra).catch(console.error);
		},
		reactionCollector: main.reactionCollector,
		interactionCollector: main.interactionCollector,
		PagedMessage: main.PagedMessage,
		dateUtil: main.dateUtil,
		neo4j: main.neo4j,
		giveaway: main.giveaway,
		patreonUtil: main.patreonUtil,
		cache: main.cache,
	};
	param.setCooldown = function (cooldown) {
		main.cooldown.setCooldown(param, aliasToCommand[command], cooldown);
	};
	param.getMention = function (id) {
		if (!id) return;
		id = id.match(/[0-9]+/);
		if (!id) return;
		id = id[0];
		for (let i in param.msg.mentions) {
			let tempUser = param.msg.mentions[i];
			if (tempUser.id == id) {
				let tempMember = param.msg.channel?.guild?.members.get(tempUser.id);
				if (tempMember) {
					tempMember.bot = tempUser.bot;
					return tempMember;
				}
				return tempUser;
			}
		}
	};
	param.getRole = function (id) {
		id = id.match(/[0-9]+/);
		if (!id) return;
		id = id[0];
		return param.msg.channel.guild.roles.get(id);
	};
	param.replaceMentions = function (text) {
		if (!text) return;
		let userMentions = text.match(/<@!?\d+>/g);
		let roleMentions = text.match(/<@&\d+>/g);

		for (let i in userMentions) {
			let mention = userMentions[i];
			let user = param.getMention(mention);
			if (user) text = text.replace(mention, '@' + user.username);
		}

		for (let i in roleMentions) {
			let mention = roleMentions[i];
			let role = param.getRole(mention);
			if (role) text = text.replace(mention, '@' + role.name);
		}
		return text;
	};
	param.getName = (user) => {
		return param.global.getName(user || param.msg.member || param.msg.author);
	};
	param.getUniqueName = (user) => {
		return param.global.getUniqueName(user || param.msg.author);
	};
	param.getTag = (user) => {
		return param.global.getTag(user || param.msg.author);
	};
	param.getFlags = () => {
		if (param.flags) {
			return param.flags;
		}
		param.flags = {};
		args?.forEach((arg) => {
			if (arg.charAt(0) === '-') {
				param.flags[arg.substring(1).toLowerCase()] = true;
			}
		});
		return param.flags;
	};
	return param;
}

async function acceptedRules(main, msg) {
	if (!msg.author.acceptedRules) {
		// Parameterized: the id never gets concatenated into the statement
		let sql = 'SELECT rules.* FROM rules INNER JOIN user ON user.uid = rules.uid WHERE id = ?;';
		let result = await main.mysqlhandler.query(sql, [msg.author.id]);
		msg.author.acceptedRules = !!result[0];
	}
	return msg.author.acceptedRules;
}

module.exports = Command;
