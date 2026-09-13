# Setup

## Application
Discord Developer Portal → new application → add a bot → copy the bot token. Copy the Client ID from General Information too.

## Invite
OAuth2 → URL Generator → check `bot` and `applications.commands`. Bot permissions: either Administrator, or View Channels, Manage Channels, Send Messages, Embed Links individually.

## IDs
Developer Mode on (User Settings → Advanced). Right-click the server for `GUILD_ID`, the Tickets category for `TICKETS_CATEGORY_ID`, the Leads role for `LEADS_ROLE_ID`.

## Environment
`DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `TICKETS_CATEGORY_ID`, `LEADS_ROLE_ID`, `MEMBER_ROLE_ID`, `RULES_CHANNEL_ID` — seven values, same as `.env.example`.

## Run
```
npm install
npm start
```
Then `/post-panel` in whichever channel should hold the ticket panel, and `/post-verify` in whichever channel should hold verification.

## Verification
`/post-verify` posts a green-accented embed pointing at `RULES_CHANNEL_ID`, with a **Verify** button. Clicking it grants `MEMBER_ROLE_ID` — clicking again once already verified just replies saying so, no duplicate role add. Post it once in whatever the entry channel is; it works from that single message from then on, nothing to re-run unless the message gets deleted.

## Ticket types
Buttons live in `config.json`, not code. Pre-filled with four disciplines (UI, Scripting, VFX, Building) — clicking a button now creates the ticket channel immediately, no form first.

`/add-ticket-type` takes no options — it asks three short questions in the channel instead: the id, the button label, the channel prefix, then a role to mention (or `skip`). Type `cancel` at any point to stop, or just stop answering — it gives up after two minutes of silence. `/remove-ticket-type id:<short-id>` deletes one. `/list-ticket-types` shows everything currently configured, as an embed. Re-run `/post-panel` after adding or removing a type — an existing posted panel doesn't update itself.

This still needs Message Content Intent turned on in the Developer Portal (Bot → Privileged Gateway Intents) for the setup wizard to read your answers — same requirement as before, not something new from this change.

## Ticket channels
Each open ticket gets a Close button, and an Approve button too if the type has a role attached. Approve grants that role to whoever opened the ticket and posts a confirmation — it doesn't close the channel, that's still a separate step. Close is Leads-only and deletes the channel after five seconds.

Channels are named `┃<prefix>-001` and so on, numbered per prefix rather than per type — every `application` ticket shares one counter regardless of discipline. Drop the `┃` from `createTicketChannel` in the code if it doesn't render the way you want.

## Numbering and config persistence
`counter.json` and `config.json` both live next to the script. On a host with no persistent disk (Render's free tier, for one), both reset to what's shipped in the repo on every redeploy — live changes made through commands don't survive a redeploy unless the host has a volume, or the change also gets committed.

## Clear channel
`/clear-channel channel:<pick> confirm:CONFIRM` deletes every message in the picked channel. The `confirm` field has to be exactly `CONFIRM`, capitals included — anything else, including leaving it blank, just explains what the command does without touching anything. There's no undo once it runs.

Messages under 14 days old go in fast batches. Anything older has to be removed one at a time — a Discord API limit, not something the code can speed up — so an old, message-heavy channel can take a while. The command replies once it's actually finished, with a count of how many were removed.

## Hosting
A host needs to stay running for this to work continuously. Set `RENDER_URL` to the service's own `.onrender.com` address and the bot pings itself every 4 minutes from the outside in, which is what actually resets Render's idle timer — an external monitor like UptimeRobot did the same job before this existed, and isn't needed anymore once `RENDER_URL` is set. Leaving both running isn't harmful, just redundant.
