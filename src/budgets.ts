type BudgetEnv = {
  DB?: D1Database;
};

type BudgetRow = {
  id: number;
  category: string;
  amount: number;
  period: string;
  created_at: string;
  updated_at: string;
};

type Budget = {
  id: number;
  category: string;
  amount: number;
  period: BudgetPeriod;
  createdAt: string;
  updatedAt: string;
};

type BudgetPeriod = "monthly" | "weekly";

type BudgetInput = {
  category: string;
  amount: number;
  period?: BudgetPeriod;
};

type EnrichedCategory = {
  category: string;
  account: string;
  type: "expense" | "income";
  balance: number;
  budget?: number;
  budgetPeriod?: BudgetPeriod;
  usagePercent?: number;
  status?: "ok" | "warning" | "over";
};

function requireDb(env: BudgetEnv): D1Database {
  if (!env.DB) {
    throw new Error("D1 DB binding is required for budget features");
  }
  return env.DB;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function listBudgets(env: BudgetEnv): Promise<Budget[]> {
  const db = requireDb(env);
  const result = await db
    .prepare("SELECT id, category, amount, period, created_at, updated_at FROM budgets ORDER BY category ASC")
    .all<BudgetRow>();

  return result.results.map((row) => ({
    id: row.id,
    category: row.category,
    amount: Number(row.amount),
    period: row.period as BudgetPeriod,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function upsertBudget(env: BudgetEnv, input: BudgetInput): Promise<Budget> {
  const db = requireDb(env);
  const category = slug(input.category);
  if (!category) {
    throw new Error("category is required");
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("amount must be a positive integer");
  }
  const period = input.period ?? "monthly";

  await db
    .prepare(
      `INSERT INTO budgets (category, amount, period, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(category) DO UPDATE SET amount = excluded.amount, period = excluded.period, updated_at = datetime('now')`,
    )
    .bind(category, input.amount, period)
    .run();

  const row = await db
    .prepare("SELECT id, category, amount, period, created_at, updated_at FROM budgets WHERE category = ?")
    .bind(category)
    .first<BudgetRow>();

  if (!row) {
    throw new Error("Failed to upsert budget");
  }

  return {
    id: row.id,
    category: row.category,
    amount: Number(row.amount),
    period: row.period as BudgetPeriod,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function deleteBudget(env: BudgetEnv, category: string): Promise<boolean> {
  const db = requireDb(env);
  const slugCategory = slug(category);
  const result = await db.prepare("DELETE FROM budgets WHERE category = ?").bind(slugCategory).run();
  return result.meta.changes > 0;
}

async function getBudgetMap(env: BudgetEnv): Promise<Map<string, { amount: number; period: BudgetPeriod }>> {
  const budgets = await listBudgets(env);
  const map = new Map<string, { amount: number; period: BudgetPeriod }>();
  for (const budget of budgets) {
    map.set(budget.category, { amount: budget.amount, period: budget.period });
  }
  return map;
}

function computePeriodStart(period: BudgetPeriod, now: Date): string {
  if (period === "weekly") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

async function getSpentSince(env: BudgetEnv, category: string, startDate: string): Promise<number> {
  const db = requireDb(env);
  const account = `expenses:${category}`;
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(l.amount), 0) AS spent
       FROM ledger l
       WHERE l.debit_account = ?
         AND l.is_reversed = 0
         AND l.created_at >= ?`,
    )
    .bind(account, startDate)
    .first<{ spent: number }>();

  return Number(row?.spent ?? 0);
}

async function enrichCategoriesWithBudgets(
  env: BudgetEnv,
  categories: EnrichedCategory[],
): Promise<EnrichedCategory[]> {
  const budgetMap = await getBudgetMap(env);
  const now = new Date();

  const enriched = await Promise.all(
    categories.map(async (cat): Promise<EnrichedCategory> => {
      if (cat.type !== "expense") {
        return cat;
      }

      const budget = budgetMap.get(cat.category);
      if (!budget) {
        return cat;
      }

      const periodStart = computePeriodStart(budget.period, now);
      const spentAmount = await getSpentSince(env, cat.category, periodStart);

      return {
        ...cat,
        budget: budget.amount,
        budgetPeriod: budget.period,
        usagePercent: budget.amount > 0 ? Math.round((spentAmount / budget.amount) * 100) : 0,
        status: spentAmount > budget.amount ? "over" : spentAmount > budget.amount * 0.8 ? "warning" : "ok",
      };
    }),
  );

  return enriched;
}

export { computePeriodStart, deleteBudget, enrichCategoriesWithBudgets, getBudgetMap, getSpentSince, listBudgets, slug, upsertBudget };
export type { Budget, BudgetEnv, BudgetInput, BudgetPeriod, BudgetRow, EnrichedCategory };
