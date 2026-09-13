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
Buttons and fields live in `config.json`, not code. Pre-filled with a general ticket and four disciplines (UI, Scripting, VFX, Building), each asking Portfolio, Pricing, Availability.

```
/add-ticket-type id:<short-id> label:<button text> prefix:<channel-prefix> field1:<question> role:<optional role> field2:<optional> field3:<optional> field4:<optional> field5:<optional>
```
Up to 5 fields (Discord's modal limit). Leave `role` off for a type that should only reach Leads. `/remove-ticket-type id:<short-id>` deletes one. `/list-ticket-types` shows everything currently configured, as an embed. Re-run `/post-panel` after adding or removing a type — an existing posted panel doesn't update itself.

## Ticket channels
Each open ticket gets a Close button, and an Approve button too if the type has a role attached. Approve grants that role to whoever opened the ticket and posts a confirmation — it doesn't close the channel, that's still a separate step. Close is Leads-only and deletes the channel after five seconds.

Channels are named `┃<prefix>-001` and so on, numbered per prefix rather than per type — every `application` ticket shares one counter regardless of discipline. Drop the `┃` from `createTicketChannel` in the code if it doesn't render the way you want.

## Sticky messages
`/sticky-set channel:<pick any text channel> message:<text>` keeps that message pinned to the bottom of the picked channel. On any new message there, the bot sends the sticky again immediately, then cleans up the old copy right after — no gap where nothing's showing. `/sticky-remove channel:<pick>` clears it.

Sticky data now survives restarts and redeploys, not just this session. Set `STORAGE_CHANNEL_ID` to a private channel the bot can see (create one, keep it hidden from everyone else, doesn't need to be visible to Leads either) and every sticky change gets written there too, as a pinned message the bot reads back on startup. Without `STORAGE_CHANNEL_ID` set, sticky still works, it just goes back to resetting on every redeploy like `config.json` and `counter.json` still do — this same trick could cover those two as well if that becomes worth fixing later, just not done yet since it wasn't what was asked.

Forums aren't supported here on purpose — they already have their own pinned-posts feature built into Discord, so a bot-managed sticky would just duplicate that.

The bot needs to actually have access to whatever channel gets picked, and to the storage channel — if it can't view or send there, the relevant command fails even though picking it from the dropdown works fine.

## Numbering and config persistence
`counter.json`, `config.json`, and `sticky.json` all live next to the script. On a host with no persistent disk (Render's free tier, for one), all three reset to what's shipped in the repo on every redeploy — live changes made through commands don't survive a redeploy unless the host has a volume, or the change also gets committed.

## Clear channel
`/clear-channel channel:<pick> confirm:CONFIRM` deletes every message in the picked channel. The `confirm` field has to be exactly `CONFIRM`, capitals included — anything else, including leaving it blank, just explains what the command does without touching anything. There's no undo once it runs.

Messages under 14 days old go in fast batches. Anything older has to be removed one at a time — a Discord API limit, not something the code can speed up — so an old, message-heavy channel can take a while. The command replies once it's actually finished, with a count of how many were removed.

## Hosting
A host needs to stay running for this to work continuously. Set `RENDER_URL` to the service's own `.onrender.com` address and the bot pings itself every 4 minutes from the outside in, which is what actually resets Render's idle timer — an external monitor like UptimeRobot did the same job before this existed, and isn't needed anymore once `RENDER_URL` is set. Leaving both running isn't harmful, just redundant.
