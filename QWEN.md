# QWEN.md

## Project Overview

This repository currently contains the product requirements and working context for `my-pdt`, a lightweight Telegram bot service intended to run on Bun and Cloudflare Workers.

The documented goal is to receive Telegram updates via webhook and send messages back through the Telegram Bot API. The current repository state appears to be documentation-only; no application source, package manifest, or deployment config is present yet.

## Repository Purpose

This directory is being used as the project planning and specification workspace for the Telegram bot implementation.

`PRD.md` is the primary source of truth for:
- the target runtime and deployment platform
- webhook-based Telegram integration
- the intended endpoints and environment variables
- the corrected architecture and implementation plan

## Key Files

- `PRD.md` — product requirements, architecture notes, webhook behavior, environment variables, and implementation plan.
- `QWEN.md` — this operational guide for future agent runs in this repository.

## Current State

The repository does not yet expose any executable application files. Based on the available files, there is no confirmed build, run, or test command at this stage.

## Expected Architecture

The PRD describes a Cloudflare Worker that:
- exposes `POST /webhook` for Telegram updates
- validates `X-Telegram-Bot-Api-Secret-Token`
- parses incoming Telegram `Update` payloads
- responds in a way that causes Telegram to stop retrying
- exposes `GET /health` for health checks

Environment variables called out in the PRD:
- `TELEGRAM_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

## Development Notes

When source files are added, prefer to keep the implementation aligned with the PRD:
- Bun runtime
- Cloudflare Workers deployment target
- webhook mode only, not long polling
- minimal state, no database, no admin UI, no multi-bot support

## Build, Run, and Test

No commands are defined in the repository yet.

TODO once application files exist:
- document package manager and install command
- document local dev or worker preview command
- document deployment command
- document test/lint commands

## Usage Guidance

Use this repository as the authoritative workspace for the `my-pdt` bot implementation plan. When adding code later, keep `PRD.md` updated if architecture or webhook behavior changes, and update this file with the actual project commands and conventions.
