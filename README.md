# Setup

## Application
Discord Developer Portal → new application → add a bot → copy the bot token. Copy the Client ID from General Information too.

## Invite
OAuth2 → URL Generator → check `bot` and `applications.commands`. Bot permissions: either Administrator, or View Channels, Manage Channels, Send Messages, Embed Links individually.

## IDs
Developer Mode on (User Settings → Advanced). Right-click the server for `GUILD_ID`, the Tickets category for `TICKETS_CATEGORY_ID`, the Leads role for `LEADS_ROLE_ID`, a dedicated Invoices category for `INVOICES_CATEGORY_ID`, and a private channel only the bot needs to see for `STORAGE_CHANNEL_ID`.

## Environment
`DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `TICKETS_CATEGORY_ID`, `LEADS_ROLE_ID`, `MEMBER_ROLE_ID`, `RULES_CHANNEL_ID`, `STORAGE_CHANNEL_ID`, `INVOICES_CATEGORY_ID`, `PROJECTS_CATEGORY_ID` — same as `.env.example`. `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` too, if invoice tracking is wanted; leave both unset and that part just stays off. `RENDER_URL` if hosting on Render.

## Run
```
npm install
npm start
```
Then `/post-panel` (or `/create-applications-panel`) for applications, `/post-verify` for verification, `/create-invoice-panel` for payments — each in whichever channel should hold it.

## Permissions
Every slash command checks for the actual `LEADS_ROLE_ID` role now, not Discord's Manage Server permission bit — someone could hold Manage Server without being a Lead, or be a Lead without holding it, and neither case matters anymore. Commands stay visible to everyone in the slash command list, but running one without the role gets a plain "Only Leads can use bot commands" reply instead of doing anything. Buttons regular members are meant to use — opening a ticket, verifying, requesting an invoice — aren't affected, only the `/` commands are.

## Verification
`/post-verify` posts a green-accented embed pointing at `RULES_CHANNEL_ID`, with a **Verify** button. Clicking it grants `MEMBER_ROLE_ID` — clicking again once already verified just replies saying so, no duplicate role add. Post it once; it works from that single message from then on.

## Ticket types
Buttons live in `config.json`, not code. Clicking one creates the ticket channel immediately, no form first.

`/create-applications-panel` is the fast path: it scans every role in the server for color `#607d8b`, builds or updates a ticket type for each match automatically (id from the role name, prefix `application`, that role required and granted access on the resulting channel), then posts the panel in one step. Safe to re-run whenever a grey role changes — it doesn't clean up an old panel message first, so delete a stale one before re-running if several pile up.

`/add-ticket-type` still exists for anything that isn't a grey-role discipline — takes no options, asks the id, button label, channel prefix, and a role (or `skip`) in the channel instead. `/remove-ticket-type id:<short-id>` deletes one. `/clear-ticket-types confirm:CONFIRM` deletes every configured type at once. `/list-ticket-types` shows everything currently configured. `/post-panel` re-posts the panel from whatever's in `config.json` right now, without touching role colors.

`/add-ticket-type`'s wizard needs Message Content Intent on in the Developer Portal (Bot → Privileged Gateway Intents) to read chat answers — `/create-applications-panel` doesn't, since it reads role data instead.

## Ticket channels
Opening a ticket now requires already holding the role tied to that type — clicking a button for a discipline someone isn't in gets a plain explanation instead of a channel. This flips the role's meaning: it's no longer something Approve grants, it's the prerequisite for applying in the first place. The channel that opens pings Leads and the applicant only — not the whole discipline role, since everyone holding it already passed the gate above and doesn't need a ping for someone else's application.

Each open ticket still gets a Close button, and an Approve button too if the type has a role attached. Approve no longer grants anything — it prompts for which channel under `PROJECTS_CATEGORY_ID` to add the applicant to (a dropdown built from the actual channels in that category, up to 25), grants them View and Send there on selection, and closes the ticket automatically five seconds later. Close by itself still works exactly as before, Leads-only, five-second delay.

Channels are named `┃<prefix>-001` and so on, numbered per prefix — every `application` ticket shares one counter regardless of discipline. Drop the `┃` from `createTicketChannel` in the code if it doesn't render the way you want.

## Adding someone to a project
`/add-employee user:<pick> channel:<pick a project channel>` grants that user View and Send access to the picked channel and posts a short note in it. Meant for onboarding someone from a ticket straight onto the project channel they'll actually work in — the channel itself still needs to exist first (create it under a Projects category same as any other channel).

## Invoices
`/create-invoice-panel` posts a fixed panel — one button, no configuration — styled green rather than the blurple applications use, so it reads as its own distinct thing at a glance. The button has a 5-minute cooldown per person — clicking again too soon replies with when it'll be ready instead of creating another channel; this resets if the bot restarts, which is fine, nothing depends on it surviving that. Clicking it (once past cooldown) creates a channel named `┃<username>-001`, numbered per person rather than shared: the count comes from how many invoice channels that exact user already has in `INVOICES_CATEGORY_ID`, so their fourth one becomes `-004` automatically. No Close button, and nothing in the code deletes these — they're meant to stay as a permanent record.

On creation the invoice template posts and pins immediately — the real file at the repo root, with an embed pointing at which sections need filling in (Payee, Work, Payment, Project). This is back to how it worked before the commission-terms message got added and then pulled back out — that message (and the emoji resolver built for it) is still in the code, just not called from anywhere right now, in case it's wanted somewhere later rather than rebuilt from scratch.

`/approve-invoice invoice:<attach the completed file>` only works inside an invoice channel. It marks that channel's database row `approved`, stores a link to the file that was attached, and posts a confirmation in the channel itself. If Turso isn't configured, this still posts the confirmation, it just skips the database part.

Every invoice channel also gets logged to a Turso database if `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set — who opened it, the channel, and a `status` column that starts at `pending` and moves to `approved` once `/approve-invoice` runs. The table (and these two columns specifically) are created automatically on first startup if they don't exist yet. Without both Turso vars set, invoice channels still work exactly the same, they just don't get tracked anywhere outside Discord itself.

## Numbering and config persistence
`config.json` lives next to the script and still resets to what's shipped in the repo on every redeploy on a host with no persistent disk (Render's free tier, for one) — live changes made through ticket-type commands don't survive a redeploy unless also committed.

The ticket **counter** no longer has this problem: set `STORAGE_CHANNEL_ID` to a private channel the bot can see, and it gets written there as a pinned message, read back on startup. This is what actually fixes numbers restarting at 001 after a redeploy and colliding with a channel that already exists — without `STORAGE_CHANNEL_ID` set, the counter still works, it just goes back to resetting like before.

## Sending as the bot
`/send-message channel:<pick> message:<text>` posts whatever's typed into the picked channel, as the bot — for announcements or anything else that should read as coming from the server itself rather than a person. Runs the same emoji resolution the commission-terms message uses (custom server emoji by name, standard `:shortcode:` emoji through `node-emoji`), so typing `:tick:` or `:clipboard:` in the message works the same way it would in a normal Discord message. Checks the length before sending and explains why it didn't go through if it's over Discord's 2000-character limit, rather than failing silently.

## Clear channel
`/clear-channel channel:<pick> confirm:CONFIRM` deletes every message in the picked channel. The `confirm` field has to be exactly `CONFIRM` — anything else just explains what the command does without touching anything. No undo once it runs.

Messages under 14 days old go in fast batches. Anything older gets removed one at a time — a Discord API limit, not something to optimize around — so an old, message-heavy channel can take a while. Replies with a final count once actually done.

## Hosting
A host needs to stay running for this to work continuously. Set `RENDER_URL` to the service's own `.onrender.com` address and the bot pings itself every 4 minutes from the outside in, which resets Render's idle timer without needing an external monitor.
