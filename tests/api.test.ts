import { describe, expect, it } from "bun:test";
import { handleRequest, type Env } from "../src/index";
import { handleApiRequest, parseSeededAccounts, withPagination, camelizeValue, type AuthEnv } from "../src/api";

type AuthAccount = {
  id: number;
  email: string;
  name: string;
  role: string;
  password_hash: string;
  password_salt: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

type Session = {
  id: number;
  account_id: number;
  access_token_hash: string;
  refresh_token_hash: string;
  access_expires_at: string;
  refresh_expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

type LedgerRow = {
  id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  description?: string | null;
  category?: string | null;
  person?: string | null;
  created_at: string;
};

type MockDb = {
  authAccounts: AuthAccount[];
  authSessions: Session[];
  accounts: Array<{ name: string; type: string }>;
  ledger: LedgerRow[];
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<void>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
  };
};

function accountType(name: string): string {
  if (name.startsWith("assets:")) return "asset";
  if (name.startsWith("liabilities:")) return "liability";
  if (name.startsWith("expenses:")) return "expense";
  if (name.startsWith("income:")) return "income";
  return "other";
}

function createMockDb(): MockDb {
  const db: MockDb = {
    authAccounts: [],
    authSessions: [],
    accounts: [],
    ledger: [],
    prepare(query: string) {
      const readAuthAccount = (values: unknown[]) => {
        if (query.includes("WHERE email = ?")) {
          return db.authAccounts.find((row) => row.email === String(values[0])) ?? null;
        }
        if (query.includes("WHERE id = ?")) {
          return db.authAccounts.find((row) => row.id === Number(values[0])) ?? null;
        }
        return null;
      };

      const statement = {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (query.startsWith("INSERT OR IGNORE INTO auth_accounts")) {
                const email = String(values[0]);
                if (!db.authAccounts.some((row) => row.email === email)) {
                  db.authAccounts.push({
                    id: db.authAccounts.length + 1,
                    email,
                    name: String(values[1]),
                    role: String(values[2]),
                    password_hash: String(values[3]),
                    password_salt: String(values[4]),
                    is_active: 1,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  });
                }
              }

              if (query.startsWith("INSERT INTO auth_sessions")) {
                db.authSessions.push({
                  id: db.authSessions.length + 1,
                  account_id: Number(values[0]),
                  access_token_hash: String(values[1]),
                  refresh_token_hash: String(values[2]),
                  access_expires_at: String(values[3]),
                  refresh_expires_at: String(values[4]),
                  revoked_at: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  last_used_at: null,
                });
              }

              if (query.startsWith("UPDATE auth_sessions")) {
                const session = db.authSessions.find((row) => row.id === Number(values.at(-1)));
                if (session) {
                  if (query.includes("revoked_at = CURRENT_TIMESTAMP")) {
                    session.revoked_at = new Date().toISOString();
                  }
                  if (query.includes("access_token_hash = ?")) {
                    session.access_token_hash = String(values[0]);
                    session.refresh_token_hash = String(values[1]);
                    session.access_expires_at = String(values[2]);
                    session.refresh_expires_at = String(values[3]);
                  }
                  session.updated_at = new Date().toISOString();
                  if (query.includes("last_used_at = CURRENT_TIMESTAMP")) {
                    session.last_used_at = new Date().toISOString();
                  }
                }
              }

              if (query.startsWith("INSERT INTO ledger")) {
                db.ledger.push({
                  id: db.ledger.length + 1,
                  debit_account: String(values[0]),
                  credit_account: String(values[1]),
                  amount: Number(values[2]),
                  description: values[3] === null ? null : String(values[3]),
                  category: values[4] === null ? null : String(values[4]),
                  person: values[5] === null ? null : String(values[5]),
                  created_at: new Date().toISOString(),
                });
              }

              if (query.startsWith("INSERT OR IGNORE INTO accounts")) {
                const name = String(values[0]);
                if (!db.accounts.some((row) => row.name === name)) {
                  db.accounts.push({ name, type: String(values[1]) });
                }
              }
            },
            async first<T>() {
              if (query.includes("FROM auth_accounts")) {
                return readAuthAccount(values) as T | null;
              }
              if (query.includes("FROM auth_sessions") && query.includes("access_token_hash = ?")) {
                const session = db.authSessions.find((row) => row.access_token_hash === String(values[0]) && !row.revoked_at);
                return (session ?? null) as T | null;
              }
              if (query.includes("FROM auth_sessions") && query.includes("refresh_token_hash = ?")) {
                const session = db.authSessions.find((row) => row.refresh_token_hash === String(values[0]) && !row.revoked_at);
                return (session ?? null) as T | null;
              }
              if (query.startsWith("SELECT COUNT(*) AS total FROM auth_accounts")) {
                return { total: db.authAccounts.length } as T;
              }
              if (query.startsWith("SELECT COUNT(*) AS total FROM ledger")) {
                return { total: db.ledger.length } as T;
              }
              if (query.startsWith("SELECT created_at FROM ledger ORDER BY id DESC LIMIT 1")) {
                return (db.ledger.at(-1) ? { created_at: db.ledger.at(-1)!.created_at } : null) as T | null;
              }
              return null;
            },
            async all<T>() {
              if (query.includes("FROM auth_accounts") && query.includes("ORDER BY id ASC")) {
                const start = Number(values.at(-2) ?? 20);
                const offset = Number(values.at(-1) ?? 0);
                return { results: db.authAccounts.slice(offset, offset + start) as T[] };
              }
              if (query.includes("FROM ledger") && query.includes("ORDER BY id DESC")) {
                const limit = Number(values[0] ?? 20);
                const offset = Number(values[1] ?? 0);
                return { results: [...db.ledger].reverse().slice(offset, offset + limit) as T[] };
              }
              if (query.includes("FROM accounts a") && query.includes("assets:wallets:%")) {
                return {
                  results: db.accounts.filter((row) => row.name.startsWith("assets:wallets:")).map((row) => ({
                    account: row.name,
                    wallet: row.name.replace("assets:wallets:", ""),
                    balance: db.ledger.reduce((total, item) => {
                      if (item.debit_account === row.name) return total + item.amount;
                      if (item.credit_account === row.name) return total - item.amount;
                      return total;
                    }, 0),
                  })) as T[],
                };
              }
              if (query.includes("FROM accounts a") && (query.includes("assets:receivables:%") || query.includes("liabilities:payables:%"))) {
                return {
                  results: db.accounts
                    .filter((row) => row.name.startsWith("assets:receivables:") || row.name.startsWith("liabilities:payables:"))
                    .map((row) => ({
                      account: row.name,
                      person: row.name.replace("assets:receivables:", "").replace("liabilities:payables:", ""),
                      direction: row.name.startsWith("assets:receivables:") ? "lend" : "owe",
                      balance: Math.abs(
                        db.ledger.reduce((total, item) => {
                          if (item.debit_account === row.name) return total + item.amount;
                          if (item.credit_account === row.name) return total - item.amount;
                          return total;
                        }, 0),
                      ),
                    })) as T[],
                };
              }
              if (query.includes("FROM accounts a") && (query.includes("expenses:%") || query.includes("income:%"))) {
                return {
                  results: db.accounts
                    .filter((row) => row.name.startsWith("expenses:") || row.name.startsWith("income:"))
                    .map((row) => ({
                      account: row.name,
                      category: row.name.replace("expenses:", "").replace("income:", ""),
                      type: accountType(row.name),
                      balance: Math.abs(
                        db.ledger.reduce((total, item) => {
                          if (item.debit_account === row.name) return total + item.amount;
                          if (item.credit_account === row.name) return total - item.amount;
                          return total;
                        }, 0),
                      ),
                    })) as T[],
                };
              }
              return { results: [] as T[] };
            },
          };
        },
        async first<T>() {
          return statement.bind().first<T>();
        },
        async all<T>() {
          return statement.bind().all<T>();
        },
      };
      return statement;
    },
  };

  return db;
}

function createEnv(): AuthEnv & { DB: D1Database } {
  return {
    DB: createMockDb() as unknown as D1Database,
    AUTH_SEEDED_ACCOUNTS: JSON.stringify([{ email: "owner@example.com", password: "secret123", name: "Owner", role: "admin" }]),
  };
}

describe("api contract", () => {
  it("camelizes nested response keys and pagination payloads", () => {
    expect(camelizeValue({ access_token: "abc", nested_value: [{ created_at: "now" }] })).toEqual({
      accessToken: "abc",
      nestedValue: [{ createdAt: "now" }],
    });

    expect(withPagination([1, 2], 2, 10, 12)).toEqual({ items: [1, 2], page: 2, pageSize: 10, total: 12, totalPages: 2 });
  });

  it("parses seeded account definitions", () => {
    expect(parseSeededAccounts("[{\"email\":\"a@example.com\",\"password\":\"p\"}]")).toEqual([
      { email: "a@example.com", password: "p", name: "a@example.com", role: "member" },
    ]);
  });

  it("supports login me refresh logout and dashboard endpoints", async () => {
    const env = createEnv();

    const login = await handleApiRequest(
      new Request("https://example.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "secret123" }),
      }),
      env,
    );

    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { accessToken: string; refreshToken: string; account: { email: string } };
    expect(loginBody.account.email).toBe("owner@example.com");

    const me = await handleApiRequest(
      new Request("https://example.com/api/me", {
        headers: { authorization: `Bearer ${loginBody.accessToken}` },
      }),
      env,
    );
    expect(me.status).toBe(200);
    expect((await me.json()) as { account: { email: string } }).toMatchObject({ account: { email: "owner@example.com" } });

    const refresh = await handleApiRequest(
      new Request("https://example.com/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
      }),
      env,
    );
    expect(refresh.status).toBe(200);
    const refreshBody = (await refresh.json()) as { accessToken: string; refreshToken: string };
    expect(refreshBody.accessToken).not.toBe(loginBody.accessToken);

    const logout = await handleApiRequest(
      new Request("https://example.com/api/auth/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${refreshBody.accessToken}` },
      }),
      env,
    );
    expect(logout.status).toBe(204);

    const dashboard = await handleApiRequest(
      new Request("https://example.com/api/dashboard", {
        headers: { authorization: `Bearer ${refreshBody.accessToken}` },
      }),
      env,
    );
    expect(dashboard.status).toBe(401);
  });

  it("returns camelCase list and statistics payloads for finance and accounts", async () => {
    const env = createEnv();
    const db = env.DB as unknown as MockDb;
    db.accounts.push({ name: "assets:wallets:cash", type: "asset" }, { name: "expenses:food", type: "expense" });
    db.ledger.push({
      id: 1,
      debit_account: "expenses:food",
      credit_account: "assets:wallets:cash",
      amount: 10000,
      description: "bakso",
      category: "food",
      person: null,
      created_at: new Date().toISOString(),
    });

    const login = await handleApiRequest(
      new Request("https://example.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "secret123" }),
      }),
      env,
    );
    const { accessToken } = (await login.json()) as { accessToken: string };

    const summary = await handleApiRequest(new Request("https://example.com/api/finance/summary", { headers: { authorization: `Bearer ${accessToken}` } }), env);
    expect(summary.status).toBe(200);
    expect((await summary.json()) as { summary: { wallets: Array<{ wallet: string; balance: number }> } }).toMatchObject({
      summary: { wallets: [{ wallet: "cash", balance: -10000 }] },
    });

    const list = await handleApiRequest(new Request("https://example.com/api/finance/list?page=1&pageSize=10", { headers: { authorization: `Bearer ${accessToken}` } }), env);
    expect(list.status).toBe(200);
    expect((await list.json()) as { items: unknown[]; total: number }).toMatchObject({ total: 1 });

    const stats = await handleApiRequest(new Request("https://example.com/api/finance/statistics", { headers: { authorization: `Bearer ${accessToken}` } }), env);
    expect(stats.status).toBe(200);
    expect((await stats.json()) as { statistics: { transactionCount: number } }).toMatchObject({ statistics: { transactionCount: 1 } });

    const accounts = await handleApiRequest(new Request("https://example.com/api/accounts", { headers: { authorization: `Bearer ${accessToken}` } }), env);
    expect(accounts.status).toBe(200);
    const accountsBody = (await accounts.json()) as { items: Array<{ email: string }>; page: number; pageSize: number };
    expect(accountsBody.items[0].email).toBe("owner@example.com");
    expect(accountsBody.pageSize).toBe(20);
  });

  it("protects OpenAPI with seeded account credentials", async () => {
    const env: Env = {
      TELEGRAM_WEBHOOK_SECRET: "secret",
      AUTH_SEEDED_ACCOUNTS: JSON.stringify([{ email: "owner@example.com", password: "secret123", name: "Owner", role: "admin" }]),
    };

    const denied = await handleRequest(new Request("https://example.com/openapi.json"), env);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe('Basic realm="OpenAPI"');

    const wrongPassword = btoa("owner@example.com:wrong");
    const rejected = await handleRequest(new Request("https://example.com/openapi.json", { headers: { authorization: `Basic ${wrongPassword}` } }), env);
    expect(rejected.status).toBe(401);

    const credentials = btoa("owner@example.com:secret123");
    const response = await handleRequest(new Request("https://example.com/openapi.json", { headers: { authorization: `Basic ${credentials}` } }), env);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { openapi: string; paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/api/auth/login"]).toBeDefined();
    expect(spec.paths["/api/finance/list"]).toBeDefined();
    expect(spec.components.securitySchemes.basicAuth).toEqual({ type: "http", scheme: "basic" });
  });
});
