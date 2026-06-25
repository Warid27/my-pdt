# my-pdt

Lightweight Telegram bot service on Bun and Cloudflare Pages Functions.

## Stack

- Bun
- Cloudflare Pages Functions
- Telegram Bot API (webhook mode)

## Endpoints

- `POST /webhook`
- `GET /health`

## Environment Variables

- `TELEGRAM_WEBHOOK_SECRET` - secret passed to Telegram `setWebhook` as `secret_token`

`TELEGRAM_TOKEN` is only needed when registering the webhook with Telegram. The runtime currently replies using Telegram's inline webhook response format, so it does not need the bot token at request time.

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

Required Cloudflare Pages settings:

- Project name: `my-pdt`
- Production environment variable: `TELEGRAM_WEBHOOK_SECRET`
- Custom domain: `my-pdt.warid.web.id`

The repository includes `public/CNAME` with `my-pdt.warid.web.id`, but Cloudflare Pages still needs the custom domain connected in the Cloudflare dashboard or through Cloudflare's API.

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

The Pages Function validates `X-Telegram-Bot-Api-Secret-Token` and replies to Telegram webhook calls with an inline `sendMessage` payload.
