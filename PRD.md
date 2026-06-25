\# PRD: my-pdt



\*\*Project:\*\* `my-pdt`

\*\*Stack:\*\* Bun · Cloudflare Workers

\*\*Goal:\*\* Connect to Telegram — receive and send messages.



\---



\## Overview



A lightweight Telegram bot service running on Cloudflare Workers (Bun). It receives updates from Telegram via webhook and sends messages back using the Bot API.



\---



\## Goals



\- Receive messages from Telegram via webhook

\- Send messages to Telegram via Bot API



\---



\## Non-Goals



\- No database / message persistence

\- No admin UI

\- No multi-bot support



\---



\## Tech Stack



| Layer | Choice |

|---|---|

| Runtime | Bun |

| Deploy target | Cloudflare Workers |

| Telegram integration | Telegram Bot API (webhook mode) |



\---



\## How Telegram Webhook Works (from official docs)



Two mutually exclusive ways to receive updates:



1\. \*\*Long polling\*\* (`getUpdates`) — bot polls Telegram repeatedly. Simple but inefficient.

2\. \*\*Webhook\*\* (`setWebhook`) — Telegram pushes updates to your HTTPS URL. Better for production.



> ⚠️ You \*\*cannot\*\* use both at the same time. Once webhook is set, `getUpdates` stops working.



When a user sends a message, Telegram POSTs a JSON-serialized `Update` object to your webhook URL. If your server returns a non-2xx response, Telegram will retry.



\*\*Webhook requirements (from docs):\*\*

\- Must be \*\*HTTPS\*\* (TLS 1.2+)

\- Supported ports: \*\*443, 80, 88, 8443\*\* only

\- Cloudflare Workers uses port 443 by default ✅



\*\*Secret token validation:\*\* pass `secret\_token` in `setWebhook` → Telegram sends it as `X-Telegram-Bot-Api-Secret-Token` header on every request. Validate this in the Worker.



\---



\## Correct Architecture



```

User sends message

&#x20;       ↓

&#x20; Telegram servers

&#x20;       ↓  HTTPS POST (JSON Update object)

Cloudflare Worker (/webhook)

&#x20;       ↓

&#x20; Validate X-Telegram-Bot-Api-Secret-Token header

&#x20;       ↓

&#x20; Parse Update → extract chat.id + message.text

&#x20;       ↓

&#x20; POST https://api.telegram.org/bot<TOKEN>/sendMessage

&#x20; { chat\_id, text }

&#x20;       ↓

&#x20; Return HTTP 200 to Telegram (required to stop retries)

```



> 🔑 Key point: the Worker \*\*must return 200 OK\*\* to Telegram after receiving the update, otherwise Telegram will keep retrying.



> 💡 Shortcut: Telegram also allows replying directly in the webhook response body (respond with `application/json` containing `method: "sendMessage"` and params). No need for a separate outbound HTTP call. Useful in Cloudflare Workers to avoid extra latency.



\---



\## What Changed vs Original PRD



| Original | Corrected |

|---|---|

| Flow showed send as a separate step after processing | Clarified: can reply inline in webhook response body (faster) |

| `WEBHOOK\_SECRET` as env var name | Renamed to `TELEGRAM\_WEBHOOK\_SECRET` to be explicit |

| No mention of 200 OK requirement | Added — Telegram retries on non-2xx |

| No mention of supported ports | Added — only 443, 80, 88, 8443 |

| No mention of getUpdates conflict | Added — webhook disables getUpdates |



\---



\## Core Endpoints



| Method | Path | Description |

|---|---|---|

| `POST` | `/webhook` | Receive Telegram updates |

| `GET` | `/health` | Health check |



\---



\## Environment Variables



| Variable | Description |

|---|---|

| `TELEGRAM\_TOKEN` | Bot token from @BotFather |

| `TELEGRAM\_WEBHOOK\_SECRET` | Secret for validating `X-Telegram-Bot-Api-Secret-Token` header |



\---



\## Implementation Plan



\### 1. Init project

```bash

bun init my-pdt

bun add wrangler

```



\### 2. Worker logic (`src/index.ts`)



```

POST /webhook

&#x20; → validate X-Telegram-Bot-Api-Secret-Token

&#x20; → parse body as Update

&#x20; → extract update.message.chat.id + update.message.text

&#x20; → return 200 + { method: "sendMessage", chat\_id, text }

```



\### 3. Deploy

```bash

bunx wrangler deploy

```



\### 4. Register webhook (one-time)

```

https://api.telegram.org/bot<TOKEN>/setWebhook

&#x20; ?url=https://<worker>.workers.dev/webhook

&#x20; \&secret\_token=<TELEGRAM\_WEBHOOK\_SECRET>

```



\### 5. Verify webhook

```

https://api.telegram.org/bot<TOKEN>/getWebhookInfo

```



\---



\## Success Criteria



\- \[ ] Worker deployed and accessible on `\*.workers.dev`

\- \[ ] Webhook registered and `getWebhookInfo` shows correct URL

\- \[ ] Bot responds to incoming messages

\- \[ ] Worker returns 200 on every valid update

\- \[ ] `/health` returns `200 OK`

