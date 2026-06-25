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
