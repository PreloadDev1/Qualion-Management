# Setup

## Application
Go to the Discord Developer Portal, create a new application, add a bot to it, copy the bot token. Copy the application's Client ID from the General Information page too.

## Invite
Under OAuth2 → URL Generator, check `bot` and `applications.commands`. For bot permissions, either check Administrator or pick View Channels, Manage Channels, Send Messages, Embed Links individually.

## IDs
Turn on Developer Mode in Discord (User Settings → Advanced). Right-click the server to copy `GUILD_ID`, right-click the Tickets category for `TICKETS_CATEGORY_ID`, right-click the Leads role for `LEADS_ROLE_ID`.

## Environment
Five values now: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `TICKETS_CATEGORY_ID`, `LEADS_ROLE_ID`. Copy `.env.example` to `.env` and fill them in, or paste them into your host's environment variables panel.

## Run
```
npm install
npm start
```
Then type `/post-panel` in whichever channel should hold the panel.

## Ticket types
Buttons and their fields are no longer hardcoded — they live in `config.json`, pre-filled with a general ticket and the four discipline applications (UI, Scripting, VFX, Building), each asking Portfolio, Pricing, and Availability.

Add or change one without touching code:
```
/add-ticket-type id:<short-id> label:<button text> prefix:<channel-prefix> field1:<question> role:<optional role> field2:<optional> field3:<optional> field4:<optional> field5:<optional>
```
Up to 5 fields per type (Discord's modal limit). `role` is optional — leave it off for a type that should only ping Leads, like the general ticket.

`/remove-ticket-type id:<short-id>` deletes one. `/list-ticket-types` shows everything currently configured. Re-run `/post-panel` after changing types so the buttons on the message match.

Channels come out named `┃<prefix>-001`, `┃<prefix>-002`, and so on — numbering is per prefix, so `ticket` and `application` count separately. Drop the `┃` from the code in `createTicketChannel` if it doesn't render the way you want on your client.

## Numbering and config persistence
`counter.json` and `config.json` both live next to the script. On a host with no persistent disk (Render's free tier, for one), both reset to what's shipped in the repo on every redeploy — a `/add-ticket-type` change or the running ticket count won't survive a redeploy unless the host has a volume, or the change is also committed to the repo.

## Hosting
Running this from a laptop means tickets stop working the moment it closes. A small always-on host keeps it running — Render's free tier works with a keep-alive ping (see the HTTP server at the bottom of `index.js`, paired with an external uptime monitor).
