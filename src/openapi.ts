type OpenApiEnv = {
  AUTH_SEEDED_ACCOUNTS?: string;
};

type SeededCredential = {
  email: string;
  password: string;
};

function parseSeededCredentials(value?: string): SeededCredential[] {
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
    if (typeof account.email !== "string" || typeof account.password !== "string") {
      return [];
    }

    return [{ email: account.email.trim().toLowerCase(), password: account.password }];
  });
}

function getBasicAuth(request: Request): SeededCredential | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const token = header?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!token) {
    return null;
  }

  let decoded: string;
  try {
    decoded = atob(token);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return null;
  }

  return {
    email: decoded.slice(0, separator).trim().toLowerCase(),
    password: decoded.slice(separator + 1),
  };
}

function isOpenApiAuthorized(request: Request, env: OpenApiEnv): boolean {
  const credentials = getBasicAuth(request);
  if (!credentials) {
    return false;
  }

  return parseSeededCredentials(env.AUTH_SEEDED_ACCOUNTS).some(
    (account) => account.email === credentials.email && account.password === credentials.password,
  );
}

function unauthorizedOpenApiResponse(): Response {
  return Response.json(
    { error: { code: "unauthorized", message: "OpenAPI credentials are required" } },
    {
      status: 401,
      headers: {
        "www-authenticate": 'Basic realm="OpenAPI"',
      },
    },
  );
}

function schemaRef(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

const unauthorizedResponse = {
  description: "Unauthorized",
  content: {
    "application/json": {
      schema: schemaRef("ErrorResponse"),
    },
  },
};

const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "my-pdt Frontend API",
    version: "1.0.0",
    description: "Backend API for seeded-account authentication, dashboard, accounts, and finance data.",
  },
  servers: [{ url: "https://my-pdt.warid.web.id" }],
  paths: {
    "/api/auth/login": {
      post: {
        summary: "Login with a seeded account",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: schemaRef("LoginRequest"),
            },
          },
        },
        responses: {
          "200": {
            description: "Login succeeded",
            content: {
              "application/json": {
                schema: schemaRef("AuthResponse"),
              },
            },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/auth/refresh": {
      post: {
        summary: "Rotate access and refresh tokens",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: schemaRef("RefreshRequest"),
            },
          },
        },
        responses: {
          "200": {
            description: "Tokens rotated",
            content: {
              "application/json": {
                schema: schemaRef("AuthResponse"),
              },
            },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/auth/logout": {
      post: {
        summary: "Revoke the current session",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: schemaRef("LogoutRequest"),
            },
          },
        },
        responses: {
          "204": { description: "Session revoked" },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/me": {
      get: {
        summary: "Get current account",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Current account",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["account"],
                  properties: { account: schemaRef("Account") },
                },
              },
            },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/accounts": {
      get: {
        summary: "List seeded accounts",
        tags: ["Accounts"],
        security: [{ bearerAuth: [] }],
        parameters: [schemaRef("PageParam"), schemaRef("PageSizeParam"), schemaRef("SearchParam")],
        responses: {
          "200": {
            description: "Paginated accounts",
            content: {
              "application/json": {
                schema: schemaRef("AccountListResponse"),
              },
            },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/accounts/{id}": {
      get: {
        summary: "Get an account by id",
        tags: ["Accounts"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          "200": {
            description: "Account detail",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["account"],
                  properties: { account: schemaRef("Account") },
                },
              },
            },
          },
          "401": unauthorizedResponse,
          "404": {
            description: "Account not found",
            content: { "application/json": { schema: schemaRef("ErrorResponse") } },
          },
        },
      },
    },
    "/api/dashboard": {
      get: {
        summary: "Get dashboard data",
        tags: ["Dashboard"],
        security: [{ bearerAuth: [] }],
        parameters: [schemaRef("PageParam"), schemaRef("PageSizeParam")],
        responses: {
          "200": {
            description: "Dashboard data",
            content: { "application/json": { schema: schemaRef("DashboardResponse") } },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/finance/summary": {
      get: {
        summary: "Get finance summary",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Finance summary",
            content: { "application/json": { schema: schemaRef("FinanceSummaryResponse") } },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/finance/list": {
      get: {
        summary: "List finance ledger items",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        parameters: [schemaRef("PageParam"), schemaRef("PageSizeParam")],
        responses: {
          "200": {
            description: "Paginated ledger items",
            content: { "application/json": { schema: schemaRef("FinanceListResponse") } },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/finance/statistics": {
      get: {
        summary: "Get finance statistics",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Finance statistics",
            content: { "application/json": { schema: schemaRef("FinanceStatisticsResponse") } },
          },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/finance/{id}": {
      patch: {
        summary: "Edit a transaction (creates reversal + new entry)",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: schemaRef("EditTransactionRequest") } },
        },
        responses: {
          "200": { description: "Edit result", content: { "application/json": { schema: schemaRef("EditTransactionResponse") } } },
          "401": unauthorizedResponse,
          "404": { description: "Not found", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
          "409": { description: "Already reversed", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
        },
      },
      delete: {
        summary: "Soft-delete a transaction (creates reversal entry)",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          "200": { description: "Reversal result", content: { "application/json": { schema: schemaRef("DeleteTransactionResponse") } } },
          "401": unauthorizedResponse,
          "404": { description: "Not found", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
          "409": { description: "Already reversed", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
        },
      },
    },
    "/api/finance/export.csv": {
      get: {
        summary: "Export ledger as CSV",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
          { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
          { name: "wallet", in: "query", required: false, schema: { type: "string" } },
          { name: "category", in: "query", required: false, schema: { type: "string" } },
          { name: "type", in: "query", required: false, schema: { type: "string", enum: ["expense", "income", "debt"] } },
          { name: "person", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "CSV file" },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/finance/debts/{person}": {
      get: {
        summary: "Get per-person debt breakdown",
        tags: ["Finance"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "person", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Debt breakdown", content: { "application/json": { schema: schemaRef("PersonDebtResult") } } },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/budgets": {
      get: {
        summary: "List all budgets",
        tags: ["Budgets"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Budget list", content: { "application/json": { schema: schemaRef("BudgetListResponse") } } },
          "401": unauthorizedResponse,
        },
      },
      post: {
        summary: "Create or replace a budget",
        tags: ["Budgets"],
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: schemaRef("BudgetInput") } } },
        responses: {
          "200": { description: "Created budget", content: { "application/json": { schema: schemaRef("BudgetResponse") } } },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/budgets/{category}": {
      delete: {
        summary: "Remove a budget",
        tags: ["Budgets"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "category", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Deleted" },
          "401": unauthorizedResponse,
          "404": { description: "Not found", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
        },
      },
    },
    "/api/habits": {
      get: {
        summary: "List all active habits with today's status",
        tags: ["Habits"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Habit list", content: { "application/json": { schema: schemaRef("HabitListResponse") } } },
          "401": unauthorizedResponse,
        },
      },
      post: {
        summary: "Create a new habit",
        tags: ["Habits"],
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: schemaRef("HabitInput") } } },
        responses: {
          "200": { description: "Created habit", content: { "application/json": { schema: schemaRef("HabitResponse") } } },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/habits/{id}": {
      patch: {
        summary: "Update a habit",
        tags: ["Habits"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: { required: true, content: { "application/json": { schema: schemaRef("HabitInput") } } },
        responses: {
          "200": { description: "Updated habit", content: { "application/json": { schema: schemaRef("HabitResponse") } } },
          "401": unauthorizedResponse,
          "404": { description: "Not found", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
        },
      },
      delete: {
        summary: "Soft-delete a habit",
        tags: ["Habits"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          "204": { description: "Deleted" },
          "401": unauthorizedResponse,
          "404": { description: "Not found", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
        },
      },
    },
    "/api/habits/{id}/history": {
      get: {
        summary: "Get paginated checkin history for a habit",
        tags: ["Habits"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          schemaRef("PageParam"),
          schemaRef("PageSizeParam"),
        ],
        responses: {
          "200": { description: "Checkin history", content: { "application/json": { schema: schemaRef("CheckinHistoryResponse") } } },
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/habits/{id}/checkin": {
      post: {
        summary: "Check in a habit for a given date",
        tags: ["Habits"],
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        requestBody: { required: false, content: { "application/json": { schema: schemaRef("CheckinInput") } } },
        responses: {
          "200": { description: "Checkin result", content: { "application/json": { schema: schemaRef("CheckinResponse") } } },
          "401": unauthorizedResponse,
          "404": { description: "Not found", content: { "application/json": { schema: schemaRef("ErrorResponse") } } },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "Get this OpenAPI document",
        tags: ["Docs"],
        security: [{ basicAuth: [] }],
        responses: {
          "200": { description: "OpenAPI document" },
          "401": unauthorizedResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      basicAuth: { type: "http", scheme: "basic" },
    },
    parameters: {
      PageParam: { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
      PageSizeParam: { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      SearchParam: { name: "search", in: "query", required: false, schema: { type: "string" } },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: { code: { type: "string" }, message: { type: "string" } },
          },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: { email: { type: "string", format: "email" }, password: { type: "string" } },
      },
      RefreshRequest: {
        type: "object",
        required: ["refreshToken"],
        properties: { refreshToken: { type: "string" } },
      },
      LogoutRequest: {
        type: "object",
        properties: { refreshToken: { type: "string" } },
      },
      AuthResponse: {
        type: "object",
        required: ["accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "account"],
        properties: {
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          accessTokenExpiresAt: { type: "string", format: "date-time" },
          refreshTokenExpiresAt: { type: "string", format: "date-time" },
          account: schemaRef("Account"),
        },
      },
      Account: {
        type: "object",
        required: ["id", "email", "name", "role"],
        properties: {
          id: { type: "integer" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          role: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      AccountListResponse: {
        allOf: [schemaRef("Pagination"), { type: "object", required: ["items"], properties: { items: { type: "array", items: schemaRef("Account") } } }],
      },
      Pagination: {
        type: "object",
        required: ["items", "page", "pageSize", "total", "totalPages"],
        properties: {
          items: { type: "array" },
          page: { type: "integer" },
          pageSize: { type: "integer" },
          total: { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
      FinanceSummary: {
        type: "object",
        required: ["wallets", "debts", "categories"],
        properties: {
          wallets: { type: "array", items: schemaRef("WalletBalance") },
          debts: { type: "array", items: schemaRef("DebtBalance") },
          categories: { type: "array", items: schemaRef("CategoryBalance") },
        },
      },
      WalletBalance: {
        type: "object",
        required: ["wallet", "account", "balance"],
        properties: { wallet: { type: "string" }, account: { type: "string" }, balance: { type: "number" } },
      },
      DebtBalance: {
        type: "object",
        required: ["person", "account", "direction", "balance"],
        properties: {
          person: { type: "string" },
          account: { type: "string" },
          direction: { type: "string", enum: ["owe", "lend"] },
          balance: { type: "number" },
        },
      },
      CategoryBalance: {
        type: "object",
        required: ["category", "account", "type", "balance"],
        properties: {
          category: { type: "string" },
          account: { type: "string" },
          type: { type: "string", enum: ["expense", "income"] },
          balance: { type: "number" },
        },
      },
      FinanceItem: {
        type: "object",
        required: ["id", "debitAccount", "creditAccount", "amount", "createdAt"],
        properties: {
          id: { type: "integer" },
          debitAccount: { type: "string" },
          creditAccount: { type: "string" },
          amount: { type: "number" },
          description: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          person: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      FinanceStats: {
        type: "object",
        required: ["transactionCount", "walletCount", "debtCount", "categoryCount", "totalWalletBalance", "totalReceivables", "totalPayables", "totalIncome", "totalExpense", "netWorth", "latestTransactionAt"],
        properties: {
          transactionCount: { type: "integer" },
          walletCount: { type: "integer" },
          debtCount: { type: "integer" },
          categoryCount: { type: "integer" },
          totalWalletBalance: { type: "number" },
          totalReceivables: { type: "number" },
          totalPayables: { type: "number" },
          totalIncome: { type: "number" },
          totalExpense: { type: "number" },
          netWorth: { type: "number" },
          latestTransactionAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      FinanceSummaryResponse: {
        type: "object",
        required: ["summary"],
        properties: { summary: schemaRef("FinanceSummary") },
      },
      FinanceListResponse: {
        allOf: [schemaRef("Pagination"), { type: "object", required: ["items"], properties: { items: { type: "array", items: schemaRef("FinanceItem") } } }],
      },
      FinanceStatisticsResponse: {
        type: "object",
        required: ["statistics"],
        properties: { statistics: schemaRef("FinanceStats") },
      },
      DashboardResponse: {
        type: "object",
        required: ["account", "summary", "statistics", "recentTransactions"],
        properties: {
          account: schemaRef("Account"),
          summary: schemaRef("FinanceSummary"),
          statistics: schemaRef("FinanceStats"),
          recentTransactions: schemaRef("FinanceListResponse"),
        },
      },
      EditTransactionRequest: {
        type: "object",
        properties: {
          amount: { type: "integer", minimum: 1 },
          description: { type: "string" },
          category: { type: "string" },
        },
      },
      EditTransactionResponse: {
        type: "object",
        required: ["reversalId", "newEntryId"],
        properties: { reversalId: { type: "integer" }, newEntryId: { type: "integer" } },
      },
      DeleteTransactionResponse: {
        type: "object",
        required: ["reversalId"],
        properties: { reversalId: { type: "integer" } },
      },
      PersonDebtResult: {
        type: "object",
        required: ["person", "receivable", "payable", "net", "direction", "transactions"],
        properties: {
          person: { type: "string" },
          receivable: { type: "number" },
          payable: { type: "number" },
          net: { type: "number" },
          direction: { type: "string", enum: ["they_owe_me", "i_owe_them", "settled"] },
          transactions: { type: "array", items: schemaRef("PersonDebtTransaction") },
        },
      },
      PersonDebtTransaction: {
        type: "object",
        required: ["id", "date", "intent", "amount", "description", "wallet"],
        properties: {
          id: { type: "integer" },
          date: { type: "string", format: "date-time" },
          intent: { type: "string" },
          amount: { type: "number" },
          description: { type: ["string", "null"] },
          wallet: { type: ["string", "null"] },
        },
      },
      BudgetInput: {
        type: "object",
        required: ["category", "amount"],
        properties: {
          category: { type: "string" },
          amount: { type: "integer", minimum: 1 },
          period: { type: "string", enum: ["monthly", "weekly"] },
        },
      },
      BudgetResponse: {
        type: "object",
        required: ["budget"],
        properties: {
          budget: {
            type: "object",
            required: ["id", "category", "amount", "period", "createdAt", "updatedAt"],
            properties: {
              id: { type: "integer" },
              category: { type: "string" },
              amount: { type: "integer" },
              period: { type: "string", enum: ["monthly", "weekly"] },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      BudgetListResponse: {
        type: "object",
        required: ["budgets"],
        properties: { budgets: { type: "array", items: schemaRef("BudgetInput") } },
      },
      HabitInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          frequency: { type: "string", enum: ["daily", "weekly"] },
          targetDays: { type: "array", items: { type: "number" } },
        },
      },
      HabitResponse: {
        type: "object",
        required: ["habit"],
        properties: {
          habit: {
            type: "object",
            required: ["id", "name", "frequency", "isActive", "createdAt"],
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              description: { type: ["string", "null"] },
              frequency: { type: "string", enum: ["daily", "weekly"] },
              targetDays: { type: ["array", "null"], items: { type: "number" } },
              isActive: { type: "boolean" },
              createdAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      HabitListResponse: {
        type: "object",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "name", "frequency", "checkedToday", "currentStreak", "bestStreak", "completionThisMonth"],
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                description: { type: ["string", "null"] },
                frequency: { type: "string", enum: ["daily", "weekly"] },
                targetDays: { type: ["array", "null"], items: { type: "number" } },
                checkedToday: { type: "boolean" },
                currentStreak: { type: "integer" },
                bestStreak: { type: "integer" },
                completionThisMonth: { type: "number" },
              },
            },
          },
        },
      },
      CheckinInput: {
        type: "object",
        properties: {
          date: { type: "string", format: "date" },
          note: { type: "string" },
        },
      },
      CheckinResponse: {
        type: "object",
        required: ["checkin"],
        properties: {
          checkin: {
            type: "object",
            required: ["id", "habitId", "checkedAt", "date"],
            properties: {
              id: { type: "integer" },
              habitId: { type: "integer" },
              checkedAt: { type: "string", format: "date-time" },
              date: { type: "string", format: "date" },
              note: { type: ["string", "null"] },
            },
          },
        },
      },
      CheckinHistoryResponse: {
        allOf: [
          schemaRef("Pagination"),
          {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "habitId", "checkedAt", "date"],
                  properties: {
                    id: { type: "integer" },
                    habitId: { type: "integer" },
                    checkedAt: { type: "string", format: "date-time" },
                    date: { type: "string", format: "date" },
                    note: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
};

function handleOpenApiRequest(request: Request, env: OpenApiEnv): Response {
  if (request.method !== "GET") {
    return Response.json({ error: { code: "methodNotAllowed", message: "Method not allowed" } }, { status: 405 });
  }

  if (!isOpenApiAuthorized(request, env)) {
    return unauthorizedOpenApiResponse();
  }

  return Response.json(openApiSpec);
}

export { handleOpenApiRequest, isOpenApiAuthorized, openApiSpec, parseSeededCredentials };
export type { OpenApiEnv, SeededCredential };
