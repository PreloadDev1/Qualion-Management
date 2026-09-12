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

// --=-== | Config storage (ticket types) | ==-=--

const CONFIG_FILE = path.join(__dirname, 'config.json');
const COUNTER_FILE = process.env.COUNTER_PATH || path.join(__dirname, 'counter.json');

function loadConfig() {
	if (!fs.existsSync(CONFIG_FILE)) return {};
	return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadCounters() {
	if (!fs.existsSync(COUNTER_FILE)) return {};
	return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
}

function nextNumber(prefix) {
	const counters = loadCounters();
	const next = (counters[prefix] || 0) + 1;
	counters[prefix] = next;
	fs.writeFileSync(COUNTER_FILE, JSON.stringify(counters));
	return String(next).padStart(3, '0');
}

// --=-== | Client | ==-=--

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
		.addRoleOption((o) => o.setName('role').setDescription('Role to ping and grant access, optional'))
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
		.setTitle('Open a ticket')
		.setDescription("Pick the button that matches what you need. A private channel opens with a short form.");

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
		.setTitle(`${type.label} — ${number}`)
		.addFields(
			{ name: 'Opened by', value: `<@${interaction.user.id}>` },
			...type.fields.map((field, i) => ({ name: field, value: answers[i] || '—' }))
		);

	const closeRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Danger)
	);

	const pingParts = [`<@&${LEADS_ROLE_ID}>`];
	if (type.roleId) pingParts.push(`<@&${type.roleId}>`);

	await channel.send({ content: pingParts.join(' '), embeds: [embed], components: [closeRow] });
	return channel;
}

// --=-== | Events | ==-=--

client.once(Events.ClientReady, async () => {
	await registerCommands();
	console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isChatInputCommand() && interaction.commandName === 'add-ticket-type') {
			const config = loadConfig();
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
			saveConfig(config);
			await interaction.reply({
				content: `Ticket type "${id}" saved with ${fields.length} field(s). Note: on a free host with no persistent disk, this resets to whatever's in config.json on the next redeploy.`,
				ephemeral: true,
			});
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'remove-ticket-type') {
			const config = loadConfig();
			const id = interaction.options.getString('id');
			delete config[id];
			saveConfig(config);
			await interaction.reply({ content: `Ticket type "${id}" removed.`, ephemeral: true });
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'list-ticket-types') {
			const config = loadConfig();
			const lines = Object.values(config).map(
				(t) => `${t.id} — ${t.label} (${t.prefix}-XXX, fields: ${t.fields.join(', ')})`
			);
			await interaction.reply({
				content: lines.length ? lines.join('\n') : 'No ticket types configured yet.',
				ephemeral: true,
			});
			return;
		}

		if (interaction.isChatInputCommand() && interaction.commandName === 'post-panel') {
			const config = loadConfig();
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

		if (interaction.isButton() && interaction.customId.startsWith('open:')) {
			const id = interaction.customId.split(':')[1];
			const config = loadConfig();
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
			const config = loadConfig();
			const type = config[id];
			const answers = type.fields.map((_, i) => interaction.fields.getTextInputValue(`field${i}`));
			await interaction.reply({ content: 'Ticket created, check the new channel.', ephemeral: true });
			await createTicketChannel(interaction, type, answers);
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
