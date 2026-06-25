import {
  executeFinanceToolCall,
  getDueReminders,
  getFinanceBalances,
  getLedger,
  getReminders,
  markReminderSent,
} from "./finance";
import { handleApiRequest, type AuthEnv } from "./api";
import { callProvider, parseProviders, ProviderError, selectProvider } from "./providers";
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
  TELEGRAM_REMINDER_CHAT_ID?: string;
  PROVIDERS?: string;
  AUTH_SEEDED_ACCOUNTS?: string;
  DB?: D1Database;
};

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type ScheduledControllerLike = {
  scheduledTime: number;
  cron: string;
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

function truncateText(value: string, maxLength = 2000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated:${value.length}>` : value;
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? truncateText(value) : value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?key|token|authorization|secret|password|x-api-key)$/i.test(key)) {
      result[key] = "<redacted>";
      continue;
    }
    result[key] = redactSensitive(item);
  }
  return result;
}

function logDetail(value: unknown): string {
  return truncateText(JSON.stringify(redactSensitive(value)));
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

function createTelegramResponse(chatId: number | string, text: string, replyMarkup?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      method: "sendMessage",
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

function isWalletDeletionRequest(text: string): boolean {
  return /\b(hapus|delete|remove)\b.*\bwallet\b|\bwallet\b.*\b(hapus|delete|remove)\b/i.test(text);
}

function createCommandsResponse(chatId: number | string): Response {
  return createTelegramResponse(
    chatId,
    [
      "Available commands:",
      "/commands - show this help",
      "/help - show this help",
      "/start - show this help",
      "Natural language examples:",
      "- gajian 6jt ke kantong utama",
      "- beli bakso 10k pake cash",
      "- Helmi pinjem 12k",
      "- lihat wallet",
      "- hapus wallet <nama> (not supported)",
    ].join("\n"),
    {
      keyboard: [
        [{ text: "/commands" }, { text: "/help" }, { text: "/start" }],
        [{ text: "lihat wallet" }, { text: "gajian 6jt ke kantong utama" }],
        [{ text: "beli bakso 10k pake cash" }, { text: "Helmi pinjem 12k" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      is_persistent: true,
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

    if (isWalletDeletionRequest(text)) {
      recordLog(env, "wallet_delete_blocked", logDetail({ chatId, message: text }));
      await sendTelegramMessage({
        chatId,
        text: "Deleting wallets is not supported yet. Send 'lihat wallet' if you want the current list.",
        token: env.TELEGRAM_TOKEN,
      });
      recordLog(env, "telegram_sent", logDetail({ kind: "wallet delete blocked", chatId }));
      return;
    }

    recordLog(
      env,
      "ai_request",
      logDetail({ chatId, provider: provider.NAME, type: provider.TYPE, model: provider.MODEL_ID, message: text }),
    );

    let replyText: string;
    try {
      const started = Date.now();
      const result = await callProvider({ provider, message: text });
      recordLog(
        env,
        "ai_response",
        logDetail({
          provider: provider.NAME,
          model: provider.MODEL_ID,
          duration_ms: Date.now() - started,
          text: result.text,
          tool_calls: result.toolCalls,
          usage: result.usage,
          raw_response: result.rawResponse,
        }),
      );

      const toolResults = [];
      for (const toolCall of result.toolCalls) {
        recordLog(env, "finance_tool_call", logDetail({ name: toolCall.name, arguments: toolCall.arguments }));
        const toolResult = await executeFinanceToolCall(env, toolCall.name, toolCall.arguments);
        toolResults.push(toolResult);
        recordLog(env, "finance_tool_result", logDetail({ name: toolCall.name, result: toolResult }));
      }

      replyText = toolResults.length > 0 ? toolResults.map((item) => item.text).join("\n") : result.text;
      recordLog(env, toolResults.length > 0 ? "finance_tools_executed" : "provider_reply", provider.NAME);
    } catch (error) {
      replyText = "Sorry, I couldn't generate a reply right now.";
      recordLog(
        env,
        "provider_error",
        logDetail({
          provider: provider.NAME,
          message: error instanceof Error ? error.message : String(error),
          status: error instanceof ProviderError ? error.status : undefined,
          body: error instanceof ProviderError ? error.body : undefined,
        }),
      );
    }

    await sendTelegramMessage({ chatId, text: replyText, token: env.TELEGRAM_TOKEN });
    recordLog(env, "telegram_sent", logDetail({ kind: "AI reply sent", chatId, text: replyText }));
  } catch (error) {
    recordLog(env, "telegram_error", logDetail({ message: error instanceof Error ? error.message : String(error) }));
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

  if (["/commands", "/help", "/start"].includes(text.trim())) {
    recordLog(env, "commands_listed", `chat:${chatId}`, ctx);
    return createCommandsResponse(chatId);
  }

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

function isAuthorizedFinanceRequest(url: URL, env: Env): boolean {
  return Boolean(env.TELEGRAM_WEBHOOK_SECRET && url.searchParams.get("token") === env.TELEGRAM_WEBHOOK_SECRET);
}

async function handleFinanceRequest(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isAuthorizedFinanceRequest(url, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (request.method === "GET" && url.pathname === "/finance/balances") {
    return Response.json(await getFinanceBalances(env));
  }

  if (request.method === "GET" && url.pathname === "/finance/ledger") {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    return Response.json({ ledger: await getLedger(env, Number.isFinite(limit) ? limit : 100) });
  }

  if (request.method === "GET" && url.pathname === "/finance/reminders") {
    return Response.json({ reminders: await getReminders(env, url.searchParams.get("includePaid") === "true") });
  }

  return new Response("Not Found", { status: 404 });
}

async function sendDueReminders(env: Env): Promise<void> {
  if (!env.TELEGRAM_TOKEN) {
    recordLog(env, "reminders_skipped", "TELEGRAM_TOKEN is not configured");
    return;
  }

  const chatId = env.TELEGRAM_REMINDER_CHAT_ID;
  if (!chatId) {
    recordLog(env, "reminders_skipped", "TELEGRAM_REMINDER_CHAT_ID is not configured");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const reminders = await getDueReminders(env, today);
  for (const reminder of reminders) {
    const text = `Reminder: ${reminder.direction === "owe" ? "you owe" : "owed to you by"} ${reminder.person} ${reminder.amount.toLocaleString("id-ID")}.`;
    await sendTelegramMessage({ chatId, text, token: env.TELEGRAM_TOKEN });
    await markReminderSent(env, reminder.id);
  }

  recordLog(env, "reminders_sent", String(reminders.length));
}

async function handleScheduled(_controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
  ctx.waitUntil(sendDueReminders(env));
}

async function handleRequest(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealth();
  }

  if (request.method === "GET" && url.pathname === "/logs") {
    return handleLogs(url, env);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApiRequest(request, env as AuthEnv);
  }

  if (url.pathname.startsWith("/finance/")) {
    return handleFinanceRequest(request, url, env);
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
  scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike) {
    return handleScheduled(controller, env, ctx);
  },
};

export {
  addLog,
  clearLogs,
  createCommandsResponse,
  createTelegramResponse,
  handleFinanceRequest,
  handleHealth,
  handleLogs,
  handleRequest,
  handleScheduled,
  handleWebhook,
  isTelegramUpdate,
  readLogs,
  recordLog,
  sendAiReply,
};
export type { Env, ExecutionContextLike, LogEntry, ScheduledControllerLike, TelegramUpdate };
