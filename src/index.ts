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
};

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

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as unknown;
  if (!isTelegramUpdate(body)) {
    return new Response("Bad Request", { status: 400 });
  }

  const chatId = body.message?.chat?.id;
  const text = body.message?.text;
  if (chatId === undefined || !text) {
    return new Response(null, { status: 200 });
  }

  return createTelegramResponse(chatId, text);
}

async function handleHealth(): Promise<Response> {
  return new Response("OK", { status: 200 });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealth();
  }

  if (request.method === "POST" && url.pathname === "/webhook") {
    return handleWebhook(request, env);
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env) {
    return handleRequest(request, env);
  },
};

export { createTelegramResponse, handleHealth, handleRequest, handleWebhook, isTelegramUpdate };
export type { Env, TelegramUpdate };
