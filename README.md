# THAHAB AL NAEEM Group Bot

WhatsApp Web group bot using whatsapp-web.js.

## Render
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

## Environment variables
- `BOT_PHONE_NUMBER` = bot WhatsApp number, digits only, e.g. `971506493440`
- `EMPLOYEE_NUMBERS` = comma-separated employee numbers, digits only
- `ALLOWED_GROUP_ID` = exact group JID after discovery, e.g. `1203...@g.us`
- `REPORT_TO_PHONE` = report recipient number, digits only
- `DATA_DIR` = `./data` on Render Free; use a persistent disk path on a paid service for durable sessions/data

The bot starts with phone-number pairing code mode. In WhatsApp: Settings > Linked devices > Link a device > Link with phone number.

Note: whatsapp-web.js is an unofficial WhatsApp Web automation library and is not affiliated with WhatsApp. Automated/unofficial clients can be blocked.
