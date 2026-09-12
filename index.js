require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
	Client,
	GatewayIntentBits,
	Events,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
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
} = process.env;

const BRAND_COLOR = 0x5865f2;

// --=-== | Storage (tickets, tickets counter, sticky messages) | ==-=--

const CONFIG_FILE = path.join(__dirname, 'config.json');
const COUNTER_FILE = process.env.COUNTER_PATH || path.join(__dirname, 'counter.json');
const STICKY_FILE = path.join(__dirname, 'sticky.json');

function loadJson(file, fallback) {
	if (!fs.existsSync(file)) return fallback;
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJson(file, data) {
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function nextNumber(prefix) {
	const counters = loadJson(COUNTER_FILE, {});
	const next = (counters[prefix] || 0) + 1;
	counters[prefix] = next;
	saveJson(COUNTER_FILE, counters);
	return String(next).padStart(3, '0');
}

// --=-== | Client | ==-=--

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// --=-== | Slash commands | ==-=--

const commands = [
	new SlashCommandBuilder()
		.setName('add-ticket-type')
		.setDescription('Add or update a ticket type button')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
		.addStringOption((o) => o.setName('id').setDescription('Short id, e.g. ui').setRequired(true))
		.addStringOption((o) => o.setName('label').setDescription('Button label').setRequired(true))
		.addStringOption((o) => o.setName('prefix').setDescription('Channel prefix, e.g. application or ticket').setRequired(true))
		.addStringOption((o) => o.setName('field1').setDescription('First field label').setRequired(true))
		.addRoleOption((o) => o.setName('role').setDescription('Role to ping, grant access, and approve into'))
		.addStringOption((o) => o.setName('field2').setDescription('Second field label'))
		.addStringOption((o) => o.setName('field3').setDescription('Third field label'))
		.addStringOption((o) => o.setName('field4').setDescription('Fourth field label'))
		.addStringOption((o) => o.setName('field5').setDescription('Fifth field label')),
	new SlashCommandBuilder()
		.setName('remove-ticket-type')
		.setDescription('Remove a ticket type button')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
		.addStringOption((o) => o.setName('id').setDescription('Short id to remove').setRequired(true)),
	new SlashCommandBuilder()
		.setName('list-ticket-types')
		.setDescription('List configured ticket types')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
	new SlashCommandBuilder()
		.setName('post-panel')
		.setDescription('Post the ticket panel in this channel')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
	new SlashCommandBuilder()
		.setName('sticky-set')
		.setDescription('Keep a message pinned to the bottom of a channel')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
		)
		.addStringOption((o) => o.setName('message').setDescription('The sticky text').setRequired(true)),
	new SlashCommandBuilder()
		.setName('sticky-remove')
		.setDescription('Remove the sticky from a channel')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
		.addChannelOption((o) =>
			o.setName('channel').setDescription('Which channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
		),
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

// --=-== | Modal | ==-=--

function buildModal(type) {
	const modal = new ModalBuilder().setCustomId(`submit:${type.id}`).setTitle(type.label.slice(0, 45));
	const rows = type.fields.map((field, i) =>
		new ActionRowBuilder().addComponents(
			new TextInputBuilder()
				.setCustomId(`field${i}`)
				.setLabel(field.slice(0, 45))
				.setStyle(TextInputStyle.Short)
				.setRequired(true)
		)
	);
	modal.addComponents(...rows);
	return modal;
}

// --=-== | Ticket creation | ==-=--

async function createTicketChannel(interaction, type, answers) {
	const guild = interaction.guild;
	const number = nextNumber(type.prefix);
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
		.addFields(
			{ name: 'Opened by', value: `<@${interaction.user.id}>` },
			...type.fields.map((field, i) => ({ name: field, value: answers[i] || '—', inline: true }))
		)
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

// --=-== | Sticky messages | ==-=--

async function handleStickySet(interaction) {
	const targetOption = interaction.options.getChannel('channel');
	const channel = await interaction.guild.channels.fetch(targetOption.id);
	const message = interaction.options.getString('message');
	const sticky = loadJson(STICKY_FILE, {});

	const existing = sticky[channel.id];
	if (existing?.lastMessageId) {
		await channel.messages.delete(existing.lastMessageId).catch(() => {});
	}
	const sent = await channel.send(message);
	sticky[channel.id] = { message, lastMessageId: sent.id };
	saveJson(STICKY_FILE, sticky);
	await interaction.reply({ content: `Sticky message set for ${channel}.`, ephemeral: true });
}

async function handleStickyRemove(interaction) {
	const targetOption = interaction.options.getChannel('channel');
	const channel = await interaction.guild.channels.fetch(targetOption.id);
	const sticky = loadJson(STICKY_FILE, {});
	const entry = sticky[channel.id];
	if (entry?.lastMessageId) {
		await channel.messages.delete(entry.lastMessageId).catch(() => {});
	}
	delete sticky[channel.id];
	saveJson(STICKY_FILE, sticky);
	await interaction.reply({ content: `Sticky removed from ${channel}.`, ephemeral: true });
}

// --=-== | Events | ==-=--

client.once(Events.ClientReady, async () => {
	await registerCommands();
	console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
	if (message.author.id === client.user.id) return;
	const sticky = loadJson(STICKY_FILE, {});
	const entry = sticky[message.channel.id];
	if (!entry) return;
	if (entry.lastMessageId) {
		await message.channel.messages.delete(entry.lastMessageId).catch(() => {});
	}
	const sent = await message.channel.send(entry.message);
	entry.lastMessageId = sent.id;
	saveJson(STICKY_FILE, sticky);
});

client.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isChatInputCommand() && interaction.commandName === 'add-ticket-type') {
			const config = loadJson(CONFIG_FILE, {});
			const id = interaction.options.getString('id');
			const fields = [1, 2, 3, 4, 5]
				.map((n) => interaction.options.getString(`field${n}`))
				.filter(Boolean);
			config[id] = {
				id,
				label: interaction.options.getString('label'),
				prefix: interaction.options.getString('prefix'),
				roleId: interaction.options.getRole('role')?.id || null,
				fields,
			};
			saveJson(CONFIG_FILE, config);
			await interaction.reply({
				content: `Ticket type "${id}" saved with ${fields.length} field(s). Resets to config.json on the next redeploy on hosts with no persistent disk.`,
				ephemeral: true,
			});
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
						value: `Prefix: \`${t.prefix}\`\nRole: ${t.roleId ? `<@&${t.roleId}>` : 'None'}\nFields: ${t.fields.join(', ')}`,
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

		if (interaction.isChatInputCommand() && interaction.commandName === 'sticky-set') {
			await handleStickySet(interaction);
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'sticky-remove') {
			await handleStickyRemove(interaction);
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
			await interaction.showModal(buildModal(type));
			return;
		}

		if (interaction.isModalSubmit() && interaction.customId.startsWith('submit:')) {
			const id = interaction.customId.split(':')[1];
			const config = loadJson(CONFIG_FILE, {});
			const type = config[id];
			const answers = type.fields.map((_, i) => interaction.fields.getTextInputValue(`field${i}`));
			await interaction.reply({ content: 'Ticket created, check the new channel.', ephemeral: true });
			await createTicketChannel(interaction, type, answers);
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

client.login(DISCORD_TOKEN);
