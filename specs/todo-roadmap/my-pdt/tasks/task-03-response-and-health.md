# Task 03: Bot response and health endpoint

## Objective
Complete request handling for bot replies and service health checks.

## Scope
- Return a Telegram-compatible success response.
- Support the inline webhook response pattern or outbound sendMessage call.
- Add `GET /health`.

## Depends On
- `task-02-webhook-handler`

## Touched Files
- `src/index.ts`

## Done When
- Telegram receives a response that prevents webhook retries.
- `/health` returns `200 OK`.
- The implementation matches the PRD's corrected architecture.
