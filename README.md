# THAHAB AL NAEEM - WhatsApp Group Bot

This version is for one normal WhatsApp group. It uses Baileys (an unofficial WhatsApp Web library), not Meta Cloud API.

## Required environment variables

- `EMPLOYEE_NUMBERS` — comma-separated employee phone numbers, digits only or with +.
- `ALLOWED_GROUP_ID` — the WhatsApp group JID, for example `1203...@g.us`.
- `BOT_PHONE_NUMBER` — the WhatsApp number used by the bot, digits only.
- `REPORT_TO_PHONE` — number that receives the daily Excel report.
- `DATA_DIR` — persistent storage path. On Render use `/var/data`.

## Render

Node.js 20+ is required. Start command:

`npm start`

A persistent disk is required for `auth` and bot data. Mount it at `/var/data`.

## First setup

Leave `ALLOWED_GROUP_ID` empty for the first deployment. The logs will print:

`GROUP_ID_DETECTED: ...`

Copy the correct group JID into `ALLOWED_GROUP_ID`, then redeploy.

The bot only responds when:
1. the message is in the configured group;
2. the sender's number is in `EMPLOYEE_NUMBERS`;
3. the exact word `جديد` starts the transaction.

Normal messages are ignored.

`إلغاء` cancels the active transaction.

## WhatsApp connection

The first connection prints a QR code or pairing code in the Render logs. Link the dedicated bot WhatsApp number as a linked device.

Important: Baileys is unofficial and not affiliated with WhatsApp. Use responsibly and understand that automated WhatsApp Web connections can carry account/platform risk.
