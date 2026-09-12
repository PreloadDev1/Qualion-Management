# Setup

## Application
Discord Developer Portal → new application → add a bot → copy the bot token. Copy the Client ID from General Information too.

## Invite
OAuth2 → URL Generator → check `bot` and `applications.commands`. Bot permissions: either Administrator, or View Channels, Manage Channels, Send Messages, Embed Links individually.

## IDs
Developer Mode on (User Settings → Advanced). Right-click the server for `GUILD_ID`, the Tickets category for `TICKETS_CATEGORY_ID`, the Leads role for `LEADS_ROLE_ID`.

## Environment
`DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `TICKETS_CATEGORY_ID`, `LEADS_ROLE_ID` — five values, same as `.env.example`.

## Run
```
npm install
npm start
```
Then `/post-panel` in whichever channel should hold it.

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
`/sticky-set message:<text>` in a normal text channel keeps that message pinned to the bottom — any new message in the channel makes the bot delete its old sticky and repost it underneath. Run the same command from inside any post in a forum channel instead, and it switches modes: the message gets posted automatically into every new post created in that forum from then on, rather than following a single message stream. `/sticky-remove` clears whichever kind is set on the current channel or forum.

## Numbering and config persistence
`counter.json`, `config.json`, and `sticky.json` all live next to the script. On a host with no persistent disk (Render's free tier, for one), all three reset to what's shipped in the repo on every redeploy — live changes made through commands don't survive a redeploy unless the host has a volume, or the change also gets committed.

## Hosting
A host needs to stay running for this to work continuously. Render's free tier works with a keep-alive ping — see the HTTP server at the bottom of `index.js`, paired with an external uptime monitor hitting it every few minutes.
