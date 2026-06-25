# Project Brief

## Project
`my-pdt`

## Goal
Build a lightweight Telegram bot service on Bun and Cloudflare Workers.

## Non-Goals
- No database or persistence
- No admin UI
- No multi-bot support

## Constraints
- Webhook mode only for Telegram delivery
- Validate `X-Telegram-Bot-Api-Secret-Token`
- Return HTTP 200 for valid webhook processing
- Expose `GET /health`
- Use Cloudflare Workers as the deploy target
