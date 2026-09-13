require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { createClient } = require('@libsql/client');
const emoji = require('node-emoji');
const {
	Client,
	GatewayIntentBits,
	Events,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	PermissionsBitField,
	EmbedBuilder,
	REST,
	Routes,
	SlashCommandBuilder,
} = require('discord.js');

const {
	DISCORD_TOKEN,
	CLIENT_ID,
	GUILD_ID,
	TICKETS_CATEGORY_ID,
	LEADS_ROLE_ID,
	MEMBER_ROLE_ID,
	RULES_CHANNEL_ID,
	STORAGE_CHANNEL_ID,
	INVOICES_CATEGORY_ID,
} = process.env;

const BRAND_COLOR = 0x5865f2;
const GREEN_COLOR = 0x57f287;

// --=-== | Storage (ticket types, ticket counter) | ==-=--

const CONFIG_FILE = path.join(__dirname, 'config.json');
const COUNTER_FILE = process.env.COUNTER_PATH || path.join(__dirname, 'counter.json');

function loadJson(file, fallback) {
	if (!fs.existsSync(file)) return fallback;
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJson(file, data) {
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let counterStoreMessageId = null;

async function loadCounterFromDiscord() {
	if (!STORAGE_CHANNEL_ID) return;
	try {
		const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
		const pins = await channel.messages.fetchPinned();
		const stored = pins.find((m) => m.author.id === client.user.id && m.content.includes('COUNTER'));
		if (stored) {
			counterStoreMessageId = stored.id;
			const raw = stored.content.replace(/^COUNTER```json\n|\n```$/g, '');
			saveJson(COUNTER_FILE, JSON.parse(raw));
			console.log('Ticket counter restored from storage channel.');
		}
	} catch (err) {
		console.log(`Counter restore failed: ${err.message}`);
	}
}

async function persistCounter(counters) {
	saveJson(COUNTER_FILE, counters);
	if (!STORAGE_CHANNEL_ID) return;
	try {
		const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
		const content = 'COUNTER```json\n' + JSON.stringify(counters) + '\n```';
		if (counterStoreMessageId) {
			const msg = await channel.messages.fetch(counterStoreMessageId).catch(() => null);
			if (msg) {
				await msg.edit(content);
				return;
			}
		}
		const sent = await channel.send(content);
		await sent.pin().catch(() => {});
		counterStoreMessageId = sent.id;
	} catch (err) {
		console.log(`Counter persist failed: ${err.message}`);
	}
}

async function nextNumber(prefix) {
	const counters = loadJson(COUNTER_FILE, {});
	const next = (counters[prefix] || 0) + 1;
	counters[prefix] = next;
	await persistCounter(counters);
	return String(next).padStart(3, '0');
}

// --=-== | Invoice database (Turso) | ==-=--

const turso = process.env.TURSO_DATABASE_URL
	? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
	: null;

async function ensureInvoiceTable() {
	if (!turso) return;
	try {
		await turso.execute(`
			CREATE TABLE IF NOT EXISTS invoices (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				discord_user_id TEXT NOT NULL,
				discord_username TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				channel_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		// Older tables won't have these yet — add them, ignore the error if they're already there.
		await turso.execute('ALTER TABLE invoices ADD COLUMN approved_invoice_url TEXT').catch(() => {});
		await turso.execute('ALTER TABLE invoices ADD COLUMN approved_at TEXT').catch(() => {});
	} catch (err) {
		console.log(`Invoice table setup failed: ${err.message}`);
	}
}

async function recordInvoice(channel, name, user) {
	if (!turso) return;
	try {
		await turso.execute({
			sql: 'INSERT INTO invoices (discord_user_id, discord_username, channel_id, channel_name) VALUES (?, ?, ?, ?)',
			args: [user.id, user.username, channel.id, name],
		});
	} catch (err) {
		console.log(`Invoice record failed: ${err.message}`);
	}
}

// --=-== | Client | ==-=--

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// --=-== | Slash commands | ==-=--

const commands = [
	new SlashCommandBuilder()
		.setName('add-ticket-type')
		.setDescription('Set up a new ticket type by answering questions in chat'),
	new SlashCommandBuilder()
		.setName('remove-ticket-type')
		.setDescription('Remove a ticket type button')
		.addStringOption((o) => o.setName('id').setDescription('Short id to remove').setRequired(true)),
	new SlashCommandBuilder()
		.setName('list-ticket-types')
		.setDescription('List configured ticket types'),
	new SlashCommandBuilder()
		.setName('post-panel')
		.setDescription('Post the ticket panel in this channel'),
	new SlashCommandBuilder()
		.setName('post-verify')
		.setDescription('Post the verification embed in this channel'),
	new SlashCommandBuilder()
		.setName('clear-channel')
		.setDescription('Delete every message in a channel \u2014 irreversible')
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which channel to wipe').setRequired(true).addChannelTypes(ChannelType.GuildText)
		)
		.addStringOption((o) =>
			o.setName('confirm').setDescription('Type CONFIRM exactly to actually do this').setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('create-applications-panel')
		.setDescription('Build a ticket type for every #607d8b role and post the panel here'),
	new SlashCommandBuilder()
		.setName('clear-ticket-types')
		.setDescription('Remove every configured ticket type at once')
		.addStringOption((o) =>
			o.setName('confirm').setDescription('Type CONFIRM exactly to actually do this').setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('add-employee')
		.setDescription('Give a user access to a project channel')
		.addUserOption((o) => o.setName('user').setDescription('Who to add').setRequired(true))
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which project channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
		),
	new SlashCommandBuilder()
		.setName('create-invoice-panel')
		.setDescription('Post the payment ticket panel in this channel'),
	new SlashCommandBuilder()
		.setName('approve-invoice')
		.setDescription('Record this invoice channel as approved with the completed file')
		.addAttachmentOption((o) => o.setName('invoice').setDescription('The completed invoice file').setRequired(true)),
].map((c) => c.toJSON());

async function registerCommands() {
	const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
	await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// --=-== | Panel | ==-=--

function buildPanel(config) {
	const types = Object.values(config);
	if (types.length === 0) return null;

	const rows = [];
	for (let i = 0; i < types.length; i += 5) {
		const chunk = types.slice(i, i + 5);
		rows.push(
			new ActionRowBuilder().addComponents(
				chunk.map((t) =>
					new ButtonBuilder().setCustomId(`open:${t.id}`).setLabel(t.label).setStyle(ButtonStyle.Primary)
				)
			)
		);
	}

	const embed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle('Open a ticket')
		.setDescription('Pick the button that matches what you need. A private channel opens with a short form.')
		.setFooter({ text: 'Qualion Management' });

	return { embeds: [embed], components: rows };
}

// --=-== | Verification | ==-=--

function buildVerifyPanel() {
	const embed = new EmbedBuilder()
		.setColor(GREEN_COLOR)
		.setTitle('Verify to enter')
		.setDescription(
			`Read <#${RULES_CHANNEL_ID}> first.\n\nOnce you're good with it, click **Verify** below to unlock the rest of the server.`
		)
		.setFooter({ text: 'Qualion Management' });

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('verify_member').setLabel('VERIFY').setStyle(ButtonStyle.Success)
	);

	return { embeds: [embed], components: [row] };
}

// --=-== | Invoices | ==-=--

function buildInvoicePanel() {
	const embed = new EmbedBuilder()
		.setColor(GREEN_COLOR)
		.setTitle('💵 Request a payment')
		.setDescription('Create a ticket for payment. A private channel opens with your name on it, kept on record — it never gets closed or deleted.')
		.setFooter({ text: 'Qualion Management' });

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('open_invoice').setLabel('Create Payment Ticket').setStyle(ButtonStyle.Success)
	);

	return { embeds: [embed], components: [row] };
}

// --=-== | Emoji resolution | ==-=--

function resolveEmojis(guild, text) {
	const withCustom = text.replace(/:([a-zA-Z0-9_]+)(~\d+)?:/g, (match, name) => {
		const found = guild.emojis.cache.find((e) => e.name.toLowerCase() === name.toLowerCase());
		return found ? found.toString() : match;
	});
	return emoji.emojify(withCustom);
}

const COMMISSION_TERMS = `# :clipboard: Commission terms & server rules :ballot_box_with_check:
-# Taking a job here means you accept these. Nothing below is negotiable except where it says so.

### :cash: 1. No upfront by default
I don't pay upfront. If we've worked together before and it went well, we can talk about an upfront of up to 30%. First-time work is paid on delivery.

### :hourglass_flowing_sand: 2. Deadlines
A missed deadline on your side becomes a missed deadline on mine, and that lands on me. If something comes up and the date is at risk, tell me before it passes.
> Telling me in advance is never a problem. Staying quiet until the day itself is.

### :receipt: 3. Invoices are required
I'm registered as a company, so every payment needs a receipt. **No invoice, no payment.** That's bookkeeping I can't skip.
If you've never written one, use the template pinned below this message. Fill in:
- Receiver information (your name or company, address, tax ID if you have one)
- Payment type (PayPal, bank transfer, crypto, etc.)
- Amount and currency
- Date and a short description of the work

### :ghostball: 4. Abandonment
If the deadline passes and I haven't heard from you, the job is treated as abandoned and it doesn't get paid.
-# This only applies after the deadline with no contact. Being late while keeping me updated is a different thing and we sort that out normally.

### :Timer: 5. Updates every 2 days
Post a short update in your project channel at least every second day:
- What you finished
- What you're working on next
- Anything blocking you, and any questions

Two lines is enough. I'd rather have *"nothing new today, still on the UI"* than nothing at all.

### :chatting: 6. Keep it in the project channel
Every job gets its own channel. Files, questions, progress and decisions go there, not in DMs. That way nothing gets lost and anyone who needs to check the status can.

**Please react with a :tick: after reading!**
-# Last updated 13.09.2026 · questions about any of this go in <#1548425329062969346> and ping us!`;

// --=-== | Invoice channel creation | ==-=--

async function createInvoiceChannel(interaction) {
	const guild = interaction.guild;
	const category = await guild.channels.fetch(INVOICES_CATEGORY_ID);
	await guild.channels.fetch();
	const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-');

	const existing = category.children.cache.filter((c) => c.name.startsWith(`┃${slug}-`));
	const number = String(existing.size + 1).padStart(3, '0');
	const name = `┃${slug}-${number}`;

	const channel = await guild.channels.create({
		name,
		type: ChannelType.GuildText,
		parent: INVOICES_CATEGORY_ID,
		permissionOverwrites: [
			{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
			{
				id: interaction.user.id,
				allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
			},
			{
				id: LEADS_ROLE_ID,
				allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
			},
		],
	});

	const rulesMessage = await channel.send({
		content: `<@&${LEADS_ROLE_ID}> <@${interaction.user.id}>`,
		embeds: [new EmbedBuilder().setColor(BRAND_COLOR).setDescription(resolveEmojis(guild, COMMISSION_TERMS))],
	});
	await rulesMessage.pin().catch(() => {});

	const tickEmoji = guild.emojis.cache.find((e) => e.name.toLowerCase() === 'tick');
	await rulesMessage.react(tickEmoji || '✅').catch(() => {});

	const invoiceEmbed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle('Invoice template attached')
		.setDescription(
			"We're not able to fill this in on your behalf for legal reasons — please complete it yourself.\n\n" +
				'Fill in your details under **Payee**, list what was delivered under **Work** with quantity and rate, fill in **Payment** with how you want to be paid, and note the project under **Project**. Post the completed file back in this channel once it\'s ready — a Lead will review and process it from here.'
		)
		.setFooter({ text: 'Qualion Management' });

	const templatePath = path.join(__dirname, 'InvoiceTemplate.docx');

	try {
		const templateMessage = await channel.send({ embeds: [invoiceEmbed], files: [templatePath] });
		await templateMessage.pin().catch(() => {});
	} catch (err) {
		console.log(`Invoice template attachment failed (${templatePath}): ${err.message}`);
		const fallbackMessage = await channel.send({
			content: "⚠️ The template file couldn't be attached — check with a Lead.",
			embeds: [invoiceEmbed],
		});
		await fallbackMessage.pin().catch(() => {});
	}

	await recordInvoice(channel, name, interaction.user);

	return channel;
}

// --=-== | Ticket creation | ==-=--

async function createTicketChannel(interaction, type) {
	const guild = interaction.guild;
	const number = await nextNumber(type.prefix);
	const name = `┃${type.prefix}-${number}`;

	const overwrites = [
		{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
		{
			id: interaction.user.id,
			allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
		},
		{
			id: LEADS_ROLE_ID,
			allow: [
				PermissionsBitField.Flags.ViewChannel,
				PermissionsBitField.Flags.SendMessages,
				PermissionsBitField.Flags.ManageChannels,
			],
		},
	];
	if (type.roleId) {
		overwrites.push({
			id: type.roleId,
			allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
		});
	}

	const channel = await guild.channels.create({
		name,
		type: ChannelType.GuildText,
		parent: TICKETS_CATEGORY_ID,
		permissionOverwrites: overwrites,
	});

	const embed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle(`${type.label}  —  ${number}`)
		.setThumbnail(interaction.user.displayAvatarURL())
		.addFields({ name: 'Opened by', value: `<@${interaction.user.id}>` })
		.setFooter({ text: 'Qualion Management' })
		.setTimestamp();

	const buttons = [];
	if (type.roleId) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`approve:${interaction.user.id}:${type.roleId}`)
				.setLabel('Approve')
				.setStyle(ButtonStyle.Success)
		);
	}
	buttons.push(new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Danger));

	const pingParts = [`<@&${LEADS_ROLE_ID}>`];
	if (type.roleId) pingParts.push(`<@&${type.roleId}>`);

	await channel.send({
		content: pingParts.join(' '),
		embeds: [embed],
		components: [new ActionRowBuilder().addComponents(buttons)],
	});
	return channel;
}

// --=-== | Clear channel | ==-=--

async function clearChannel(channel) {
	let totalDeleted = 0;
	let fetched;
	do {
		fetched = await channel.messages.fetch({ limit: 100 });
		if (fetched.size === 0) break;

		if (fetched.size === 1) {
			await fetched.first().delete().catch(() => {});
			totalDeleted += 1;
			break;
		}

		const deleted = await channel.bulkDelete(fetched, true).catch(() => new Map());
		totalDeleted += deleted.size;

		const remaining = fetched.filter((m) => !deleted.has(m.id));
		for (const msg of remaining.values()) {
			await msg.delete().catch(() => {});
			totalDeleted += 1;
			await new Promise((r) => setTimeout(r, 1000));
		}
	} while (fetched.size >= 2);
	return totalDeleted;
}

// --=-== | Add-ticket-type wizard | ==-=--

const activeWizards = new Set();

async function askInChat(channel, userId, question) {
	await channel.send(question);
	const collected = await channel
		.awaitMessages({ filter: (m) => m.author.id === userId, max: 1, time: 120000 })
		.catch(() => null);
	if (!collected || collected.size === 0) return null;
	const msg = collected.first();
	if (msg.content.trim().toLowerCase() === 'cancel') return undefined;
	return msg;
}

async function runAddTicketWizard(interaction) {
	const userId = interaction.user.id;
	const channel = interaction.channel;

	if (activeWizards.has(userId)) {
		await interaction.reply({
			content: 'Already running a setup for you \u2014 finish that one or type cancel first.',
			ephemeral: true,
		});
		return;
	}
	activeWizards.add(userId);
	await interaction.reply({ content: 'Setup starting below \u2014 answer in this channel. Type cancel any time to stop.', ephemeral: true });

	try {
		const idMsg = await askInChat(channel, userId, '**Step 1/4** — short id for this type (lowercase, no spaces — e.g. `ui`, `pm`):');
		if (idMsg == null) return void (await channel.send(idMsg === null ? 'Timed out — setup cancelled.' : 'Setup cancelled.'));
		const id = idMsg.content.trim().toLowerCase().replace(/\s+/g, '-');

		const labelMsg = await askInChat(channel, userId, '**Step 2/4** — what should the button say? (e.g. `UI Designer`):');
		if (labelMsg == null) return void (await channel.send(labelMsg === null ? 'Timed out — setup cancelled.' : 'Setup cancelled.'));
		const label = labelMsg.content.trim();

		const prefixMsg = await askInChat(channel, userId, '**Step 3/4** — what should ticket channels be named? (e.g. `application`, `ticket`):');
		if (prefixMsg == null) return void (await channel.send(prefixMsg === null ? 'Timed out — setup cancelled.' : 'Setup cancelled.'));
		const prefix = prefixMsg.content.trim().toLowerCase().replace(/\s+/g, '-');

		const roleMsg = await askInChat(channel, userId, '**Step 4/4** — mention the role to ping and grant access, or type `skip` for none:');
		if (roleMsg == null) return void (await channel.send(roleMsg === null ? 'Timed out — setup cancelled.' : 'Setup cancelled.'));
		const mentionedRole = roleMsg.mentions.roles.first();
		const roleId = mentionedRole ? mentionedRole.id : null;

		const config = loadJson(CONFIG_FILE, {});
		config[id] = { id, label, prefix, roleId };
		saveJson(CONFIG_FILE, config);

		const summary = new EmbedBuilder()
			.setColor(BRAND_COLOR)
			.setTitle('Ticket type saved')
			.addFields(
				{ name: 'ID', value: id, inline: true },
				{ name: 'Button', value: label, inline: true },
				{ name: 'Prefix', value: prefix, inline: true },
				{ name: 'Role', value: roleId ? `<@&${roleId}>` : 'None', inline: true }
			)
			.setFooter({ text: 'Run /post-panel to show it on the panel' });
		await channel.send({ embeds: [summary] });
	} finally {
		activeWizards.delete(userId);
	}
}

// --=-== | Events | ==-=--

client.once(Events.ClientReady, async () => {
	await registerCommands();
	await loadCounterFromDiscord();
	await ensureInvoiceTable();
	console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isChatInputCommand() && !interaction.member.roles.cache.has(LEADS_ROLE_ID)) {
			await interaction.reply({ content: 'Only Leads can use bot commands.', ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'add-ticket-type') {
			await runAddTicketWizard(interaction);
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'remove-ticket-type') {
			const config = loadJson(CONFIG_FILE, {});
			const id = interaction.options.getString('id');
			delete config[id];
			saveJson(CONFIG_FILE, config);
			await interaction.reply({ content: `Ticket type "${id}" removed.`, ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'list-ticket-types') {
			const config = loadJson(CONFIG_FILE, {});
			const types = Object.values(config);
			const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Ticket types');
			if (types.length === 0) {
				embed.setDescription('None configured yet.');
			} else {
				for (const t of types) {
					embed.addFields({
						name: `${t.label}  •  ${t.id}`,
						value: `Prefix: \`${t.prefix}\`\nRole: ${t.roleId ? `<@&${t.roleId}>` : 'None'}`,
					});
				}
			}
			await interaction.reply({ embeds: [embed], ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'post-panel') {
			const config = loadJson(CONFIG_FILE, {});
			const panel = buildPanel(config);
			if (!panel) {
				await interaction.reply({
					content: 'No ticket types configured yet — add one with /add-ticket-type first.',
					ephemeral: true,
				});
				return;
			}
			await interaction.channel.send(panel);
			await interaction.reply({ content: 'Panel posted.', ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'clear-channel') {
			const confirm = interaction.options.getString('confirm');
			if (confirm !== 'CONFIRM') {
				await interaction.reply({
					content: 'Not run — type CONFIRM exactly in the confirm field to actually wipe the channel. This cannot be undone.',
					ephemeral: true,
				});
				return;
			}
			const targetOption = interaction.options.getChannel('channel');
			const channel = await interaction.guild.channels.fetch(targetOption.id);
			await interaction.deferReply({ ephemeral: true });
			const deletedCount = await clearChannel(channel);
			await interaction.editReply(`Deleted ${deletedCount} message(s) from ${channel}.`);
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'create-applications-panel') {
			await interaction.guild.roles.fetch();
			const matchingRoles = interaction.guild.roles.cache.filter((r) => r.hexColor === '#607d8b');
			if (matchingRoles.size === 0) {
				await interaction.reply({ content: 'No roles with color #607d8b found.', ephemeral: true });
				return;
			}

			const config = loadJson(CONFIG_FILE, {});
			for (const role of matchingRoles.values()) {
				const id = role.name.trim().toLowerCase().replace(/\s+/g, '-');
				config[id] = { id, label: role.name, prefix: 'application', roleId: role.id };
			}
			saveJson(CONFIG_FILE, config);

			await interaction.channel.send(buildPanel(config));
			await interaction.reply({
				content: `Added/updated ${matchingRoles.size} ticket type(s) from role color and posted the panel.`,
				ephemeral: true,
			});
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'clear-ticket-types') {
			const confirm = interaction.options.getString('confirm');
			if (confirm !== 'CONFIRM') {
				await interaction.reply({
					content: 'Not run — type CONFIRM exactly in the confirm field to actually clear every ticket type.',
					ephemeral: true,
				});
				return;
			}
			const config = loadJson(CONFIG_FILE, {});
			const count = Object.keys(config).length;
			saveJson(CONFIG_FILE, {});
			await interaction.reply({
				content: `Removed all ${count} ticket type(s). Any already-posted panel keeps its old buttons until it's deleted and reposted.`,
				ephemeral: true,
			});
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'post-verify') {
			await interaction.channel.send(buildVerifyPanel());
			await interaction.reply({ content: 'Verification panel posted.', ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'add-employee') {
			const user = interaction.options.getUser('user');
			const targetOption = interaction.options.getChannel('channel');
			const channel = await interaction.guild.channels.fetch(targetOption.id);
			await channel.permissionOverwrites.edit(user.id, {
				ViewChannel: true,
				SendMessages: true,
				ReadMessageHistory: true,
			});
			await channel.send(`<@${user.id}> has been added to this project.`);
			await interaction.reply({ content: `Added <@${user.id}> to ${channel}.`, ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'create-invoice-panel') {
			await interaction.channel.send(buildInvoicePanel());
			await interaction.reply({ content: 'Invoice panel posted.', ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'approve-invoice') {
			const channel = interaction.channel;
			if (channel.parentId !== INVOICES_CATEGORY_ID) {
				await interaction.reply({ content: 'This only works inside an invoice channel.', ephemeral: true });
				return;
			}

			const attachment = interaction.options.getAttachment('invoice');
			const raw = channel.name.replace(/^┃/, '');
			const match = raw.match(/^(.+)-(\d{3})$/);
			const displayName = match ? `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} - ${match[2]}` : raw;

			if (turso) {
				try {
					const result = await turso.execute({
						sql: "UPDATE invoices SET status = 'approved', approved_invoice_url = ?, approved_at = datetime('now') WHERE channel_id = ?",
						args: [attachment.url, channel.id],
					});
					if (result.rowsAffected === 0) {
						await turso.execute({
							sql: "INSERT INTO invoices (discord_user_id, discord_username, channel_id, channel_name, status, approved_invoice_url, approved_at) VALUES (?, ?, ?, ?, 'approved', ?, datetime('now'))",
							args: [interaction.user.id, interaction.user.username, channel.id, displayName, attachment.url],
						});
					}
				} catch (err) {
					console.log(`Invoice approval DB update failed: ${err.message}`);
				}
			}

			await channel.send({
				embeds: [
					new EmbedBuilder()
						.setColor(GREEN_COLOR)
						.setTitle('✅ Invoice approved')
						.setDescription(`Recorded as **${displayName}**.\n\n[View the submitted invoice](${attachment.url})`),
				],
			});
			await interaction.reply({ content: `Marked ${displayName} as approved.`, ephemeral: true });
			return;
		}

		if (interaction.isButton() && interaction.customId === 'open_invoice') {
			await interaction.reply({ content: 'Invoice channel created, check below.', ephemeral: true });
			await createInvoiceChannel(interaction);
			return;
		}

		if (interaction.isButton() && interaction.customId === 'verify_member') {
			if (interaction.member.roles.cache.has(MEMBER_ROLE_ID)) {
				await interaction.reply({ content: "You're already verified.", ephemeral: true });
				return;
			}
			await interaction.member.roles.add(MEMBER_ROLE_ID).catch(() => {});
			await interaction.reply({ content: "You're verified — welcome in.", ephemeral: true });
			return;
		}

		if (interaction.isButton() && interaction.customId.startsWith('open:')) {
			const id = interaction.customId.split(':')[1];
			const config = loadJson(CONFIG_FILE, {});
			const type = config[id];
			if (!type) {
				await interaction.reply({ content: 'That ticket type no longer exists.', ephemeral: true });
				return;
			}
			await interaction.reply({ content: 'Ticket created, check the new channel.', ephemeral: true });
			await createTicketChannel(interaction, type);
			return;
		}

		if (interaction.isButton() && interaction.customId.startsWith('approve:')) {
			const isLead = interaction.member.roles.cache.has(LEADS_ROLE_ID);
			if (!isLead) {
				await interaction.reply({ content: 'Only Leads can approve this.', ephemeral: true });
				return;
			}
			const [, applicantId, roleId] = interaction.customId.split(':');
			const member = await interaction.guild.members.fetch(applicantId).catch(() => null);
			if (!member) {
				await interaction.reply({ content: "Couldn't find that member anymore.", ephemeral: true });
				return;
			}
			await member.roles.add(roleId).catch(() => {});
			await interaction.reply(`<@${applicantId}> approved — <@&${roleId}> role added.`);
			return;
		}

		if (interaction.isButton() && interaction.customId === 'close_ticket') {
			const isLead = interaction.member.roles.cache.has(LEADS_ROLE_ID);
			if (!isLead) {
				await interaction.reply({ content: 'Only Leads can close this.', ephemeral: true });
				return;
			}
			await interaction.reply('Closing in 5 seconds.');
			setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
			return;
		}
	} catch (err) {
		console.error(err);
		if (interaction.isRepliable() && !interaction.replied) {
			await interaction.reply({ content: 'Something went wrong, try again.', ephemeral: true }).catch(() => {});
		}
	}
});

// --=-== | Keep-alive server (Render) | ==-=--

http
	.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('OK');
	})
	.listen(process.env.PORT || 3000);

// --=-== | Self-ping (Render) | ==-=--

if (process.env.RENDER_URL) {
	setInterval(() => {
		https
			.get(process.env.RENDER_URL, (res) => {
				console.log(`Self-ping: ${res.statusCode}`);
			})
			.on('error', (err) => {
				console.log(`Self-ping failed: ${err.message}`);
			});
	}, 4 * 60 * 1000);
}

client.login(DISCORD_TOKEN);
