# Qualion Management bot

## Commands
All commands need the Lead role.

| Command | What it does |
|---|---|
| `/create-applications-panel` | Posts one button per role coloured `#607d8b`. Re-run after adding, renaming or recolouring a role, then delete the old panel. |
| `/create-invoice-panel` | Posts the green Create Payment Ticket panel. |
| `/post-verify` | Posts the verification panel. |
| `/add-employee user channel` | Gives someone access to a project channel. |
| `/approve-invoice invoice` | Run inside an invoice channel with the completed PDF; marks it approved. |
| `/send-message channel message` | Posts as the bot. `:emoji_name:` works for custom and standard emoji. |
| `/clear-channel channel confirm:CONFIRM` | Wipes a channel. No undo. |
| `/bot-status` | Shows which settings are set, found, or broken. Run this first when something looks wrong. |

## Applications
Panel buttons store the role ID directly, so they keep working through restarts and redeploys. Applying needs that role. One open application per person. The channel is visible to the applicant, Leads and the bot only. Approve asks which Projects channel to add the applicant to; the ticket stays open until Close.

## Invoices
Channels are named `┃username-001` and numbered per person from the channels already in the Invoices category. They are never deleted. The template file `InvoiceTemplate.docx` is attached and pinned. With Turso set, each invoice is logged and `/approve-invoice` marks it approved.

## Reliability
- Every button and command acknowledges Discord instantly, so slow moments on the free host no longer show "This interaction failed".
- Crashes, unhandled errors and an invalidated Discord session restart the process; Render brings it back up.
- A watchdog restarts the process if the Discord connection stays down for 5 minutes.
- `/health` returns 200 when connected to Discord and 503 when not. Set it as Render's Health Check Path.
- The ticket counter is saved in the storage channel and also checked against existing channel names, so numbers never collide.
- The bot pings its own URL every 4 minutes. Add an external monitor (UptimeRobot) on `/health` so the service is woken if it ever sleeps.

## Environment
See `.env.example`. Required: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `LEADS_ROLE_ID`. Everything else switches on its feature; `/bot-status` shows what's missing.
