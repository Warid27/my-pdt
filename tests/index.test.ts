import { describe, expect, it } from "bun:test";
import { createTelegramResponse, handleRequest, isTelegramUpdate } from "../src/index";

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

  it("returns a Telegram reply payload for webhook messages", async () => {
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
});
