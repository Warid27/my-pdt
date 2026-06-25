# my-pdt

Lightweight Telegram bot service on Bun and Cloudflare Pages Functions.

## Stack

- Bun
- Cloudflare Pages Functions
- Telegram Bot API (webhook mode)
- OpenAI-compatible and Anthropic-compatible chat providers

## Endpoints

- `POST /webhook`
- `GET /health`
- `GET /logs?token=<TELEGRAM_WEBHOOK_SECRET>`
- `GET /finance/balances?token=<TELEGRAM_WEBHOOK_SECRET>`
- `GET /finance/ledger?token=<TELEGRAM_WEBHOOK_SECRET>`
- `GET /finance/reminders?token=<TELEGRAM_WEBHOOK_SECRET>`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/accounts`
- `GET /api/accounts/:id`
- `GET /api/dashboard`
- `GET /api/finance/summary`
- `GET /api/finance/list`
- `GET /api/finance/statistics`

All `/api/*` read endpoints require `Authorization: Bearer <accessToken>` and return camelCase JSON. List endpoints use the shared pagination contract:

- query params: `page`, `pageSize`
- response fields: `items`, `page`, `pageSize`, `total`, `totalPages`

## Environment Variables

- `TELEGRAM_WEBHOOK_SECRET` - secret passed to Telegram `setWebhook` as `secret_token`
- `TELEGRAM_TOKEN` - bot token from BotFather, used for outbound `sendMessage`
- `TELEGRAM_REMINDER_CHAT_ID` - chat ID for scheduled debt reminder notifications
- `PROVIDERS` - JSON array of AI providers
- `AUTH_SEEDED_ACCOUNTS` - JSON array of seeded login accounts for the API surface

Example provider and seeded-account config:

```json
[
  {
    "BASE_URL": "https://api.openai.com/v1",
    "NAME": "openai",
    "TYPE": "OPENAI",
    "API_KEY": "provider-api-key",
    "MODEL_ID": "gpt-4o-mini",
    "MODEL_NAME": "GPT-4o mini"
  }
]
```

```json
[
  {
    "email": "owner@example.com",
    "password": "replace-with-a-random-generated-password",
    "name": "Owner",
    "role": "admin"
  }
]
```


Use a random generated password for production seeded accounts and store it only as a Cloudflare Pages secret. The first valid provider in `PROVIDERS` is used for replies.

## Local Development

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create local environment variables:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Fill `.dev.vars`:

   ```env
   TELEGRAM_WEBHOOK_SECRET=your-random-secret
   TELEGRAM_TOKEN=your-telegram-bot-token
   TELEGRAM_REMINDER_CHAT_ID=your-telegram-chat-id
   AUTH_SEEDED_ACCOUNTS='[{"email":"owner@example.com","password":"replace-with-a-random-generated-password","name":"Owner","role":"admin"}]'
   PROVIDERS='[{"BASE_URL":"https://api.openai.com/v1","NAME":"openai","TYPE":"OPENAI","API_KEY":"your-provider-api-key","MODEL_ID":"gpt-4o-mini","MODEL_NAME":"GPT-4o mini"}]'
   ```

4. Run tests:

   ```bash
   bun test
   ```

5. Run locally with Pages Functions:

   ```bash
   bun run dev
   ```

## Cloudflare Pages Deployment

GitHub Actions deploys this project to Cloudflare Pages using `.github/workflows/deploy.yml`.

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` - Cloudflare API token with Cloudflare Pages edit/deploy access
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID

The workflow deploys `public` to the existing `my-pdt` Cloudflare Pages project with Pages Functions from `functions/`.

Required Cloudflare Pages settings after the first deploy:

- Production secret: `TELEGRAM_WEBHOOK_SECRET`
- Production secret: `TELEGRAM_TOKEN`
- Production secret: `TELEGRAM_REMINDER_CHAT_ID`
- Production secret: `PROVIDERS`
- Production secret: `AUTH_SEEDED_ACCOUNTS`
- D1 binding: `DB`
- Custom domain: `my-pdt.warid.web.id`

Add runtime credentials as Cloudflare Pages Secrets, not as plain variables in `wrangler.jsonc`. The repository includes `public/CNAME` with `my-pdt.warid.web.id`, but Cloudflare Pages still needs the custom domain connected in the Cloudflare dashboard or through Cloudflare's API.

Create and migrate the D1 database before expecting durable logs, finance data, or seeded API auth:

```bash
bunx wrangler d1 create my-pdt
bunx wrangler d1 migrations apply my-pdt --remote
```

After `wrangler d1 create`, copy the returned `database_id` into a D1 binding named `DB` for the `my-pdt` database.

## Finance Feature

The finance feature records personal finance events in D1 using double-entry ledger rows. The AI provider receives a finance system prompt plus allowlisted tools, but the backend owns account routing and database writes.

Supported finance tool actions:

- `record_transaction` for expenses, income, gifts, lending, borrowing, and repayments
- `create_new_wallet` after explicit user confirmation
- `get_wallets` and `get_debts_summary` for lookup and clarification
- `add_reminder` and `settle_reminder_by_context` for debt reminders

Account names follow these conventions:

- `assets:wallets:<wallet_name>`
- `assets:receivables:<person_name>`
- `liabilities:payables:<person_name>`
- `expenses:<category>`
- `income:<source>`

Unknown wallets are not created automatically during transaction recording. The bot should ask whether to create the wallet first. Person-specific receivable/payable accounts are provisioned automatically by the backend.

Finance read endpoints are protected with the same token pattern as `/logs`:

```text
https://my-pdt.warid.web.id/finance/balances?token=<TELEGRAM_WEBHOOK_SECRET>
https://my-pdt.warid.web.id/finance/ledger?token=<TELEGRAM_WEBHOOK_SECRET>
https://my-pdt.warid.web.id/finance/reminders?token=<TELEGRAM_WEBHOOK_SECRET>
```

Debt reminder helpers are implemented in code, but scheduled notifications require a Worker cron trigger. This project currently deploys as Cloudflare Pages Functions, so run reminder scanning from a Worker deployment or migrate the runtime before relying on automatic daily notifications. Set `TELEGRAM_REMINDER_CHAT_ID` to the Telegram chat that should receive due reminder notifications.

## API Notes

The frontend API uses seeded accounts only: there is no self-service registration endpoint. Login returns `accessToken` and `refreshToken`, refresh rotates both tokens, and logout revokes the current session.

## Telegram Webhook Setup

After deployment, register the Telegram webhook once:

```text
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://my-pdt.warid.web.id/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Verify it:

```text
https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo
```

## Notes

The Pages Function validates `X-Telegram-Bot-Api-Secret-Token`, quickly acknowledges valid webhook requests, and sends AI replies through Telegram Bot API `sendMessage`. If `TELEGRAM_TOKEN` is not configured, it falls back to the original inline echo response.

`/logs` exposes recent in-memory diagnostic events for this runtime instance only. It is protected by the webhook secret token and should be used only for quick production checks.
