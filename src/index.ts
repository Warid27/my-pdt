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

function addLog(event: string, detail?: string): void {
  logs.push({ at: new Date().toISOString(), event, detail });
  if (logs.length > maxLogs) {
    logs.splice(0, logs.length - maxLogs);
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
    addLog("ai_skipped", "TELEGRAM_TOKEN is not configured");
    return;
  }

  try {
    const provider = selectProvider(parseProviders(env.PROVIDERS));
    if (!provider) {
      addLog("provider_missing", "Falling back to echo reply");
      await sendTelegramMessage({ chatId, text, token: env.TELEGRAM_TOKEN });
      addLog("telegram_sent", "Echo reply sent");
      return;
    }

    let replyText: string;
    try {
      const result = await callProvider({ provider, message: text });
      replyText = result.text;
      addLog("provider_reply", provider.NAME);
    } catch {
      replyText = "Sorry, I couldn't generate a reply right now.";
      addLog("provider_error", provider.NAME);
    }

    await sendTelegramMessage({ chatId, text: replyText, token: env.TELEGRAM_TOKEN });
    addLog("telegram_sent", "AI reply sent");
  } catch {
    addLog("telegram_error", "Failed to send reply");
    return;
  }
}

async function handleWebhook(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    addLog("webhook_unauthorized");
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as unknown;
  if (!isTelegramUpdate(body)) {
    addLog("webhook_bad_request");
    return new Response("Bad Request", { status: 400 });
  }

  const chatId = body.message?.chat?.id;
  const text = body.message?.text;
  if (chatId === undefined || !text) {
    addLog("webhook_ignored", "No text message");
    return new Response(null, { status: 200 });
  }

  addLog("webhook_received", `chat:${chatId}`);

  if (!env.TELEGRAM_TOKEN) {
    addLog("webhook_inline_echo");
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

async function handleLogs(url: URL, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json({ logs });
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
  sendAiReply,
};
export type { Env, ExecutionContextLike, LogEntry, TelegramUpdate };
