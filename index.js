require('dotenv').config();
const path = require('path');
const http = require('http');
const https = require('https');
const emoji = require('node-emoji');
const { createClient } = require('@libsql/client');
const {
	Client,
	GatewayIntentBits,
	Events,
	Status,
	MessageFlags,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	ChannelType,
	PermissionsBitField,
	EmbedBuilder,
	REST,
	Routes,
	SlashCommandBuilder,
} = require('discord.js');

// --=-== | Config | ==-=--

const Env = {
	DiscordToken: process.env.DISCORD_TOKEN,
	ClientId: process.env.CLIENT_ID,
	GuildId: process.env.GUILD_ID,
	LeadsRoleId: process.env.LEADS_ROLE_ID,
	MemberRoleId: process.env.MEMBER_ROLE_ID,
	RulesChannelId: process.env.RULES_CHANNEL_ID,
	TicketsCategoryId: process.env.TICKETS_CATEGORY_ID,
	ProjectsCategoryId: process.env.PROJECTS_CATEGORY_ID,
	InvoicesCategoryId: process.env.INVOICES_CATEGORY_ID,
	StorageChannelId: process.env.STORAGE_CHANNEL_ID,
	TursoUrl: process.env.TURSO_DATABASE_URL,
	TursoToken: process.env.TURSO_AUTH_TOKEN,
	PublicUrl: process.env.RENDER_URL || process.env.RENDER_EXTERNAL_URL,
	Port: Number(process.env.PORT) || 3000,
};

const REQUIRED_ENV = ['DiscordToken', 'ClientId', 'GuildId', 'LeadsRoleId'];
const APPLICATION_ROLE_COLOR = '#607d8b';
const BRAND_COLOR = 0x5865f2;
const GREEN_COLOR = 0x57f287;
const RED_COLOR = 0xed4245;
const FOOTER = { text: 'Qualion Management' };
const INVOICE_COOLDOWN_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const WATCHDOG_LIMIT_MS = 5 * 60 * 1000;
const SELF_PING_INTERVAL_MS = 4 * 60 * 1000;
const TEMPLATE_PATH = path.join(__dirname, 'InvoiceTemplate.docx');
const BOOTED_AT = Date.now();

// --=-== | Logging | ==-=--

function log(...args) {
	console.log(`[${new Date().toISOString()}]`, ...args);
}

function logError(context, err) {
	console.error(`[${new Date().toISOString()}] ${context}:`, err?.stack || err?.message || err);
}

const missingEnv = REQUIRED_ENV.filter((key) => !Env[key]);
if (missingEnv.length > 0) {
	logError('Startup', `Missing required environment variables: ${missingEnv.join(', ')}`);
	setTimeout(() => process.exit(1), 30 * 1000);
}

// --=-== | Process safety | ==-=--

process.on('unhandledRejection', (err) => logError('Unhandled rejection', err));

process.on('uncaughtException', (err) => {
	logError('Uncaught exception — restarting', err);
	setTimeout(() => process.exit(1), 1000);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
	process.on(signal, () => {
		log(`${signal} received, shutting down`);
		client.destroy().finally(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000);
	});
}

// --=-== | Client | ==-=--

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.Error, (err) => logError('Client error', err));
client.on(Events.Warn, (msg) => log('Client warning:', msg));
client.on(Events.ShardDisconnect, (event, id) => log(`Shard ${id} disconnected (code ${event?.code})`));
client.on(Events.ShardReconnecting, (id) => log(`Shard ${id} reconnecting`));
client.on(Events.ShardResume, (id, replayed) => log(`Shard ${id} resumed (${replayed} events replayed)`));
client.on(Events.ShardError, (err, id) => logError(`Shard ${id} error`, err));
client.on(Events.Invalidated, () => {
	logError('Session', 'Discord invalidated the session — restarting');
	process.exit(1);
});

// --=-== | Helpers | ==-=--

function hasRole(member, roleId) {
	if (!member || !roleId) return false;
	if (Array.isArray(member.roles)) return member.roles.includes(roleId);
	return member.roles?.cache?.has(roleId) ?? false;
}

function isLead(interaction) {
	return hasRole(interaction.member, Env.LeadsRoleId);
}

function slugify(text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function notice(text, color = BRAND_COLOR) {
	return new EmbedBuilder().setColor(color).setDescription(text);
}

async function respond(interaction, content, extra = {}) {
	const payload = { content, embeds: [], components: [], ...extra };
	try {
		if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
		return await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
	} catch (err) {
		logError('Respond failed', err);
	}
}

async function fetchChannel(id) {
	if (!id) return null;
	return client.channels.fetch(id).catch(() => null);
}

function requireEnv(keys) {
	const missing = keys.filter((key) => !Env[key]);
	return missing.length > 0 ? `This feature isn't configured yet — missing ${missing.join(', ')} on the host.` : null;
}

function resolveEmojis(guild, text) {
	const withCustom = text.replace(/:([a-zA-Z0-9_]+)(~\d+)?:/g, (match, name) => {
		const found = guild.emojis.cache.find((e) => e.name.toLowerCase() === name.toLowerCase());
		return found ? found.toString() : match;
	});
	return emoji.emojify(withCustom);
}

// --=-== | Persistent counter (stored in Discord) | ==-=--

const Counter = {
	values: {},
	messageId: null,
	queue: Promise.resolve(),
};

async function loadCounter() {
	const channel = await fetchChannel(Env.StorageChannelId);
	if (!channel) return log('Counter: no storage channel, numbering falls back to existing channels');
	try {
		const messages = await channel.messages.fetch({ limit: 50 });
		const stored = messages.find((m) => m.author.id === client.user.id && m.content.startsWith('COUNTER'));
		if (!stored) return log('Counter: no saved state yet');
		const match = stored.content.match(/```json\n([\s\S]*?)\n```/);
		Counter.values = match ? JSON.parse(match[1]) : {};
		Counter.messageId = stored.id;
		log('Counter restored:', JSON.stringify(Counter.values));
	} catch (err) {
		logError('Counter load failed', err);
	}
}

async function saveCounter() {
	const channel = await fetchChannel(Env.StorageChannelId);
	if (!channel) return;
	const content = 'COUNTER```json\n' + JSON.stringify(Counter.values) + '\n```';
	try {
		if (Counter.messageId) {
			const existing = await channel.messages.fetch(Counter.messageId).catch(() => null);
			if (existing) return void (await existing.edit(content));
		}
		const sent = await channel.send(content);
		Counter.messageId = sent.id;
	} catch (err) {
		logError('Counter save failed', err);
	}
}

function highestExistingNumber(category, prefix) {
	const pattern = new RegExp(`^┃${prefix}-(\\d+)$`);
	let highest = 0;
	for (const channel of category?.children?.cache?.values() ?? []) {
		const match = channel.name.match(pattern);
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return highest;
}

function nextNumber(prefix, category) {
	const run = Counter.queue.then(async () => {
		const next = Math.max(Counter.values[prefix] || 0, highestExistingNumber(category, prefix)) + 1;
		Counter.values[prefix] = next;
		await saveCounter();
		return String(next).padStart(3, '0');
	});
	Counter.queue = run.catch(() => {});
	return run;
}

// --=-== | Invoice database (Turso, optional) | ==-=--

let turso = null;
try {
	if (Env.TursoUrl) turso = createClient({ url: Env.TursoUrl, authToken: Env.TursoToken });
} catch (err) {
	logError('Turso client setup failed — invoice tracking disabled', err);
}

async function dbRun(sql, args = []) {
	if (!turso) return null;
	try {
		return await turso.execute({ sql, args });
	} catch (err) {
		logError('Database query failed', err);
		return null;
	}
}

async function ensureInvoiceTable() {
	if (!turso) return;
	await dbRun(`CREATE TABLE IF NOT EXISTS invoices (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		discord_user_id TEXT NOT NULL,
		discord_username TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		channel_name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	if (turso) await turso.execute('ALTER TABLE invoices ADD COLUMN approved_invoice_url TEXT').catch(() => {});
	if (turso) await turso.execute('ALTER TABLE invoices ADD COLUMN approved_at TEXT').catch(() => {});
}

// --=-== | Slash commands | ==-=--

const commands = [
	new SlashCommandBuilder()
		.setName('create-applications-panel')
		.setDescription('Post the applications panel — one button per #607d8b role'),
	new SlashCommandBuilder()
		.setName('create-invoice-panel')
		.setDescription('Post the payment ticket panel in this channel'),
	new SlashCommandBuilder()
		.setName('post-verify')
		.setDescription('Post the verification panel in this channel'),
	new SlashCommandBuilder()
		.setName('add-employee')
		.setDescription('Give a user access to a project channel')
		.addUserOption((o) => o.setName('user').setDescription('Who to add').setRequired(true))
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which project channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
		),
	new SlashCommandBuilder()
		.setName('approve-invoice')
		.setDescription('Record this invoice channel as approved with the completed file')
		.addAttachmentOption((o) => o.setName('invoice').setDescription('The completed invoice PDF').setRequired(true)),
	new SlashCommandBuilder()
		.setName('send-message')
		.setDescription('Post a message as the bot in any channel')
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
		)
		.addStringOption((o) => o.setName('message').setDescription('What to send').setRequired(true).setMaxLength(2000)),
	new SlashCommandBuilder()
		.setName('clear-channel')
		.setDescription('Delete every message in a channel — irreversible')
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which channel to wipe').setRequired(true).addChannelTypes(ChannelType.GuildText)
		)
		.addStringOption((o) => o.setName('confirm').setDescription('Type CONFIRM exactly to actually do this').setRequired(true)),
	new SlashCommandBuilder()
		.setName('bot-status')
		.setDescription('Show whether every part of the bot is configured and healthy'),
].map((c) => c.toJSON());

async function registerCommands() {
	const rest = new REST({ version: '10' }).setToken(Env.DiscordToken);
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			await rest.put(Routes.applicationGuildCommands(Env.ClientId, Env.GuildId), { body: commands });
			return log(`Registered ${commands.length} commands`);
		} catch (err) {
			logError(`Command registration attempt ${attempt} failed`, err);
			await sleep(attempt * 10 * 1000);
		}
	}
}

// --=-== | Panels | ==-=--

function applicationRoles(guild) {
	return [...guild.roles.cache.filter((r) => r.hexColor.toLowerCase() === APPLICATION_ROLE_COLOR).values()].sort(
		(a, b) => b.position - a.position
	);
}

function buildApplicationsPanel(roles) {
	const rows = [];
	for (let i = 0; i < roles.length && rows.length < 5; i += 5) {
		rows.push(
			new ActionRowBuilder().addComponents(
				roles.slice(i, i + 5).map((role) =>
					new ButtonBuilder().setCustomId(`apply:${role.id}`).setLabel(role.name.slice(0, 80)).setStyle(ButtonStyle.Primary)
				)
			)
		);
	}
	const embed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle('Applications')
		.setDescription('Pick the role you were pinged for. A private channel opens with the Leads.\n-# You need that role to apply.')
		.setFooter(FOOTER);
	return { embeds: [embed], components: rows };
}

function buildVerifyPanel() {
	const rules = Env.RulesChannelId ? `<#${Env.RulesChannelId}>` : 'the rules';
	const embed = new EmbedBuilder()
		.setColor(GREEN_COLOR)
		.setTitle('Verify to enter')
		.setDescription(`Read ${rules} first.\n\nOnce you're good with it, click **Verify** below to unlock the rest of the server.`)
		.setFooter(FOOTER);
	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('verify_member').setLabel('VERIFY').setStyle(ButtonStyle.Success)
	);
	return { embeds: [embed], components: [row] };
}

function buildInvoicePanel() {
	const embed = new EmbedBuilder()
		.setColor(GREEN_COLOR)
		.setTitle('💵 Request a payment')
		.setDescription('Create a ticket for payment. A private channel opens with your name on it and is kept on record.')
		.setFooter(FOOTER);
	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('open_invoice').setLabel('Create Payment Ticket').setStyle(ButtonStyle.Success)
	);
	return { embeds: [embed], components: [row] };
}

// --=-== | Application tickets | ==-=--

async function findOpenTicket(category, userId) {
	return category.children.cache.find((c) => c.topic?.startsWith(`applicant:${userId}`)) || null;
}

async function createApplicationTicket(interaction, role) {
	const guild = interaction.guild;
	const category = await fetchChannel(Env.TicketsCategoryId);
	if (!category || category.type !== ChannelType.GuildCategory) {
		return respond(interaction, "The Tickets category can't be found — a Lead needs to check TICKETS_CATEGORY_ID.");
	}

	const existing = await findOpenTicket(category, interaction.user.id);
	if (existing) return respond(interaction, `You already have an open application: ${existing}`);

	const number = await nextNumber('application', category);
	const channel = await guild.channels.create({
		name: `┃application-${number}`,
		type: ChannelType.GuildText,
		parent: category.id,
		topic: `applicant:${interaction.user.id} role:${role.id}`,
		permissionOverwrites: [
			{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
			{
				id: interaction.user.id,
				allow: [
					PermissionsBitField.Flags.ViewChannel,
					PermissionsBitField.Flags.SendMessages,
					PermissionsBitField.Flags.ReadMessageHistory,
					PermissionsBitField.Flags.AttachFiles,
				],
			},
			{
				id: Env.LeadsRoleId,
				allow: [
					PermissionsBitField.Flags.ViewChannel,
					PermissionsBitField.Flags.SendMessages,
					PermissionsBitField.Flags.ReadMessageHistory,
					PermissionsBitField.Flags.ManageChannels,
				],
			},
			{
				id: client.user.id,
				allow: [
					PermissionsBitField.Flags.ViewChannel,
					PermissionsBitField.Flags.SendMessages,
					PermissionsBitField.Flags.ManageChannels,
					PermissionsBitField.Flags.EmbedLinks,
					PermissionsBitField.Flags.AttachFiles,
				],
			},
		],
	});

	const embed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle(`${role.name} — ${number}`)
		.setThumbnail(interaction.user.displayAvatarURL())
		.addFields({ name: 'Opened by', value: `<@${interaction.user.id}>` })
		.setFooter(FOOTER)
		.setTimestamp();

	const buttons = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`approve:${interaction.user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Danger)
	);

	await channel.send({ content: `<@&${Env.LeadsRoleId}> <@${interaction.user.id}>`, embeds: [embed], components: [buttons] });
	return respond(interaction, `Application opened: ${channel}`);
}

function resolveApplicationRole(guild, customId) {
	const [kind, value] = customId.split(':');
	if (kind === 'apply') return guild.roles.cache.get(value) || null;
	return guild.roles.cache.find((r) => slugify(r.name) === value) || null;
}

// --=-== | Invoice tickets | ==-=--

const invoiceCooldowns = new Map();

async function createInvoiceTicket(interaction) {
	const guild = interaction.guild;
	const category = await fetchChannel(Env.InvoicesCategoryId);
	if (!category || category.type !== ChannelType.GuildCategory) {
		return respond(interaction, "The Invoices category can't be found — a Lead needs to check INVOICES_CATEGORY_ID.");
	}

	const slug = slugify(interaction.user.username);
	const number = String(highestExistingNumber(category, slug) + 1).padStart(3, '0');
	const name = `┃${slug}-${number}`;

	const channel = await guild.channels.create({
		name,
		type: ChannelType.GuildText,
		parent: category.id,
		topic: `invoice:${interaction.user.id}`,
		permissionOverwrites: [
			{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
			{
				id: interaction.user.id,
				allow: [
					PermissionsBitField.Flags.ViewChannel,
					PermissionsBitField.Flags.SendMessages,
					PermissionsBitField.Flags.ReadMessageHistory,
					PermissionsBitField.Flags.AttachFiles,
				],
			},
			{
				id: Env.LeadsRoleId,
				allow: [
					PermissionsBitField.Flags.ViewChannel,
					PermissionsBitField.Flags.SendMessages,
					PermissionsBitField.Flags.ReadMessageHistory,
				],
			},
			{
				id: client.user.id,
				allow: [
					PermissionsBitField.Flags.ViewChannel,
					PermissionsBitField.Flags.SendMessages,
					PermissionsBitField.Flags.ManageMessages,
					PermissionsBitField.Flags.EmbedLinks,
					PermissionsBitField.Flags.AttachFiles,
				],
			},
		],
	});

	const embed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle('Invoice template attached')
		.setDescription(
			"We're not able to fill this in on your behalf for legal reasons — please complete it yourself.\n\n" +
				'Fill in your **legal name and legal address** along with the rest of your details under **Payee**, list what was delivered under **Work** with quantity and rate, fill in **Payment** with how you want to be paid, and note the project under **Project**. Once it\'s filled in, export it as a **PDF** and post that back in this channel — a Lead will review and process it from here.'
		)
		.setFooter(FOOTER);

	const ping = `<@&${Env.LeadsRoleId}> <@${interaction.user.id}>`;
	let message;
	try {
		message = await channel.send({ content: ping, embeds: [embed], files: [TEMPLATE_PATH] });
	} catch (err) {
		logError('Invoice template attach failed', err);
		message = await channel.send({ content: `${ping}\n\n⚠️ The template file couldn't be attached — ask a Lead for it.`, embeds: [embed] });
	}
	await message.pin().catch((err) => logError('Invoice pin failed', err));

	await dbRun('INSERT INTO invoices (discord_user_id, discord_username, channel_id, channel_name) VALUES (?, ?, ?, ?)', [
		interaction.user.id,
		interaction.user.username,
		channel.id,
		name,
	]);
	invoiceCooldowns.set(interaction.user.id, Date.now());
	return respond(interaction, `Payment ticket opened: ${channel}`);
}

// --=-== | Clear channel | ==-=--

async function clearChannel(channel) {
	let total = 0;
	for (;;) {
		const fetched = await channel.messages.fetch({ limit: 100 });
		if (fetched.size === 0) break;
		const deleted = await channel.bulkDelete(fetched, true).catch(() => new Map());
		total += deleted.size;
		const remaining = fetched.filter((m) => !deleted.has(m.id));
		for (const message of remaining.values()) {
			await message.delete().catch(() => {});
			total += 1;
			await sleep(1000);
		}
	}
	return total;
}

// --=-== | Command handlers | ==-=--

const CommandHandlers = {
	'create-applications-panel': async (interaction) => {
		await interaction.guild.roles.fetch();
		const roles = applicationRoles(interaction.guild);
		if (roles.length === 0) return respond(interaction, `No roles with color ${APPLICATION_ROLE_COLOR} found.`);
		await interaction.channel.send(buildApplicationsPanel(roles));
		const shown = roles.slice(0, 25).map((r) => r.name).join(', ');
		const extra = roles.length > 25 ? `\n⚠️ Discord allows 25 buttons per message — ${roles.length - 25} role(s) left off.` : '';
		return respond(interaction, `Panel posted with: ${shown}.${extra}\nDelete any older panel above it.`);
	},

	'create-invoice-panel': async (interaction) => {
		await interaction.channel.send(buildInvoicePanel());
		return respond(interaction, 'Invoice panel posted.');
	},

	'post-verify': async (interaction) => {
		await interaction.channel.send(buildVerifyPanel());
		return respond(interaction, 'Verification panel posted.');
	},

	'add-employee': async (interaction) => {
		const user = interaction.options.getUser('user');
		const channel = await fetchChannel(interaction.options.getChannel('channel').id);
		if (!channel) return respond(interaction, "That channel can't be found.");
		await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
		await channel.send(`<@${user.id}> has been added to this project.`);
		return respond(interaction, `Added <@${user.id}> to ${channel}.`);
	},

	'approve-invoice': async (interaction) => {
		const channel = interaction.channel;
		if (!Env.InvoicesCategoryId || channel.parentId !== Env.InvoicesCategoryId) {
			return respond(interaction, 'This only works inside an invoice channel.');
		}
		const attachment = interaction.options.getAttachment('invoice');
		const match = channel.name.replace(/^┃/, '').match(/^(.+)-(\d{3})$/);
		const displayName = match ? `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} - ${match[2]}` : channel.name;

		const updated = await dbRun(
			"UPDATE invoices SET status = 'approved', approved_invoice_url = ?, approved_at = datetime('now') WHERE channel_id = ?",
			[attachment.url, channel.id]
		);
		if (updated && updated.rowsAffected === 0) {
			const ownerId = channel.topic?.match(/^invoice:(\d+)/)?.[1] || interaction.user.id;
			await dbRun(
				"INSERT INTO invoices (discord_user_id, discord_username, channel_id, channel_name, status, approved_invoice_url, approved_at) VALUES (?, ?, ?, ?, 'approved', ?, datetime('now'))",
				[ownerId, displayName, channel.id, displayName, attachment.url]
			);
		}

		await channel.send({
			embeds: [
				new EmbedBuilder()
					.setColor(GREEN_COLOR)
					.setTitle('✅ Invoice approved')
					.setDescription(`Recorded as **${displayName}**.\n\n[View the submitted invoice](${attachment.url})`),
			],
		});
		const note = turso ? '' : '\n-# Turso isn\'t configured, so this was only recorded in Discord.';
		return respond(interaction, `Marked ${displayName} as approved.${note}`);
	},

	'send-message': async (interaction) => {
		const channel = await fetchChannel(interaction.options.getChannel('channel').id);
		if (!channel) return respond(interaction, "That channel can't be found.");
		const text = resolveEmojis(interaction.guild, interaction.options.getString('message'));
		if (text.length > 2000) return respond(interaction, `That message is ${text.length} characters — Discord's limit is 2000.`);
		await channel.send(text);
		return respond(interaction, `Sent to ${channel}.`);
	},

	'clear-channel': async (interaction) => {
		if (interaction.options.getString('confirm') !== 'CONFIRM') {
			return respond(interaction, 'Not run — type CONFIRM exactly in the confirm field. This cannot be undone.');
		}
		const channel = await fetchChannel(interaction.options.getChannel('channel').id);
		if (!channel) return respond(interaction, "That channel can't be found.");
		const count = await clearChannel(channel);
		return respond(interaction, `Deleted ${count} message(s) from ${channel}.`);
	},

	'bot-status': async (interaction) => {
		const check = async (label, id, type) => {
			if (!id) return `⚪ ${label} — not set`;
			const found = type === 'role' ? interaction.guild.roles.cache.get(id) : await fetchChannel(id);
			return found ? `🟢 ${label}` : `🔴 ${label} — ID set but not found`;
		};
		const lines = await Promise.all([
			check('Leads role', Env.LeadsRoleId, 'role'),
			check('Member role', Env.MemberRoleId, 'role'),
			check('Rules channel', Env.RulesChannelId),
			check('Tickets category', Env.TicketsCategoryId),
			check('Projects category', Env.ProjectsCategoryId),
			check('Invoices category', Env.InvoicesCategoryId),
			check('Storage channel', Env.StorageChannelId),
		]);
		const database = turso ? ((await dbRun('SELECT 1')) ? '🟢 Turso database' : '🔴 Turso database — not reachable') : '⚪ Turso database — not set';
		const uptime = Math.floor((Date.now() - BOOTED_AT) / 60000);
		const embed = new EmbedBuilder()
			.setColor(BRAND_COLOR)
			.setTitle('Bot status')
			.setDescription([...lines, database].join('\n'))
			.addFields(
				{ name: 'Gateway ping', value: `${client.ws.ping} ms`, inline: true },
				{ name: 'Uptime', value: `${uptime} min`, inline: true },
				{ name: 'Application roles', value: String(applicationRoles(interaction.guild).length), inline: true }
			)
			.setFooter(FOOTER);
		return respond(interaction, '', { embeds: [embed] });
	},
};

// --=-== | Component handlers | ==-=--

async function handleApply(interaction) {
	const blocked = requireEnv(['TicketsCategoryId']);
	if (blocked) return respond(interaction, blocked);
	const role = resolveApplicationRole(interaction.guild, interaction.customId);
	if (!role) return respond(interaction, 'This panel is out of date — ask a Lead to run /create-applications-panel again.');
	if (!hasRole(interaction.member, role.id)) return respond(interaction, `You need the <@&${role.id}> role before applying for it.`);
	return createApplicationTicket(interaction, role);
}

async function handleInvoice(interaction) {
	const blocked = requireEnv(['InvoicesCategoryId']);
	if (blocked) return respond(interaction, blocked);
	const lastUsed = invoiceCooldowns.get(interaction.user.id);
	if (lastUsed && Date.now() - lastUsed < INVOICE_COOLDOWN_MS) {
		const readyAt = Math.floor((lastUsed + INVOICE_COOLDOWN_MS) / 1000);
		return respond(interaction, `You can create another payment ticket <t:${readyAt}:R>.`);
	}
	return createInvoiceTicket(interaction);
}

async function handleVerify(interaction) {
	const blocked = requireEnv(['MemberRoleId']);
	if (blocked) return respond(interaction, blocked);
	if (hasRole(interaction.member, Env.MemberRoleId)) return respond(interaction, "You're already verified.");
	try {
		await interaction.member.roles.add(Env.MemberRoleId);
		return respond(interaction, "You're verified — welcome in.");
	} catch (err) {
		logError('Verify role add failed (is the bot role above Member?)', err);
		return respond(interaction, "Couldn't give you the role — please ping a Lead.");
	}
}

async function handleApprove(interaction) {
	if (!isLead(interaction)) return respond(interaction, 'Only Leads can approve this.');
	const blocked = requireEnv(['ProjectsCategoryId']);
	if (blocked) return respond(interaction, blocked);
	const applicantId = interaction.customId.split(':')[1];
	const channels = await interaction.guild.channels.fetch();
	const projects = [...channels.filter((c) => c?.parentId === Env.ProjectsCategoryId && c.type === ChannelType.GuildText).values()]
		.sort((a, b) => a.position - b.position)
		.slice(0, 25);
	if (projects.length === 0) return respond(interaction, 'No channels found under the Projects category.');
	const menu = new StringSelectMenuBuilder()
		.setCustomId(`approve_channel:${applicantId}`)
		.setPlaceholder('Which project should they join?')
		.addOptions(projects.map((c) => ({ label: c.name.replace(/^┃/, '').slice(0, 100), value: c.id })));
	return respond(interaction, `Pick the project to add <@${applicantId}> to:`, {
		components: [new ActionRowBuilder().addComponents(menu)],
	});
}

async function handleApproveChannel(interaction) {
	if (!isLead(interaction)) return respond(interaction, 'Only Leads can approve this.');
	const applicantId = interaction.customId.split(':')[1];
	const target = await fetchChannel(interaction.values[0]);
	if (!target) return respond(interaction, "That channel doesn't exist anymore.");
	await target.permissionOverwrites.edit(applicantId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
	await target.send(`<@${applicantId}> has been added to this project.`);
	await interaction.channel?.send({ embeds: [notice(`✅ <@${applicantId}> was added to ${target} by <@${interaction.user.id}>.`, GREEN_COLOR)] }).catch(() => {});
	return respond(interaction, `<@${applicantId}> added to ${target}.`);
}

async function handleClose(interaction) {
	if (!isLead(interaction)) return respond(interaction, 'Only Leads can close this.');
	await interaction.reply({ embeds: [notice('Closing this ticket in 5 seconds.', RED_COLOR)] });
	const channel = interaction.channel;
	setTimeout(() => channel?.delete().catch((err) => logError('Ticket delete failed', err)), 5000);
}

async function handleComponent(interaction) {
	const id = interaction.customId;
	if (id === 'close_ticket') return handleClose(interaction);

	if (interaction.isStringSelectMenu() && id.startsWith('approve_channel:')) {
		await interaction.deferUpdate();
		return handleApproveChannel(interaction);
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	if (id.startsWith('apply:') || id.startsWith('open:')) return handleApply(interaction);
	if (id === 'open_invoice') return handleInvoice(interaction);
	if (id === 'verify_member') return handleVerify(interaction);
	if (id.startsWith('approve:')) return handleApprove(interaction);
	return respond(interaction, 'This button is no longer used.');
}

async function handleCommand(interaction) {
	if (!isLead(interaction)) {
		return interaction.reply({ content: 'Only Leads can use bot commands.', flags: MessageFlags.Ephemeral });
	}
	const handler = CommandHandlers[interaction.commandName];
	if (!handler) return interaction.reply({ content: 'Unknown command — it may have been removed.', flags: MessageFlags.Ephemeral });
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	return handler(interaction);
}

// --=-== | Events | ==-=--

client.once(Events.ClientReady, async () => {
	log(`Logged in as ${client.user.tag}`);
	await Promise.allSettled([registerCommands(), loadCounter(), ensureInvoiceTable()]);
	const guild = client.guilds.cache.get(Env.GuildId);
	if (!guild) logError('Startup', `Bot is not in the server GUILD_ID=${Env.GuildId}`);
	log('Startup complete');
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.inGuild()) return;
	try {
		if (interaction.isChatInputCommand()) return await handleCommand(interaction);
		if (interaction.isButton() || interaction.isStringSelectMenu()) return await handleComponent(interaction);
	} catch (err) {
		logError(`Interaction ${interaction.customId || interaction.commandName} failed`, err);
		const reason = err?.code === 50013 ? 'The bot is missing a permission for that.' : 'Something went wrong — try again in a moment.';
		await respond(interaction, `⚠️ ${reason}`);
	}
});

// --=-== | Health server | ==-=--

function healthReport() {
	const ready = client.isReady() && client.ws.status === Status.Ready;
	return {
		ok: ready,
		discord: ready ? 'ready' : `not ready (status ${client.ws.status})`,
		ping: client.ws.ping,
		uptimeMinutes: Math.floor((Date.now() - BOOTED_AT) / 60000),
	};
}

const server = http.createServer((req, res) => {
	if (req.url?.startsWith('/health')) {
		const report = healthReport();
		res.writeHead(report.ok ? 200 : 503, { 'Content-Type': 'application/json' });
		return res.end(JSON.stringify(report));
	}
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('OK');
});
server.on('error', (err) => logError('Health server error', err));
server.listen(Env.Port, () => log(`Health server on port ${Env.Port}`));

// --=-== | Self-ping (keeps Render's free tier awake) | ==-=--

if (Env.PublicUrl) {
	setInterval(() => {
		const request = https.get(Env.PublicUrl, (res) => {
			res.resume();
			if (res.statusCode !== 200) log(`Self-ping returned ${res.statusCode}`);
		});
		request.setTimeout(20000, () => request.destroy(new Error('timeout')));
		request.on('error', (err) => log(`Self-ping failed: ${err.message}`));
	}, SELF_PING_INTERVAL_MS);
} else {
	log('No RENDER_URL set — self-ping disabled');
}

// --=-== | Watchdog (restarts if Discord connection stays down) | ==-=--

let unhealthySince = null;
setInterval(() => {
	if (healthReport().ok) {
		unhealthySince = null;
		return;
	}
	unhealthySince ??= Date.now();
	const downFor = Date.now() - unhealthySince;
	log(`Watchdog: Discord not ready for ${Math.round(downFor / 1000)}s`);
	if (downFor > WATCHDOG_LIMIT_MS) {
		logError('Watchdog', 'Discord connection down too long — restarting process');
		process.exit(1);
	}
}, WATCHDOG_INTERVAL_MS);

// --=-== | Login | ==-=--

if (missingEnv.length === 0) {
	client.login(Env.DiscordToken).catch((err) => {
		const invalid = err?.code === 'TokenInvalid' || /invalid token/i.test(err?.message || '');
		logError(invalid ? 'Login failed — DISCORD_TOKEN is invalid, reset it in the Developer Portal' : 'Login failed', err);
		setTimeout(() => process.exit(1), invalid ? 60 * 1000 : 15 * 1000);
	});
}
