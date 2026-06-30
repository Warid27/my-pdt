import { getFinanceBalances, getFilteredLedger, reverseTransaction, editTransaction, getPersonDebts } from "./finance";
import type { LedgerFilter } from "./finance";
import { listBudgets, upsertBudget, deleteBudget } from "./budgets";
import type { BudgetPeriod } from "./budgets";
import {
  createHabit,
  deleteHabit,
  getHabitsWithStatus,
  getHabitById,
  getCheckinHistory,
  checkinHabit,
  updateHabit,
  wibDate,
} from "./habits";
import type { HabitFrequency } from "./habits";

const accessTokenLifetimeMs = 15 * 60 * 1000;
const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const maxPageSize = 100;

type SeededAccountInput = {
  email: string;
  password: string;
  name?: string;
  role?: string;
};

type AuthEnv = {
  DB?: D1Database;
  AUTH_SEEDED_ACCOUNTS?: string;
};

type AuthAccountRow = {
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

type AuthSessionRow = {
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

type ApiAccount = {
  id: number;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
};

type AuthenticatedAccount = {
  id: number;
  email: string;
  name: string;
  role: string;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type PaginatedResponse<T> = Pagination & {
  items: T[];
};

type ApiFinanceItem = {
  id: number;
  debitAccount: string;
  creditAccount: string;
  amount: number;
  description?: string | null;
  category?: string | null;
  person?: string | null;
  createdAt: string;
};

type ApiRequestContext = {
  account: AuthenticatedAccount;
};

type FinanceStats = {
  transactionCount: number;
  walletCount: number;
  debtCount: number;
  categoryCount: number;
  totalWalletBalance: number;
  totalReceivables: number;
  totalPayables: number;
  totalIncome: number;
  totalExpense: number;
  netWorth: number;
  latestTransactionAt: string | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function camelizeKey(value: string): string {
  return value.replace(/_([a-z0-9])/gi, (_match, group1: string) => group1.toUpperCase());
}

function camelizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => camelizeValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [camelizeKey(key), camelizeValue(item)]),
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(camelizeValue(body), init);
}

function errorResponse(message: string, status: number, code: string): Response {
  return jsonResponse({ error: { code, message } }, { status });
}

function parseJsonBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

function parsePagination(url: URL, defaultPageSize = 20): Pagination {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(url.searchParams.get("pageSize") ?? defaultPageSize) || defaultPageSize));
  return { page, pageSize, total: 0, totalPages: 0 };
}

function withPagination<T>(items: T[], page: number, pageSize: number, total: number): PaginatedResponse<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  return { items, page, pageSize, total, totalPages };
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256(`${salt}:${password}`);
}

async function hashToken(token: string): Promise<string> {
  return sha256(token);
}

function parseSeededAccounts(value?: string): SeededAccountInput[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const account = item as Record<string, unknown>;
    if (!isNonEmptyString(account.email) || !isNonEmptyString(account.password)) {
      return [];
    }

    return [
      {
        email: account.email.trim().toLowerCase(),
        password: account.password,
        name: isNonEmptyString(account.name) ? account.name.trim() : account.email.trim(),
        role: isNonEmptyString(account.role) ? account.role.trim() : "member",
      },
    ];
  });
}

async function ensureSeededAccounts(env: AuthEnv): Promise<void> {
  const db = env.DB;
  if (!db) {
    return;
  }

  const seededAccounts = parseSeededAccounts(env.AUTH_SEEDED_ACCOUNTS);
  for (const account of seededAccounts) {
    const salt = (await sha256(`seed:${account.email}`)).slice(0, 32);
    const passwordHash = await hashPassword(account.password, salt);
    await db
      .prepare(
        `INSERT OR IGNORE INTO auth_accounts (email, name, role, password_hash, password_salt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(account.email, account.name ?? account.email, account.role ?? "member", passwordHash, salt)
      .run();
  }
}

async function findAccountByEmail(db: D1Database, email: string): Promise<AuthAccountRow | null> {
  return db
    .prepare(
      `SELECT id, email, name, role, password_hash, password_salt, is_active, created_at, updated_at
       FROM auth_accounts
       WHERE email = ?
       LIMIT 1`,
    )
    .bind(email.trim().toLowerCase())
    .first<AuthAccountRow>();
}

async function findAccountById(db: D1Database, id: number): Promise<AuthAccountRow | null> {
  return db
    .prepare(
      `SELECT id, email, name, role, password_hash, password_salt, is_active, created_at, updated_at
       FROM auth_accounts
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(id)
    .first<AuthAccountRow>();
}

function accountToApi(account: AuthAccountRow): ApiAccount {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

async function authenticatePassword(account: AuthAccountRow, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password, account.password_salt);
  return passwordHash === account.password_hash;
}

function sessionExpiry(now: number, lifetimeMs: number): string {
  return new Date(now + lifetimeMs).toISOString();
}

async function createAuthSession(
  env: AuthEnv,
  accountId: number,
): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string }> {
  const db = env.DB;
  if (!db) {
    throw new Error("D1 DB binding is required for auth features");
  }

  const accessToken = generateToken();
  const refreshToken = generateToken();
  const now = Date.now();
  const accessTokenHash = await hashToken(accessToken);
  const refreshTokenHash = await hashToken(refreshToken);
  const accessTokenExpiresAt = sessionExpiry(now, accessTokenLifetimeMs);
  const refreshTokenExpiresAt = sessionExpiry(now, refreshTokenLifetimeMs);

  await db
    .prepare(
      `INSERT INTO auth_sessions (
        account_id,
        access_token_hash,
        refresh_token_hash,
        access_expires_at,
        refresh_expires_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(accountId, accessTokenHash, refreshTokenHash, accessTokenExpiresAt, refreshTokenExpiresAt)
    .run();

  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
}

async function rotateAuthSession(
  env: AuthEnv,
  session: AuthSessionRow,
): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string }> {
  const db = env.DB;
  if (!db) {
    throw new Error("D1 DB binding is required for auth features");
  }

  const accessToken = generateToken();
  const refreshToken = generateToken();
  const now = Date.now();
  const accessTokenHash = await hashToken(accessToken);
  const refreshTokenHash = await hashToken(refreshToken);
  const accessTokenExpiresAt = sessionExpiry(now, accessTokenLifetimeMs);
  const refreshTokenExpiresAt = sessionExpiry(now, refreshTokenLifetimeMs);

  await db
    .prepare(
      `UPDATE auth_sessions
       SET access_token_hash = ?,
           refresh_token_hash = ?,
           access_expires_at = ?,
           refresh_expires_at = ?,
           revoked_at = NULL,
           updated_at = CURRENT_TIMESTAMP,
           last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(accessTokenHash, refreshTokenHash, accessTokenExpiresAt, refreshTokenExpiresAt, session.id)
    .run();

  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
}

async function findSessionByAccessToken(db: D1Database, accessToken: string): Promise<AuthSessionRow | null> {
  const accessTokenHash = await hashToken(accessToken);
  return db
    .prepare(
      `SELECT
        id,
        account_id,
        access_token_hash,
        refresh_token_hash,
        access_expires_at,
        refresh_expires_at,
        revoked_at,
        created_at,
        updated_at,
        last_used_at
       FROM auth_sessions
       WHERE access_token_hash = ?
         AND revoked_at IS NULL
         AND access_expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
    )
    .bind(accessTokenHash)
    .first<AuthSessionRow>();
}

async function findSessionByRefreshToken(db: D1Database, refreshToken: string): Promise<AuthSessionRow | null> {
  const refreshTokenHash = await hashToken(refreshToken);
  return db
    .prepare(
      `SELECT
        id,
        account_id,
        access_token_hash,
        refresh_token_hash,
        access_expires_at,
        refresh_expires_at,
        revoked_at,
        created_at,
        updated_at,
        last_used_at
       FROM auth_sessions
       WHERE refresh_token_hash = ?
         AND revoked_at IS NULL
         AND refresh_expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
    )
    .bind(refreshTokenHash)
    .first<AuthSessionRow>();
}

async function authenticateRequest(request: Request, env: AuthEnv): Promise<ApiRequestContext | Response> {
  const db = env.DB;
  if (!db) {
    return errorResponse("Authentication requires a D1 database binding", 500, "authUnavailable");
  }

  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return errorResponse("Missing bearer access token", 401, "unauthorized");
  }

  await ensureSeededAccounts(env);
  const session = await findSessionByAccessToken(db, token);
  if (!session) {
    return errorResponse("Invalid or expired access token", 401, "unauthorized");
  }

  const account = await findAccountById(db, session.account_id);
  if (!account) {
    return errorResponse("Account is inactive", 403, "forbidden");
  }

  await db
    .prepare("UPDATE auth_sessions SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(session.id)
    .run();

  return {
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role,
    },
  };
}

async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  await ensureSeededAccounts(env);
  const db = env.DB;
  if (!db) {
    return errorResponse("Authentication requires a D1 database binding", 500, "authUnavailable");
  }

  const body = await parseJsonBody<{ email?: string; password?: string }>(request).catch(() => ({}));
  if (!isNonEmptyString(body.email) || !isNonEmptyString(body.password)) {
    return errorResponse("email and password are required", 400, "invalidRequest");
  }

  const account = await findAccountByEmail(db, body.email);
  if (!account || !account.is_active || !(await authenticatePassword(account, body.password))) {
    return errorResponse("Invalid email or password", 401, "unauthorized");
  }

  const session = await createAuthSession(env, account.id);
  return jsonResponse({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    account: accountToApi(account),
  });
}

async function handleRefresh(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const db = env.DB;
  if (!db) {
    return errorResponse("Authentication requires a D1 database binding", 500, "authUnavailable");
  }

  const body = await parseJsonBody<{ refreshToken?: string }>(request).catch(() => ({}));
  if (!isNonEmptyString(body.refreshToken)) {
    return errorResponse("refreshToken is required", 400, "invalidRequest");
  }

  await ensureSeededAccounts(env);
  const session = await findSessionByRefreshToken(db, body.refreshToken);
  if (!session) {
    return errorResponse("Invalid or expired refresh token", 401, "unauthorized");
  }

  const rotated = await rotateAuthSession(env, session);
  const account = await findAccountById(db, session.account_id);
  if (!account) {
    return errorResponse("Account not found", 404, "notFound");
  }

  return jsonResponse({
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    accessTokenExpiresAt: rotated.accessTokenExpiresAt,
    refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
    account: accountToApi(account),
  });
}

async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const db = env.DB;
  if (!db) {
    return errorResponse("Authentication requires a D1 database binding", 500, "authUnavailable");
  }

  const body = await parseJsonBody<{ refreshToken?: string }>(request).catch(() => ({}));
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const bearerToken = header?.match(/^Bearer\s+(.+)$/i)?.[1];

  await ensureSeededAccounts(env);

  if (isNonEmptyString(body.refreshToken)) {
    const session = await findSessionByRefreshToken(db, body.refreshToken);
    if (session) {
      await db
        .prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(session.id)
        .run();
    }
    return new Response(null, { status: 204 });
  }

  if (bearerToken) {
    const session = await findSessionByAccessToken(db, bearerToken);
    if (session) {
      await db
        .prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(session.id)
        .run();
    }
    return new Response(null, { status: 204 });
  }

  return errorResponse("refreshToken or bearer access token is required", 400, "invalidRequest");
}

async function paginateAccounts(env: AuthEnv, pagination: Pagination, search?: string): Promise<PaginatedResponse<ApiAccount>> {
  const db = env.DB;
  if (!db) {
    throw new Error("D1 DB binding is required for account APIs");
  }

  await ensureSeededAccounts(env);
  const searchTerm = isNonEmptyString(search) ? `%${search.trim().toLowerCase()}%` : null;
  const whereClause = searchTerm ? "WHERE LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR LOWER(role) LIKE ?" : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM auth_accounts ${whereClause}`)
    .bind(...(searchTerm ? [searchTerm, searchTerm, searchTerm] : []))
    .first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const offset = (pagination.page - 1) * pagination.pageSize;
  const rows = await db
    .prepare(
      `SELECT id, email, name, role, password_hash, password_salt, is_active, created_at, updated_at
       FROM auth_accounts
       ${whereClause}
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...(searchTerm ? [searchTerm, searchTerm, searchTerm] : []), pagination.pageSize, offset)
    .all<AuthAccountRow>();

  return withPagination(rows.results.map(accountToApi), pagination.page, pagination.pageSize, total);
}

async function handleAccounts(request: Request, env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const url = new URL(request.url);
  if (url.pathname === "/api/accounts") {
    const pagination = parsePagination(url, 20);
    const result = await paginateAccounts(env, pagination, url.searchParams.get("search") ?? undefined);
    return jsonResponse(result);
  }

  const accountIdMatch = url.pathname.match(/^\/api\/accounts\/(\d+)$/);
  if (accountIdMatch) {
    const db = env.DB;
    if (!db) {
      return errorResponse("Account APIs require a D1 database binding", 500, "authUnavailable");
    }

    const account = await findAccountById(db, Number(accountIdMatch[1]));
    if (!account) {
      return errorResponse("Account not found", 404, "notFound");
    }

    return jsonResponse({ account: accountToApi(account) });
  }

  return errorResponse("Not found", 404, "notFound");
}

async function countFinanceRows(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM ledger").first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function getLedgerPage(env: AuthEnv, page: number, pageSize: number): Promise<PaginatedResponse<ApiFinanceItem>> {
  const db = env.DB;
  if (!db) {
    throw new Error("Finance APIs require a D1 database binding");
  }

  const total = await countFinanceRows(db);
  const offset = (page - 1) * pageSize;
  const rows = await db
    .prepare(
      `SELECT id, debit_account, credit_account, amount, description, category, person, created_at
       FROM ledger
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(pageSize, offset)
    .all<{
      id: number;
      debit_account: string;
      credit_account: string;
      amount: number;
      description?: string | null;
      category?: string | null;
      person?: string | null;
      created_at: string;
    }>();

  return withPagination(
    rows.results.map((row) => ({
      id: row.id,
      debitAccount: row.debit_account,
      creditAccount: row.credit_account,
      amount: row.amount,
      description: row.description ?? null,
      category: row.category ?? null,
      person: row.person ?? null,
      createdAt: row.created_at,
    })),
    page,
    pageSize,
    total,
  );
}

async function getFinanceStats(env: AuthEnv): Promise<FinanceStats> {
  const summary = await getFinanceBalances(env);
  const db = env.DB;
  if (!db) {
    throw new Error("Finance APIs require a D1 database binding");
  }

  const transactionCount = await countFinanceRows(db);
  const latestRow = await db
    .prepare("SELECT created_at FROM ledger ORDER BY id DESC LIMIT 1")
    .first<{ created_at: string }>();
  const totalWalletBalance = summary.wallets.reduce((total, item) => total + item.balance, 0);
  const totalReceivables = summary.debts.filter((item) => item.direction === "lend").reduce((total, item) => total + item.balance, 0);
  const totalPayables = summary.debts.filter((item) => item.direction === "owe").reduce((total, item) => total + item.balance, 0);
  const totalIncome = summary.categories.filter((item) => item.type === "income").reduce((total, item) => total + item.balance, 0);
  const totalExpense = summary.categories.filter((item) => item.type === "expense").reduce((total, item) => total + item.balance, 0);

  return {
    transactionCount,
    walletCount: summary.wallets.length,
    debtCount: summary.debts.length,
    categoryCount: summary.categories.length,
    totalWalletBalance,
    totalReceivables,
    totalPayables,
    totalIncome,
    totalExpense,
    netWorth: totalWalletBalance + totalReceivables - totalPayables,
    latestTransactionAt: latestRow?.created_at ?? null,
  };
}

async function handleFinanceSummary(env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  return jsonResponse({ summary: await getFinanceBalances(env) });
}

async function handleFinanceList(request: Request, env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  const url = new URL(request.url);
  const pagination = parsePagination(url, 20);

  const filter: LedgerFilter = {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    wallet: url.searchParams.get("wallet") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    person: url.searchParams.get("person") ?? undefined,
    includeReversed: url.searchParams.get("includeReversed") === "true",
  };

  try {
    const result = await getFilteredLedger(env, filter, pagination.page, pagination.pageSize);
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid filter";
    return errorResponse(message, 400, "invalidRequest");
  }
}

async function handleFinanceEdit(request: Request, env: AuthEnv, context: ApiRequestContext, id: number): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "PATCH") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const body = await parseJsonBody<{ amount?: number; description?: string; category?: string }>(request).catch(() => ({}));

  try {
    const result = await editTransaction(env, id, body);
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Edit failed";
    if (message.includes("not found")) {
      return errorResponse(message, 404, "notFound");
    }
    if (message.includes("already reversed")) {
      return errorResponse(message, 409, "conflict");
    }
    return errorResponse(message, 400, "invalidRequest");
  }
}

async function handleFinanceDelete(request: Request, env: AuthEnv, context: ApiRequestContext, id: number): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "DELETE") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  try {
    const result = await reverseTransaction(env, id);
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed";
    if (message.includes("not found")) {
      return errorResponse(message, 404, "notFound");
    }
    if (message.includes("already reversed")) {
      return errorResponse(message, 409, "conflict");
    }
    return errorResponse(message, 400, "invalidRequest");
  }
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(rows: { id: number; created_at: string; description: string | null; amount: number; debit_account: string; credit_account: string; person: string | null; category: string | null }[]): string {
  const headers = ["id", "date", "description", "amount", "type", "debit_account", "credit_account", "person", "category"];
  const lines = [headers.join(",")];

  for (const row of rows) {
    let type = "transaction";
    if (row.debit_account.startsWith("expenses:")) {
      type = "expense";
    } else if (row.credit_account.startsWith("income:")) {
      type = "income";
    } else if (row.debit_account.startsWith("assets:receivables:") || row.credit_account.startsWith("assets:receivables:") || row.debit_account.startsWith("liabilities:payables:") || row.credit_account.startsWith("liabilities:payables:")) {
      type = "debt";
    }

    const values = [
      String(row.id),
      row.created_at,
      escapeCsvField(row.description ?? ""),
      String(row.amount),
      type,
      escapeCsvField(row.debit_account),
      escapeCsvField(row.credit_account),
      escapeCsvField(row.person ?? ""),
      escapeCsvField(row.category ?? ""),
    ];
    lines.push(values.join(","));
  }

  return lines.join("\r\n");
}

async function handleCsvExport(request: Request, env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  const url = new URL(request.url);
  const filter: LedgerFilter = {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    wallet: url.searchParams.get("wallet") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    person: url.searchParams.get("person") ?? undefined,
    includeReversed: url.searchParams.get("includeReversed") === "true",
  };

  try {
    const result = await getFilteredLedger(env, filter, 1, 10000);
    const csv = buildCsv(result.items as unknown as { id: number; created_at: string; description: string | null; amount: number; debit_account: string; credit_account: string; person: string | null; category: string | null }[]);
    const dateStr = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="ledger-${dateStr}.csv"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed";
    return errorResponse(message, 400, "invalidRequest");
  }
}

async function handleBudgetsList(env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  return jsonResponse({ budgets: await listBudgets(env) });
}

async function handleBudgetCreate(request: Request, env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const body = await parseJsonBody<{ category?: string; amount?: number; period?: string }>(request).catch(() => ({}));

  if (!body.category || !body.amount) {
    return errorResponse("category and amount are required", 400, "invalidRequest");
  }

  try {
    const budget = await upsertBudget(env, {
      category: body.category,
      amount: body.amount,
      period: body.period as BudgetPeriod | undefined,
    });
    return jsonResponse({ budget });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Budget creation failed";
    return errorResponse(message, 400, "invalidRequest");
  }
}

async function handleBudgetDelete(request: Request, env: AuthEnv, context: ApiRequestContext, category: string): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "DELETE") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const deleted = await deleteBudget(env, category);
  if (!deleted) {
    return errorResponse("Budget not found", 404, "notFound");
  }

  return new Response(null, { status: 204 });
}

async function handlePersonDebts(env: AuthEnv, context: ApiRequestContext, person: string): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  const result = await getPersonDebts(env, person);
  return jsonResponse(result);
}

async function handleHabitsList(env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  return jsonResponse({ items: await getHabitsWithStatus(env) });
}

async function handleHabitCreate(request: Request, env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const body = await parseJsonBody<{ name?: string; description?: string; frequency?: string; targetDays?: number[] }>(request).catch(() => ({}));

  if (!body.name) {
    return errorResponse("name is required", 400, "invalidRequest");
  }

  try {
    const habit = await createHabit(env, {
      name: body.name,
      description: body.description,
      frequency: body.frequency as HabitFrequency | undefined,
      targetDays: body.targetDays,
    });
    return jsonResponse({ habit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Habit creation failed";
    return errorResponse(message, 400, "invalidRequest");
  }
}

async function handleHabitUpdate(request: Request, env: AuthEnv, context: ApiRequestContext, id: number): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "PATCH") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const body = await parseJsonBody<{ name?: string; description?: string; frequency?: string; targetDays?: number[] }>(request).catch(() => ({}));

  const habit = await updateHabit(env, id, {
    name: body.name,
    description: body.description,
    frequency: body.frequency as HabitFrequency | undefined,
    targetDays: body.targetDays,
  });

  if (!habit) {
    return errorResponse("Habit not found", 404, "notFound");
  }

  return jsonResponse({ habit });
}

async function handleHabitDelete(request: Request, env: AuthEnv, context: ApiRequestContext, id: number): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "DELETE") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const deleted = await deleteHabit(env, id);
  if (!deleted) {
    return errorResponse("Habit not found", 404, "notFound");
  }

  return new Response(null, { status: 204 });
}

async function handleHabitHistory(request: Request, env: AuthEnv, context: ApiRequestContext, id: number): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  const url = new URL(request.url);
  const pagination = parsePagination(url, 20);
  const result = await getCheckinHistory(env, id, pagination.page, pagination.pageSize);
  return jsonResponse(result);
}

async function handleHabitCheckin(request: Request, env: AuthEnv, context: ApiRequestContext, id: number): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const habit = await getHabitById(env, id);
  if (!habit) {
    return errorResponse("Habit not found", 404, "notFound");
  }

  const body = await parseJsonBody<{ date?: string; note?: string }>(request).catch(() => ({}));
  const checkin = await checkinHabit(env, id, { date: body.date, note: body.note });
  return jsonResponse({ checkin });
}

async function handleFinanceStatistics(env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  return jsonResponse({ statistics: await getFinanceStats(env) });
}

async function handleDashboard(request: Request, env: AuthEnv, context: ApiRequestContext): Promise<Response> {
  if (!context.account) {
    return errorResponse("Unauthorized", 401, "unauthorized");
  }

  const url = new URL(request.url);
  const pagination = parsePagination(url, 5);
  const recentTransactions = await getLedgerPage(env, pagination.page, pagination.pageSize);

  return jsonResponse({
    account: context.account,
    summary: await getFinanceBalances(env),
    statistics: await getFinanceStats(env),
    recentTransactions,
  });
}

async function handleApiRequest(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/auth/login") {
    return handleLogin(request, env);
  }

  if (url.pathname === "/api/auth/refresh") {
    return handleRefresh(request, env);
  }

  if (url.pathname === "/api/auth/logout") {
    return handleLogout(request, env);
  }

  const knownProtectedPatterns = [
    /^\/api\/me$/,
    /^\/api\/accounts/,
    /^\/api\/dashboard$/,
    /^\/api\/finance\/(summary|list|statistics|export\.csv)$/,
    /^\/api\/finance\/\d+$/,
    /^\/api\/finance\/debts\/[^/]+$/,
    /^\/api\/budgets$/,
    /^\/api\/budgets\/[^/]+$/,
    /^\/api\/habits$/,
    /^\/api\/habits\/\d+$/,
    /^\/api\/habits\/\d+\/(history|checkin)$/,
  ];

  const isKnownProtected = knownProtectedPatterns.some((pattern) => pattern.test(url.pathname));
  if (!isKnownProtected) {
    return errorResponse("Not found", 404, "notFound");
  }

  const context = await authenticateRequest(request, env);
  if (context instanceof Response) {
    return context;
  }

  if (url.pathname === "/api/me") {
    return jsonResponse({ account: context.account });
  }

  if (url.pathname.startsWith("/api/accounts")) {
    return handleAccounts(request, env, context);
  }

  if (url.pathname === "/api/finance/summary") {
    return handleFinanceSummary(env, context);
  }

  if (url.pathname === "/api/finance/list") {
    return handleFinanceList(request, env, context);
  }

  if (url.pathname === "/api/finance/statistics") {
    return handleFinanceStatistics(env, context);
  }

  if (url.pathname === "/api/finance/export.csv") {
    return handleCsvExport(request, env, context);
  }

  const financeIdMatch = url.pathname.match(/^\/api\/finance\/(\d+)$/);
  if (financeIdMatch) {
    const id = Number(financeIdMatch[1]);
    if (request.method === "PATCH") {
      return handleFinanceEdit(request, env, context, id);
    }
    if (request.method === "DELETE") {
      return handleFinanceDelete(request, env, context, id);
    }
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const debtPersonMatch = url.pathname.match(/^\/api\/finance\/debts\/(.+)$/);
  if (debtPersonMatch) {
    return handlePersonDebts(env, context, decodeURIComponent(debtPersonMatch[1]));
  }

  if (url.pathname === "/api/budgets" && request.method === "GET") {
    return handleBudgetsList(env, context);
  }

  if (url.pathname === "/api/budgets" && request.method === "POST") {
    return handleBudgetCreate(request, env, context);
  }

  const budgetCategoryMatch = url.pathname.match(/^\/api\/budgets\/(.+)$/);
  if (budgetCategoryMatch && request.method === "DELETE") {
    return handleBudgetDelete(request, env, context, decodeURIComponent(budgetCategoryMatch[1]));
  }

  if (url.pathname === "/api/habits" && request.method === "GET") {
    return handleHabitsList(env, context);
  }

  if (url.pathname === "/api/habits" && request.method === "POST") {
    return handleHabitCreate(request, env, context);
  }

  const habitIdMatch = url.pathname.match(/^\/api\/habits\/(\d+)$/);
  if (habitIdMatch) {
    const id = Number(habitIdMatch[1]);
    if (request.method === "PATCH") {
      return handleHabitUpdate(request, env, context, id);
    }
    if (request.method === "DELETE") {
      return handleHabitDelete(request, env, context, id);
    }
    return errorResponse("Method not allowed", 405, "methodNotAllowed");
  }

  const habitHistoryMatch = url.pathname.match(/^\/api\/habits\/(\d+)\/history$/);
  if (habitHistoryMatch) {
    return handleHabitHistory(request, env, context, Number(habitHistoryMatch[1]));
  }

  const habitCheckinMatch = url.pathname.match(/^\/api\/habits\/(\d+)\/checkin$/);
  if (habitCheckinMatch) {
    return handleHabitCheckin(request, env, context, Number(habitCheckinMatch[1]));
  }

  if (url.pathname === "/api/dashboard") {
    return handleDashboard(request, env, context);
  }

  return errorResponse("Not found", 404, "notFound");
}

export {
  authenticateRequest,
  base64UrlDecode,
  base64UrlEncode,
  camelizeKey,
  camelizeValue,
  createAuthSession,
  ensureSeededAccounts,
  errorResponse,
  generateToken,
  handleAccounts,
  handleApiRequest,
  handleBudgetCreate,
  handleBudgetDelete,
  handleBudgetsList,
  handleCsvExport,
  handleDashboard,
  handleFinanceDelete,
  handleFinanceEdit,
  handleFinanceList,
  handleFinanceStatistics,
  handleFinanceSummary,
  handleHabitCheckin,
  handleHabitCreate,
  handleHabitDelete,
  handleHabitHistory,
  handleHabitUpdate,
  handleHabitsList,
  handleLogin,
  handleLogout,
  handlePersonDebts,
  handleRefresh,
  jsonResponse,
  parsePagination,
  parseSeededAccounts,
  rotateAuthSession,
  withPagination,
};
export type {
  ApiAccount,
  ApiFinanceItem,
  ApiRequestContext,
  AuthAccountRow,
  AuthEnv,
  AuthSessionRow,
  AuthenticatedAccount,
  FinanceStats,
  PaginatedResponse,
  Pagination,
  SeededAccountInput,
};
