require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
	UI_ROLE_ID,
	SCRIPTING_ROLE_ID,
	VFX_ROLE_ID,
	BUILDING_ROLE_ID,
} = process.env;

// --=-== | Discipline config | ==-=--

const DISCIPLINES = {
	UI: { label: 'UI Designer', roleId: UI_ROLE_ID },
	Scripting: { label: 'Scripter', roleId: SCRIPTING_ROLE_ID },
	VFX: { label: 'VFX Artist', roleId: VFX_ROLE_ID },
	Building: { label: 'Builder', roleId: BUILDING_ROLE_ID },
};

// --=-== | Ticket counter | ==-=--

const COUNTER_FILE = path.join(__dirname, 'counter.json');

function nextTicketNumber() {
	let count = 0;
	if (fs.existsSync(COUNTER_FILE)) {
		count = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')).count;
	}
	count += 1;
	fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count }));
	return String(count).padStart(3, '0');
}

// --=-== | Client | ==-=--

const client = new Client({
	intents: [GatewayIntentBits.Guilds],
});

// --=-== | Slash command registration | ==-=--

const commands = [
	new SlashCommandBuilder()
		.setName('post-panel')
		.setDescription('Post the application panel in this channel')
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
].map((c) => c.toJSON());

async function registerCommands() {
	const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
	await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// --=-== | Panel | ==-=--

function buildPanel() {
	const row = new ActionRowBuilder().addComponents(
		Object.keys(DISCIPLINES).map((key) =>
			new ButtonBuilder()
				.setCustomId(`apply:${key}`)
				.setLabel(DISCIPLINES[key].label)
				.setStyle(ButtonStyle.Primary)
		)
	);
	const embed = new EmbedBuilder()
		.setTitle('Apply')
		.setDescription("Pick the role you're applying for. A private ticket opens with a short form.");
	return { embeds: [embed], components: [row] };
}

// --=-== | Modal | ==-=--

function buildModal(discipline) {
	const modal = new ModalBuilder()
		.setCustomId(`application_modal:${discipline}`)
		.setTitle(`${DISCIPLINES[discipline].label} application`);

	const portfolio = new TextInputBuilder()
		.setCustomId('portfolio')
		.setLabel('Portfolio link')
		.setStyle(TextInputStyle.Short)
		.setRequired(true);

	const availability = new TextInputBuilder()
		.setCustomId('availability')
		.setLabel('Availability (hrs/week)')
		.setStyle(TextInputStyle.Short)
		.setRequired(true);

	const rate = new TextInputBuilder()
		.setCustomId('rate')
		.setLabel('Rate')
		.setStyle(TextInputStyle.Short)
		.setRequired(true);

	modal.addComponents(
		new ActionRowBuilder().addComponents(portfolio),
		new ActionRowBuilder().addComponents(availability),
		new ActionRowBuilder().addComponents(rate)
	);
	return modal;
}

// --=-== | Ticket creation | ==-=--

async function createTicketChannel(interaction, discipline, answers) {
	const guild = interaction.guild;
	const number = nextTicketNumber();
	const disciplineRoleId = DISCIPLINES[discipline].roleId;

	const channel = await guild.channels.create({
		name: `application-${number}`,
		type: ChannelType.GuildText,
		parent: TICKETS_CATEGORY_ID,
		permissionOverwrites: [
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
			{
				id: disciplineRoleId,
				allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
			},
		],
	});

	const embed = new EmbedBuilder()
		.setTitle(`Application ${number} — ${DISCIPLINES[discipline].label}`)
		.addFields(
			{ name: 'Applicant', value: `<@${interaction.user.id}>` },
			{ name: 'Portfolio', value: answers.portfolio },
			{ name: 'Availability', value: answers.availability },
			{ name: 'Rate', value: answers.rate }
		);

	const closeRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Danger)
	);

	await channel.send({
		content: `<@&${LEADS_ROLE_ID}> <@&${disciplineRoleId}>`,
		embeds: [embed],
		components: [closeRow],
	});

	return channel;
}

// --=-== | Events | ==-=--

client.once(Events.ClientReady, async () => {
	await registerCommands();
	console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isChatInputCommand() && interaction.commandName === 'post-panel') {
			await interaction.channel.send(buildPanel());
			await interaction.reply({ content: 'Panel posted.', ephemeral: true });
			return;
		}

		if (interaction.isButton() && interaction.customId.startsWith('apply:')) {
			const discipline = interaction.customId.split(':')[1];
			await interaction.showModal(buildModal(discipline));
			return;
		}

		if (interaction.isModalSubmit() && interaction.customId.startsWith('application_modal:')) {
			const discipline = interaction.customId.split(':')[1];
			const answers = {
				portfolio: interaction.fields.getTextInputValue('portfolio'),
				availability: interaction.fields.getTextInputValue('availability'),
				rate: interaction.fields.getTextInputValue('rate'),
			};
			await interaction.reply({ content: 'Application received, check your new ticket channel.', ephemeral: true });
			await createTicketChannel(interaction, discipline, answers);
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

client.login(DISCORD_TOKEN);
