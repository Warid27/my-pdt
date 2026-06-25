# Task 02: Telegram webhook intake

## Objective
Implement `POST /webhook` to receive Telegram updates.

## Scope
- Validate `X-Telegram-Bot-Api-Secret-Token`.
- Parse incoming Telegram update payloads.
- Extract chat and message fields needed for replies.

## Depends On
- `task-01-foundation`

## Touched Files
- `src/index.ts`

## Done When
- Invalid webhook requests are rejected.
- Valid webhook requests are parsed into a typed or structured update shape.
- The handler can identify the target chat and message text.
