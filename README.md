# Thahab Al Naeem WhatsApp Bot

WhatsApp Cloud API bot for jewelry transaction entry.

## Flow

Employee sends:
- `جديد`

Bot asks:
1. Barcode
2. Customer name
3. Weight
4. Price
5. Confirmation

`إلغاء` cancels the current transaction.

The sender's WhatsApp number is stored automatically. If WhatsApp provides the profile name in the webhook, that is stored too.

## Endpoints

- `GET /health` — health check
- `GET /webhook` — Meta webhook verification
- `POST /webhook` — incoming WhatsApp messages
- `GET /report.xlsx` — Excel report

## Render start command

`gunicorn app:app`

## Environment variables

Set the variables from `.env.example` in Render. Never put the Meta access token into GitHub.

For production, use Render PostgreSQL via `DATABASE_URL`. SQLite is included only to make local testing simple.

## Important next step

After deployment, configure Meta's WhatsApp Webhooks with:

- Callback URL: `https://YOUR-RENDER-DOMAIN/webhook`
- Verify token: exactly the same value as `VERIFY_TOKEN`

Then subscribe the app to the WhatsApp `messages` webhook field.
