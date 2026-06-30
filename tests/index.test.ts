import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearLogs,
  createTelegramResponse,
  handleRequest,
  handleScheduled,
  isTelegramUpdate,
  readLogs,
  recordLog,
  type Env,
} from "../src/index";
import {
  addReminder,
  createNewWallet,
  executeFinanceToolCall,
  getFinanceBalances,
  recordTransaction,
  type FinanceIntentType,
} from "../src/finance";
import {
  callAnthropicCompatible,
  callOpenAiCompatible,
  parseOpenAiToolCalls,
  parseProviders,
  selectProvider,
} from "../src/providers";
import { sendTelegramMessage } from "../src/telegram";

type MockD1Database = {
  rows: Array<{ id: number; at: string; event: string; detail?: string }>;
  accounts: Array<{ id: number; name: string; type: string }>;
  ledger: Array<{
    id: number;
    debit_account: string;
    credit_account: string;
    amount: number;
    description?: string;
    category?: string;
    person?: string;
    created_at: string;
  }>;
  reminders: Array<{
    id: number;
    person: string;
    amount: number;
    due_date: string;
    direction: string;
    is_paid: number;
    note?: string;
    reminded_at?: string;
    created_at: string;
  }>;
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<void>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
    all<T>(): Promise<{ results: T[] }>;
  };
};

function accountType(name: string): string {
  return name.split(":")[0].replace("assets", "asset").replace("liabilities", "liability").replace("expenses", "expense");
}

function createMockD1(): MockD1Database {
  const db: MockD1Database = {
    rows: [],
    accounts: [],
    ledger: [],
    reminders: [],
    prepare(query: string) {
      const statement = {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (query.startsWith("INSERT INTO logs")) {
                db.rows.push({
                  id: db.rows.length + 1,
                  at: String(values[0]),
                  event: String(values[1]),
                  detail: values[2] === null ? undefined : String(values[2]),
                });
              }
              if (query.startsWith("INSERT OR IGNORE INTO accounts")) {
                const name = String(values[0]);
                if (!db.accounts.some((account) => account.name === name)) {
                  db.accounts.push({ id: db.accounts.length + 1, name, type: String(values[1]) });
                }
              }
              if (query.startsWith("INSERT INTO ledger")) {
                db.ledger.push({
                  id: db.ledger.length + 1,
                  debit_account: String(values[0]),
                  credit_account: String(values[1]),
                  amount: Number(values[2]),
                  description: values[3] === null ? undefined : String(values[3]),
                  category: values[4] === null ? undefined : String(values[4]),
                  person: values[5] === null ? undefined : String(values[5]),
                  created_at: new Date().toISOString(),
                });
              }
              if (query.startsWith("INSERT INTO debt_reminders")) {
                db.reminders.push({
                  id: db.reminders.length + 1,
                  person: String(values[0]),
                  amount: Number(values[1]),
                  due_date: String(values[2]),
                  direction: String(values[3]),
                  is_paid: 0,
                  note: values[4] === null ? undefined : String(values[4]),
                  created_at: new Date().toISOString(),
                });
              }
              if (query.startsWith("UPDATE debt_reminders SET reminded_at")) {
                const reminder = db.reminders.find((item) => item.id === Number(values[0]));
                if (reminder) {
                  reminder.reminded_at = new Date().toISOString();
                }
              }
              if (query.startsWith("UPDATE debt_reminders SET is_paid")) {
                for (const reminder of db.reminders) {
                  if (reminder.person === String(values[0]) && (values.length === 1 || reminder.amount === Number(values[1]))) {
                    reminder.is_paid = 1;
                  }
                }
              }
            },
            async first<T>() {
              if (query.startsWith("SELECT name FROM accounts")) {
                return (db.accounts.find((account) => account.name === String(values[0])) ?? null) as T | null;
              }
              return null;
            },
            async all<T>() {
              return { results: runQuery(db, query, values) as T[] };
            },
          };
        },
        async all<T>() {
          return { results: runQuery(db, query, []) as T[] };
        },
      };
      return statement;
    },
  };

  return db;
}

function balanceFor(db: MockD1Database, account: string): number {
  return db.ledger.reduce((total, row) => {
    if (row.debit_account === account) {
      return total + row.amount;
    }
    if (row.credit_account === account) {
      return total - row.amount;
    }
    return total;
  }, 0);
}

function runQuery(db: MockD1Database, query: string, values: unknown[]): unknown[] {
  if (query.includes("FROM logs")) {
    return [...db.rows].reverse().slice(0, 100).reverse();
  }
  if (query.includes("FROM ledger") && query.includes("ORDER BY id DESC")) {
    return [...db.ledger].reverse().slice(0, Number(values[0] ?? 100));
  }
  if (query.includes("FROM debt_reminders") && query.includes("due_date <=")) {
    return db.reminders.filter((item) => item.due_date <= String(values[0]) && item.is_paid === 0 && !item.reminded_at);
  }
  if (query.includes("FROM debt_reminders")) {
    return query.includes("WHERE is_paid = 0") ? db.reminders.filter((item) => item.is_paid === 0) : db.reminders;
  }
  if (query.includes("assets:wallets")) {
    return db.accounts
      .filter((account) => account.name.startsWith("assets:wallets:"))
      .map((account) => ({ account: account.name, balance: balanceFor(db, account.name) }));
  }
  if (query.includes("assets:receivables") || query.includes("liabilities:payables")) {
    return db.accounts
      .filter((account) => account.name.startsWith("assets:receivables:") || account.name.startsWith("liabilities:payables:"))
      .map((account) => ({ account: account.name, balance: balanceFor(db, account.name) }))
      .filter((row) => row.balance !== 0);
  }
  if (query.includes("expenses:%") || query.includes("income:%")) {
    return db.accounts
      .filter((account) => account.name.startsWith("expenses:") || account.name.startsWith("income:"))
      .map((account) => ({ account: account.name, type: accountType(account.name), balance: balanceFor(db, account.name) }))
      .filter((row) => row.balance !== 0);
  }
  return [];
}

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
    const body = JSON.parse(String(calls[0].body));
    expect(body.model).toBe("model-id");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "Hi" });
    expect(body.messages[0].role).toBe("system");
    expect(body.tools[0].function.name).toBe("record_transaction");
    expect(body.tool_choice).toBe("auto");
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
    const body = JSON.parse(String(calls[0].body));
    expect(body.model).toBe("model-id");
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.system).toContain("finance parser");
    expect(body.tools[0].name).toBe("record_transaction");
  });
});

describe("finance ledger", () => {
  const matrix: Array<{
    intent_type: FinanceIntentType;
    wallet_name?: string;
    person?: string;
    category?: string;
    debit: string;
    credit: string;
  }> = [
    {
      intent_type: "expense",
      wallet_name: "gopay",
      category: "food",
      debit: "expenses:food",
      credit: "assets:wallets:gopay",
    },
    {
      intent_type: "income",
      wallet_name: "bank_mandiri",
      category: "salary",
      debit: "assets:wallets:bank_mandiri",
      credit: "income:salary",
    },
    {
      intent_type: "income_gift",
      person: "Haidar",
      category: "food",
      debit: "expenses:food",
      credit: "income:gift",
    },
    {
      intent_type: "debt_lend",
      wallet_name: "cash",
      person: "Helmi",
      category: "food",
      debit: "assets:receivables:helmi",
      credit: "assets:wallets:cash",
    },
    {
      intent_type: "debt_lend_collect",
      wallet_name: "gopay",
      person: "Helmi",
      debit: "assets:wallets:gopay",
      credit: "assets:receivables:helmi",
    },
    {
      intent_type: "debt_owe",
      person: "Helmi",
      category: "food",
      debit: "expenses:food",
      credit: "liabilities:payables:helmi",
    },
    {
      intent_type: "debt_owe_pay",
      wallet_name: "bank_mandiri",
      person: "Helmi",
      debit: "liabilities:payables:helmi",
      credit: "assets:wallets:bank_mandiri",
    },
    {
      intent_type: "debt_borrow",
      wallet_name: "cash",
      person: "Haidar",
      debit: "assets:wallets:cash",
      credit: "liabilities:payables:haidar",
    },
    {
      intent_type: "debt_borrow_pay",
      wallet_name: "cash",
      person: "Haidar",
      debit: "liabilities:payables:haidar",
      credit: "assets:wallets:cash",
    },
    {
      intent_type: "debt_loan",
      wallet_name: "gopay",
      person: "Helmi",
      debit: "assets:receivables:helmi",
      credit: "assets:wallets:gopay",
    },
    {
      intent_type: "debt_loan_collect",
      wallet_name: "cash",
      person: "Helmi",
      debit: "assets:wallets:cash",
      credit: "assets:receivables:helmi",
    },
  ];

  it("routes every finance intent to the expected double-entry accounts", async () => {
    for (const item of matrix) {
      const db = createMockD1();
      if (item.wallet_name) {
        await createNewWallet({ DB: db as unknown as D1Database }, { wallet_name: item.wallet_name, initial_balance: 0 });
      }

      await recordTransaction(
        { DB: db as unknown as D1Database },
        {
          intent_type: item.intent_type,
          amount: 12000,
          description: "naspad",
          wallet_name: item.wallet_name,
          person: item.person,
          category: item.category,
        },
      );

      const row = db.ledger[0];
      expect(row.debit_account).toBe(item.debit);
      expect(row.credit_account).toBe(item.credit);
      expect(row.amount).toBe(12000);
    }
  });

  it("returns a clarification instead of creating unknown wallets automatically", async () => {
    const db = createMockD1();
    const result = await recordTransaction(
      { DB: db as unknown as D1Database },
      {
        intent_type: "expense",
        amount: 10000,
        description: "bakso",
        wallet_name: "jagobank",
        category: "food",
      },
    );

    expect(result.text).toContain("I couldn't find a wallet named 'jagobank'");
    expect(db.accounts).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
  });

  it("formats wallet lookup tool results for Telegram replies", async () => {
    const db = createMockD1();
    const env = { DB: db as unknown as D1Database };
    await createNewWallet(env, { wallet_name: "cash_on_hand", initial_balance: 0 });
    await createNewWallet(env, { wallet_name: "kantong_utama", initial_balance: 6000000 });

    const result = await executeFinanceToolCall(env, "get_wallets", {});

    expect(result.text).toBe("Wallets:\n- cash_on_hand: 0\n- kantong_utama: 6.000.000");
  });

  it("formats debt summary tool results for Telegram replies", async () => {
    const db = createMockD1();
    const env = { DB: db as unknown as D1Database };
    await createNewWallet(env, { wallet_name: "cash", initial_balance: 50000 });
    await recordTransaction(env, {
      intent_type: "debt_lend",
      amount: 12000,
      description: "naspad",
      wallet_name: "cash",
      person: "Helmi",
      category: "food",
    });

    const result = await executeFinanceToolCall(env, "get_debts_summary", {});

    expect(result.text).toBe("Debts:\n- helmi: owes you 12.000");
  });

  it("computes balances from ledger rows", async () => {
    const db = createMockD1();
    const env = { DB: db as unknown as D1Database };
    await createNewWallet(env, { wallet_name: "cash", initial_balance: 50000 });
    await recordTransaction(env, {
      intent_type: "expense",
      amount: 10000,
      description: "bakso",
      wallet_name: "cash",
      category: "food",
    });
    await recordTransaction(env, {
      intent_type: "debt_lend",
      amount: 12000,
      description: "naspad",
      wallet_name: "cash",
      person: "Helmi",
      category: "food",
    });

    const balances = await getFinanceBalances(env);

    expect(balances.wallets[0]).toEqual({ account: "assets:wallets:cash", wallet: "cash", balance: 28000 });
    expect(balances.debts[0]).toEqual({ account: "assets:receivables:helmi", person: "helmi", direction: "lend", balance: 12000 });
    expect(balances.categories.find((item) => item.account === "expenses:food")?.balance).toBe(10000);
  });

  it("parses allowlisted OpenAI tool calls", () => {
    expect(
      parseOpenAiToolCalls([
        {
          function: {
            name: "record_transaction",
            arguments: JSON.stringify({ intent_type: "expense", amount: 10000, description: "bakso" }),
          },
        },
        { function: { name: "run_sql", arguments: "{}" } },
      ]),
    ).toEqual([
      {
        name: "record_transaction",
        arguments: { intent_type: "expense", amount: 10000, description: "bakso" },
      },
    ]);
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

  it("persists logs to d1 when bound", async () => {
    const db = createMockD1();
    const env: Env = {
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DB: db as unknown as D1Database,
    };

    await recordLog(env, "test_event", "detail");
    const logs = await readLogs(env);

    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("test_event");
    expect(db.rows[0].event).toBe("test_event");
  });

  it("serves protected finance endpoints", async () => {
    const db = createMockD1();
    const env: Env = { TELEGRAM_WEBHOOK_SECRET: "secret", DB: db as unknown as D1Database };
    await createNewWallet(env, { wallet_name: "cash", initial_balance: 50000 });
    await recordTransaction(env, {
      intent_type: "expense",
      amount: 10000,
      description: "bakso",
      wallet_name: "cash",
      category: "food",
    });
    await addReminder(env, { person: "Helmi", amount: 12000, due_date: "2026-06-26", direction: "owe" });

    expect(await handleRequest(new Request("https://example.com/finance/balances?token=wrong"), env)).toMatchObject({
      status: 401,
    });

    const balances = await handleRequest(new Request("https://example.com/finance/balances?token=secret"), env);
    expect(balances.status).toBe(200);
    expect((await balances.json()) as unknown).toMatchObject({
      wallets: [{ account: "assets:wallets:cash", wallet: "cash", balance: 40000 }],
    });

    const ledger = await handleRequest(new Request("https://example.com/finance/ledger?token=secret&limit=10"), env);
    expect(ledger.status).toBe(200);
    expect(((await ledger.json()) as { ledger: unknown[] }).ledger).toHaveLength(2);

    const reminders = await handleRequest(new Request("https://example.com/finance/reminders?token=secret"), env);
    expect(reminders.status).toBe(200);
    expect(((await reminders.json()) as { reminders: unknown[] }).reminders).toHaveLength(1);
  });

  it("executes finance tool calls from provider responses", async () => {
    const db = createMockD1();
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
    const env: Env = {
      TELEGRAM_WEBHOOK_SECRET: "secret",
      TELEGRAM_TOKEN: "telegram-token",
      PROVIDERS: providers,
      DB: db as unknown as D1Database,
    };
    await createNewWallet(env, { wallet_name: "cash", initial_balance: 50000 });

    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      if (String(url).includes("/chat/completions")) {
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_transaction",
                      arguments: JSON.stringify({
                        intent_type: "expense",
                        amount: 10000,
                        description: "bakso",
                        wallet_name: "cash",
                        category: "food",
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        });
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
          body: JSON.stringify({ message: { chat: { id: 123 }, text: "beli bakso 10k pake cash" } }),
        }),
        env,
        { waitUntil: (promise) => scheduled.push(promise) },
      );

      expect(response.status).toBe(200);
      await Promise.all(scheduled);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(db.ledger.at(-1)).toMatchObject({
      debit_account: "expenses:food",
      credit_account: "assets:wallets:cash",
      amount: 10000,
    });
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      chat_id: 123,
      text: "Recorded: bakso 10.000.",
    });

    const logs = await readLogs(env);
    const aiResponse = logs.find((log) => log.event === "ai_response");
    const toolCall = logs.find((log) => log.event === "tool_call");
    expect(aiResponse?.detail).toContain('"prompt_tokens":20');
    expect(toolCall?.detail).toContain('"wallet_name":"cash"');
  });

  it("executes wallet lookup tool calls from provider responses", async () => {
    const db = createMockD1();
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
    const env: Env = {
      TELEGRAM_WEBHOOK_SECRET: "secret",
      TELEGRAM_TOKEN: "telegram-token",
      PROVIDERS: providers,
      DB: db as unknown as D1Database,
    };
    await createNewWallet(env, { wallet_name: "cash_on_hand", initial_balance: 0 });
    await createNewWallet(env, { wallet_name: "kantong_utama", initial_balance: 6000000 });

    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      if (String(url).includes("/chat/completions")) {
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: "get_wallets", arguments: "null" } }],
              },
            },
          ],
        });
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
          body: JSON.stringify({ message: { chat: { id: 123 }, text: "Ada wallet apa saja" } }),
        }),
        env,
        { waitUntil: (promise) => scheduled.push(promise) },
      );

      expect(response.status).toBe(200);
      await Promise.all(scheduled);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      chat_id: 123,
      text: "Wallets:\n- cash_on_hand: 0\n- kantong_utama: 6.000.000",
    });
  });

  it("schedules due reminder notifications", async () => {
    const db = createMockD1();
    const env: Env = {
      TELEGRAM_WEBHOOK_SECRET: "secret",
      TELEGRAM_TOKEN: "telegram-token",
      TELEGRAM_REMINDER_CHAT_ID: "123",
      DB: db as unknown as D1Database,
    };
    await addReminder(env, { person: "Helmi", amount: 12000, due_date: "2026-06-25", direction: "owe" });

    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const scheduled: Promise<unknown>[] = [];
    try {
      await handleScheduled(
        { scheduledTime: Date.now(), cron: "0 1 * * *" },
        env,
        { waitUntil: (promise) => scheduled.push(promise) },
      );
      await Promise.all(scheduled);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      chat_id: "123",
      text: "Reminder: you owe helmi 12.000.",
    });
    expect(db.reminders[0].reminded_at).toBeString();
  });

  it("does not treat delete wallet requests as create wallet actions", async () => {
    const provider = {
      BASE_URL: "https://api.example.com/v1",
      NAME: "example-openai",
      TYPE: "OPENAI" as const,
      API_KEY: "provider-key",
      MODEL_ID: "model-id",
      MODEL_NAME: "Model Label",
    };
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      if (String(url).includes("/chat/completions")) {
        return Response.json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { function: { name: "create_new_wallet", arguments: JSON.stringify({ wallet_name: "kantong utama", initial_balance: 0 }) } },
                ],
              },
            },
          ],
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const result = await callOpenAiCompatible({ provider, message: "hapus wallet kantong utama" });
    globalThis.fetch = originalFetch;

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("create_new_wallet");
  });

  it("blocks wallet deletion requests before tool execution", async () => {
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
        throw new Error("should not call provider for delete requests");
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const response = await handleRequest(
        new Request("https://example.com/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "secret",
          },
          body: JSON.stringify({ message: { chat: { id: 123 }, text: "hapus wallet kantong utama" } }),
        }),
        { TELEGRAM_WEBHOOK_SECRET: "secret", TELEGRAM_TOKEN: "telegram-token", PROVIDERS: providers },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.map((call) => String(call.url))).toEqual(["https://api.telegram.org/bottelegram-token/sendMessage"]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      chat_id: 123,
      text: "Deleting wallets is not supported yet. Send 'lihat wallet' if you want the current list.",
    });
  });

  it("returns a command list with clickable keyboard", async () => {
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
        throw new Error("provider should not be called for /commands");
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const response = await handleRequest(
        new Request("https://example.com/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "secret",
          },
          body: JSON.stringify({ message: { chat: { id: 123 }, text: "/commands" } }),
        }),
        { TELEGRAM_WEBHOOK_SECRET: "secret", TELEGRAM_TOKEN: "telegram-token", PROVIDERS: providers },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        method: "sendMessage",
        chat_id: 123,
        parse_mode: "HTML",
        text: [
          "<b>💰 Finance</b>",
          "• <i>gajian 6jt ke kantong utama</i> — catat pemasukan",
          "• <i>beli bakso 10k pake cash</i> — catat pengeluaran",
          "• <i>lihat wallet</i> — cek saldo semua wallet",
          "• <i>Helmi pinjem 12k</i> — catat hutang",
          "",
          "<b>✅ Habits</b>",
          "• <i>buat habit olahraga setiap hari</i> — buat habit baru",
          "• <i>udah olahraga hari ini</i> — check in habit",
          "• <i>habits hari ini apa aja</i> — lihat status habit",
          "• <i>streak olahraga berapa</i> — lihat statistik streak",
          "",
          "<b>⚙️ Settings</b>",
          "• <i>/commands</i> — tampilkan bantuan ini",
          "• <i>/help</i> — tampilkan bantuan ini",
          "• <i>/start</i> — tampilkan bantuan ini",
        ].join("\n"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Cek saldo", callback_data: "get_wallets" }, { text: "💸 Cek hutang", callback_data: "get_debts" }],
            [{ text: "✅ Habits hari ini", callback_data: "get_habits_today" }],
          ],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(0);
  });

  it("returns the same keyboard help for /help and /start", async () => {
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
        throw new Error("provider should not be called for shortcut commands");
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      for (const command of ["/help", "/start"]) {
        const response = await handleRequest(
          new Request("https://example.com/webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Telegram-Bot-Api-Secret-Token": "secret",
            },
            body: JSON.stringify({ message: { chat: { id: 123 }, text: command } }),
          }),
          { TELEGRAM_WEBHOOK_SECRET: "secret", TELEGRAM_TOKEN: "telegram-token", PROVIDERS: providers },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          method: "sendMessage",
          chat_id: 123,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 Cek saldo", callback_data: "get_wallets" }, { text: "💸 Cek hutang", callback_data: "get_debts" }],
              [{ text: "✅ Habits hari ini", callback_data: "get_habits_today" }],
            ],
          },
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(0);
  });
});

import { habitTools, isHabitToolName } from "../src/habit-tools";
import { calculateStreak, wibDate, slug, formatHabitsToday, formatHabitStreak } from "../src/habits";
import type { HabitWithStatus } from "../src/habits";
import { reverseTransaction, editTransaction, getFilteredLedger, getPersonDebts } from "../src/finance";
import { listBudgets, upsertBudget, deleteBudget, computePeriodStart, slug as budgetSlug } from "../src/budgets";

describe("habit tools", () => {
  it("defines all four habit tool definitions", () => {
    const names = habitTools.map((tool) => tool.function.name);
    expect(names).toContain("create_habit");
    expect(names).toContain("checkin_habit");
    expect(names).toContain("get_habits_today");
    expect(names).toContain("get_habit_streak");
    expect(habitTools).toHaveLength(4);
  });

  it("isHabitToolName correctly identifies habit tools", () => {
    expect(isHabitToolName("create_habit")).toBe(true);
    expect(isHabitToolName("checkin_habit")).toBe(true);
    expect(isHabitToolName("get_habits_today")).toBe(true);
    expect(isHabitToolName("get_habit_streak")).toBe(true);
    expect(isHabitToolName("get_wallets")).toBe(false);
    expect(isHabitToolName("record_transaction")).toBe(false);
  });
});

describe("habit utilities", () => {
  it("slug normalizes names", () => {
    expect(slug("Olahraga Pagi")).toBe("olahraga_pagi");
    expect(slug("baca buku!")).toBe("baca_buku");
    expect(slug("  Meditation  ")).toBe("meditation");
  });

  it("wibDate returns YYYY-MM-DD format", () => {
    const date = wibDate();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("calculateStreak computes current and best streaks", () => {
    const today = "2026-06-29";
    const dates = ["2026-06-29", "2026-06-28", "2026-06-27", "2026-06-25"];
    const { current, best } = calculateStreak(dates, today);
    expect(current).toBe(3);
    expect(best).toBe(3);
  });

  it("calculateStreak returns 0 for empty dates", () => {
    const { current, best } = calculateStreak([], "2026-06-29");
    expect(current).toBe(0);
    expect(best).toBe(0);
  });

  it("calculateStreak handles non-consecutive gaps", () => {
    const today = "2026-06-29";
    const dates = ["2026-06-29", "2026-06-27", "2026-06-26"];
    const { current, best } = calculateStreak(dates, today);
    expect(current).toBe(1);
    expect(best).toBe(2);
  });

  it("formatHabitsToday formats habit list", () => {
    const habits: HabitWithStatus[] = [
      { id: 1, name: "olahraga", description: null, frequency: "daily", targetDays: null, checkedToday: true, currentStreak: 5, bestStreak: 10, completionThisMonth: 0.8 },
      { id: 2, name: "baca_buku", description: null, frequency: "daily", targetDays: null, checkedToday: false, currentStreak: 0, bestStreak: 3, completionThisMonth: 0.2 },
    ];
    const text = formatHabitsToday(habits);
    expect(text).toContain("✅ olahraga");
    expect(text).toContain("❌ baca_buku");
    expect(text).toContain("1/2 selesai");
  });

  it("formatHabitStreak formats streak info", () => {
    const habit: HabitWithStatus = {
      id: 1, name: "olahraga", description: null, frequency: "daily", targetDays: null,
      checkedToday: true, currentStreak: 7, bestStreak: 14, completionThisMonth: 0.9,
    };
    const text = formatHabitStreak(habit);
    expect(text).toContain("🔥 olahraga");
    expect(text).toContain("Streak sekarang: 7 hari");
    expect(text).toContain("Streak terbaik: 14 hari");
    expect(text).toContain("%");
  });
});

describe("budget utilities", () => {
  it("budgetSlug normalizes category names", () => {
    expect(budgetSlug("Makanan & Minuman")).toBe("makanan_minuman");
    expect(budgetSlug("Transport")).toBe("transport");
  });

  it("computePeriodStart returns correct start for monthly", () => {
    const now = new Date("2026-06-15T10:00:00Z");
    const start = computePeriodStart("monthly", now);
    expect(start).toBe("2026-06-01");
  });

  it("computePeriodStart returns correct start for weekly", () => {
    const now = new Date("2026-06-29T10:00:00Z");
    const start = computePeriodStart("weekly", now);
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("finance reversal and filtering", () => {
  it("reverseTransaction throws for non-existent id", async () => {
    const db = createMockD1();
    await expect(reverseTransaction({ DB: db } as never, 9999)).rejects.toThrow("not found");
  });

  it("getFilteredLedger returns paginated results", async () => {
    const db = createMockD1();
    const result = await getFilteredLedger({ DB: db } as never, {}, 1, 20);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("getPersonDebts returns settled state for unknown person", async () => {
    const db = createMockD1();
    const result = await getPersonDebts({ DB: db } as never, "unknown");
    expect(result.person).toBe("unknown");
    expect(result.receivable).toBe(0);
    expect(result.payable).toBe(0);
    expect(result.net).toBe(0);
    expect(result.direction).toBe("settled");
    expect(result.transactions).toEqual([]);
  });
});
