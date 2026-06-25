import { beforeEach, describe, expect, it } from "bun:test";
import { clearLogs, createTelegramResponse, handleRequest, isTelegramUpdate } from "../src/index";
import { callAnthropicCompatible, callOpenAiCompatible, parseProviders, selectProvider } from "../src/providers";
import { sendTelegramMessage } from "../src/telegram";

beforeEach(() => {
  clearLogs();
});

describe("isTelegramUpdate", () => {
  it("accepts an update with message", () => {
    expect(isTelegramUpdate({ message: { chat: { id: 123 }, text: "hi" } })).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isTelegramUpdate(null)).toBe(false);
    expect(isTelegramUpdate("nope")).toBe(false);
  });
});

describe("createTelegramResponse", () => {
  it("returns a sendMessage payload", async () => {
    const response = createTelegramResponse(123, "hello");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      method: "sendMessage",
      chat_id: 123,
      text: "hello",
    });
  });
});

describe("providers", () => {
  const providersJson = JSON.stringify([
    {
      BASE_URL: "https://api.example.com/v1",
      NAME: "example-openai",
      TYPE: "OPENAI",
      API_KEY: "key",
      MODEL_ID: "model-id",
      MODEL_NAME: "Model Label",
    },
  ]);

  it("parses and selects providers", () => {
    const providers = parseProviders(providersJson);

    expect(providers).toHaveLength(1);
    expect(selectProvider(providers)?.NAME).toBe("example-openai");
  });

  it("ignores malformed provider config", () => {
    expect(parseProviders("not-json")).toEqual([]);
    expect(parseProviders(JSON.stringify([{ TYPE: "OPENAI" }]))).toEqual([]);
  });

  it("builds OpenAI-compatible chat requests", async () => {
    const provider = parseProviders(providersJson)[0];
    const calls: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ choices: [{ message: { content: "Hello from AI" } }] });
    };

    const result = await callOpenAiCompatible({ provider, message: "Hi", fetcher });

    expect(result.text).toBe("Hello from AI");
    expect(JSON.parse(String(calls[0].body))).toEqual({
      model: "model-id",
      messages: [{ role: "user", content: "Hi" }],
    });
  });

  it("builds Anthropic-compatible message requests", async () => {
    const provider = {
      ...parseProviders(providersJson)[0],
      TYPE: "ANTHROPIC" as const,
    };
    const calls: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ content: [{ type: "text", text: "Hello from Claude" }] });
    };

    const result = await callAnthropicCompatible({ provider, message: "Hi", fetcher });

    expect(result.text).toBe("Hello from Claude");
    expect(JSON.parse(String(calls[0].body))).toEqual({
      model: "model-id",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
    });
  });
});

describe("sendTelegramMessage", () => {
  it("sends Telegram Bot API messages", async () => {
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    };

    await sendTelegramMessage({ chatId: 123, text: "hello", token: "token", fetcher });

    expect(String(calls[0].url)).toBe("https://api.telegram.org/bottoken/sendMessage");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ chat_id: 123, text: "hello" });
  });
});

describe("handleRequest", () => {
  const env = { TELEGRAM_WEBHOOK_SECRET: "secret" };

  it("returns health check", async () => {
    const response = await handleRequest(new Request("https://example.com/health"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("rejects webhook requests with the wrong secret", async () => {
    const response = await handleRequest(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "wrong",
        },
        body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns a Telegram reply payload for webhook messages without bot token", async () => {
    const response = await handleRequest(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "secret",
        },
        body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      method: "sendMessage",
      chat_id: 123,
      text: "hi",
    });
  });

  it("protects logs with the webhook secret token", async () => {
    const denied = await handleRequest(new Request("https://example.com/logs?token=wrong"), env);
    expect(denied.status).toBe(401);

    await handleRequest(new Request("https://example.com/health"), env);
    const response = await handleRequest(new Request("https://example.com/logs?token=secret"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ logs: [] });
  });

  it("records webhook activity in logs", async () => {
    await handleRequest(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "secret",
        },
        body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
      }),
      env,
    );

    const response = await handleRequest(new Request("https://example.com/logs?token=secret"), env);
    const body = (await response.json()) as { logs: Array<{ event: string; detail?: string }> };

    expect(body.logs.map((log) => log.event)).toEqual(["webhook_received", "webhook_inline_echo"]);
    expect(body.logs[0].detail).toBe("chat:123");
  });

  it("acknowledges webhook requests and schedules AI replies when a token is configured", async () => {
    const providers = JSON.stringify([
      {
        BASE_URL: "https://api.example.com/v1",
        NAME: "example-openai",
        TYPE: "OPENAI",
        API_KEY: "provider-key",
        MODEL_ID: "model-id",
        MODEL_NAME: "Model Label",
      },
    ]);
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      if (String(url).includes("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "Whatsupp?" } }] });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const scheduled: Promise<unknown>[] = [];
    try {
      const response = await handleRequest(
        new Request("https://example.com/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "secret",
          },
          body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
        }),
        { TELEGRAM_WEBHOOK_SECRET: "secret", TELEGRAM_TOKEN: "telegram-token", PROVIDERS: providers },
        { waitUntil: (promise) => scheduled.push(promise) },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(scheduled).toHaveLength(1);
      await scheduled[0];
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.map((call) => String(call.url))).toEqual([
      "https://api.example.com/v1/chat/completions",
      "https://api.telegram.org/bottelegram-token/sendMessage",
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ chat_id: 123, text: "Whatsupp?" });
  });
});
