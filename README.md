# Setup

## Application
Go to the Discord Developer Portal, create a new application, add a bot to it, copy the bot token. Copy the application's Client ID from the General Information page too.

## Invite
Under OAuth2 → URL Generator, check `bot` and `applications.commands`. For bot permissions check: View Channels, Manage Channels, Send Messages, Embed Links. Open the generated URL and add the bot to the server.

## IDs
Turn on Developer Mode in Discord (User Settings → Advanced). Right-click the server to copy `GUILD_ID`, right-click the Tickets category for `TICKETS_CATEGORY_ID`, right-click each role in Server Settings → Roles for `LEADS_ROLE_ID` and the four discipline role IDs.

## Environment
Copy `.env.example` to `.env` and fill in every value from the two steps above.

## Run
```
npm install
npm start
```
Then type `/post-panel` in `#applications`. That posts the four buttons; the panel only needs posting once, it stays in the channel.

## Numbering
`counter.json` holds the running application number. It's created automatically on the first submission and increments from there. Back it up if the bot ever moves to a new machine — a fresh copy resets the count to 1.

## Hosting
Running this from a laptop means tickets stop working the moment it closes. A small always-on host (a low-cost VPS, or a platform like Railway or Fly.io) keeps it online; `pm2` or a systemd service restarts it if it crashes.

## Not included
No auto role grant on accept — Leads still assign the project role by hand once someone's hired. No archive on close, the channel just deletes after five seconds; swap that for a transcript-and-archive step if you want a record after the fact.
