import { callProvider, parseProviders, selectProvider } from "./providers";
import { sendTelegramMessage } from "./telegram";

type TelegramMessage = {
  chat?: {
    id?: number | string;
  };
  text?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
};

type Env = {
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_TOKEN?: string;
  PROVIDERS?: string;
  DB?: D1Database;
};

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type LogEntry = {
  at: string;
  event: string;
  detail?: string;
};

const logs: LogEntry[] = [];
const maxLogs = 100;

function addLog(event: string, detail?: string): LogEntry {
  const entry = { at: new Date().toISOString(), event, detail };
  logs.push(entry);
  if (logs.length > maxLogs) {
    logs.splice(0, logs.length - maxLogs);
  }
  return entry;
}

async function persistLog(env: Env, entry: LogEntry): Promise<void> {
  if (!env.DB) {
    return;
  }

  await env.DB
    .prepare("INSERT INTO logs (at, event, detail) VALUES (?, ?, ?)")
    .bind(entry.at, entry.event, entry.detail ?? null)
    .run();
}

function recordLog(env: Env, event: string, detail?: string, ctx?: ExecutionContextLike): void {
  const entry = addLog(event, detail);
  if (!env.DB) {
    return;
  }

  const write = persistLog(env, entry).catch(() => undefined);
  if (ctx) {
    ctx.waitUntil(write);
  }
}

function clearLogs(): void {
  logs.splice(0, logs.length);
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== "object") {
    return false;
  }

  const update = value as TelegramUpdate;
  if (!update.message || typeof update.message !== "object") {
    return true;
  }

  const message = update.message;
  if (message.chat && typeof message.chat !== "object") {
    return false;
  }

  return true;
}

function createTelegramResponse(chatId: number | string, text: string): Response {
  return new Response(
    JSON.stringify({
      method: "sendMessage",
      chat_id: chatId,
      text,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

async function sendAiReply(chatId: number | string, text: string, env: Env): Promise<void> {
  if (!env.TELEGRAM_TOKEN) {
    recordLog(env, "ai_skipped", "TELEGRAM_TOKEN is not configured");
    return;
  }

  try {
    const provider = selectProvider(parseProviders(env.PROVIDERS));
    if (!provider) {
      recordLog(env, "provider_missing", "Falling back to echo reply");
      await sendTelegramMessage({ chatId, text, token: env.TELEGRAM_TOKEN });
      recordLog(env, "telegram_sent", "Echo reply sent");
      return;
    }

    let replyText: string;
    try {
      const result = await callProvider({ provider, message: text });
      replyText = result.text;
      recordLog(env, "provider_reply", provider.NAME);
    } catch {
      replyText = "Sorry, I couldn't generate a reply right now.";
      recordLog(env, "provider_error", provider.NAME);
    }

    await sendTelegramMessage({ chatId, text: replyText, token: env.TELEGRAM_TOKEN });
    recordLog(env, "telegram_sent", "AI reply sent");
  } catch {
    recordLog(env, "telegram_error", "Failed to send reply");
    return;
  }
}

async function handleWebhook(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    recordLog(env, "webhook_unauthorized", undefined, ctx);
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as unknown;
  if (!isTelegramUpdate(body)) {
    recordLog(env, "webhook_bad_request", undefined, ctx);
    return new Response("Bad Request", { status: 400 });
  }

  const chatId = body.message?.chat?.id;
  const text = body.message?.text;
  if (chatId === undefined || !text) {
    recordLog(env, "webhook_ignored", "No text message", ctx);
    return new Response(null, { status: 200 });
  }

  recordLog(env, "webhook_received", `chat:${chatId}`, ctx);

  if (!env.TELEGRAM_TOKEN) {
    recordLog(env, "webhook_inline_echo", undefined, ctx);
    return createTelegramResponse(chatId, text);
  }

  const reply = sendAiReply(chatId, text, env);
  if (ctx) {
    ctx.waitUntil(reply);
  } else {
    await reply;
  }

  return new Response(null, { status: 200 });
}

async function handleHealth(): Promise<Response> {
  return new Response("OK", { status: 200 });
}

async function readLogs(env: Env): Promise<LogEntry[]> {
  if (!env.DB) {
    return logs;
  }

  const result = await env.DB
    .prepare("SELECT at, event, detail FROM logs ORDER BY id DESC LIMIT 100")
    .all<LogEntry>();

  return result.results.reverse();
}

async function handleLogs(url: URL, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json({ logs: await readLogs(env) });
}

async function handleRequest(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealth();
  }

  if (request.method === "GET" && url.pathname === "/logs") {
    return handleLogs(url, env);
  }

  if (request.method === "POST" && url.pathname === "/webhook") {
    return handleWebhook(request, env, ctx);
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    return handleRequest(request, env, ctx);
  },
};

export {
  addLog,
  clearLogs,
  createTelegramResponse,
  handleHealth,
  handleLogs,
  handleRequest,
  handleWebhook,
  isTelegramUpdate,
  readLogs,
  recordLog,
  sendAiReply,
};
export type { Env, ExecutionContextLike, LogEntry, TelegramUpdate };
