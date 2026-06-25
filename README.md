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

## Environment Variables

- `TELEGRAM_WEBHOOK_SECRET` - secret passed to Telegram `setWebhook` as `secret_token`
- `TELEGRAM_TOKEN` - bot token from BotFather, used for outbound `sendMessage`
- `PROVIDERS` - JSON array of AI providers

Example provider config:

```json
[
  {
    "BASE_URL": "https://api.openai.com/v1",
    "NAME": "openai",
    "TYPE": "OPENAI",
    "API_KEY": "provider-api-key",
    "MODEL_ID": "gpt-4o-mini",
    "MODEL_NAME": "GPT-4o mini"
  },
  {
    "BASE_URL": "https://api.anthropic.com/v1",
    "NAME": "anthropic",
    "TYPE": "ANTHROPIC",
    "API_KEY": "provider-api-key",
    "MODEL_ID": "claude-3-5-haiku-latest",
    "MODEL_NAME": "Claude 3.5 Haiku"
  }
]
```

The first valid provider in `PROVIDERS` is used for replies.

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
- Production secret: `PROVIDERS`
- Custom domain: `my-pdt.warid.web.id`

Add runtime credentials as Cloudflare Pages Secrets, not as plain variables in `wrangler.jsonc`. The repository includes `public/CNAME` with `my-pdt.warid.web.id`, but Cloudflare Pages still needs the custom domain connected in the Cloudflare dashboard or through Cloudflare's API.

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
