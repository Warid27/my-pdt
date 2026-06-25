# my-pdt

Lightweight Telegram bot service on Bun and Cloudflare Workers.

## Stack

- Bun
- Cloudflare Workers
- Telegram Bot API (webhook mode)

## Endpoints

- `POST /webhook`
- `GET /health`

## Environment Variables

- `TELEGRAM_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

## Commands

- `bun install`
- `bun test`
- `bun run dev`
- `bun run deploy`

## Notes

The worker validates `X-Telegram-Bot-Api-Secret-Token` and replies to Telegram webhook calls with an inline `sendMessage` payload.
