import { enrichCategoriesWithBudgets } from "./budgets";
import type { EnrichedCategory } from "./budgets";

type FinanceIntentType =
  | "expense"
  | "income"
  | "income_gift"
  | "debt_lend"
  | "debt_lend_collect"
  | "debt_owe"
  | "debt_owe_pay"
  | "debt_borrow"
  | "debt_borrow_pay"
  | "debt_loan"
  | "debt_loan_collect";

type ReminderDirection = "owe" | "lend";

type FinanceEnv = {
  DB?: D1Database;
};

type RecordTransactionInput = {
  intent_type: FinanceIntentType;
  amount: number;
  description: string;
  wallet_name?: string;
  person?: string;
  category?: string;
};

type CreateWalletInput = {
  wallet_name: string;
  initial_balance: number;
};

type AddReminderInput = {
  person: string;
  amount: number;
  due_date: string;
  direction: ReminderDirection;
  note?: string;
};

type LedgerEntry = {
  id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  description?: string;
  category?: string;
  person?: string;
  created_at: string;
  is_reversed: number;
  reversed_entry_id: number | null;
};

type WalletBalance = {
  wallet: string;
  account: string;
  balance: number;
};

type DebtBalance = {
  person: string;
  account: string;
  direction: ReminderDirection;
  balance: number;
};

type CategoryBalance = {
  category: string;
  account: string;
  type: "expense" | "income";
  balance: number;
};

type Reminder = {
  id: number;
  person: string;
  amount: number;
  due_date: string;
  direction: ReminderDirection;
  is_paid: number;
  note?: string;
  reminded_at?: string;
  created_at: string;
};

type FinanceBalances = {
  wallets: WalletBalance[];
  debts: DebtBalance[];
  categories: CategoryBalance[];
};

type FinanceToolResult = {
  text: string;
  data?: unknown;
};

const walletIntents = new Set<FinanceIntentType>([
  "expense",
  "income",
  "debt_lend",
  "debt_lend_collect",
  "debt_owe_pay",
  "debt_borrow",
  "debt_borrow_pay",
  "debt_loan",
  "debt_loan_collect",
]);

function requireDb(env: FinanceEnv): D1Database {
  if (!env.DB) {
    throw new Error("D1 DB binding is required for finance features");
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

function accountType(name: string): string {
  if (name.startsWith("assets:")) {
    return "asset";
  }
  if (name.startsWith("liabilities:")) {
    return "liability";
  }
  if (name.startsWith("expenses:")) {
    return "expense";
  }
  if (name.startsWith("income:")) {
    return "income";
  }
  throw new Error(`Unsupported account name: ${name}`);
}

function walletAccount(walletName: string): string {
  const name = slug(walletName);
  if (!name) {
    throw new Error("wallet_name is required");
  }
  return `assets:wallets:${name}`;
}

function receivableAccount(person: string): string {
  const name = slug(person);
  if (!name) {
    throw new Error("person is required");
  }
  return `assets:receivables:${name}`;
}

function payableAccount(person: string): string {
  const name = slug(person);
  if (!name) {
    throw new Error("person is required");
  }
  return `liabilities:payables:${name}`;
}

function expenseAccount(category?: string): string {
  return `expenses:${slug(category || "uncategorized") || "uncategorized"}`;
}

function incomeAccount(source?: string): string {
  return `income:${slug(source || "general") || "general"}`;
}

async function accountExists(db: D1Database, account: string): Promise<boolean> {
  const row = await db.prepare("SELECT name FROM accounts WHERE name = ? LIMIT 1").bind(account).first<{ name: string }>();
  return Boolean(row);
}

async function ensureAccount(db: D1Database, account: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO accounts (name, type) VALUES (?, ?)")
    .bind(account, accountType(account))
    .run();
}

async function ensureAccounts(db: D1Database, accounts: string[]): Promise<void> {
  for (const account of accounts) {
    await ensureAccount(db, account);
  }
}

function requireWallet(input: RecordTransactionInput): string {
  if (!input.wallet_name || !input.wallet_name.trim()) {
    throw new Error("wallet_name is required for this transaction");
  }
  return walletAccount(input.wallet_name);
}

function requirePerson(input: RecordTransactionInput): string {
  if (!input.person || !input.person.trim()) {
    throw new Error("person is required for this transaction");
  }
  return input.person;
}

function routeTransaction(input: RecordTransactionInput): { debit: string; credit: string; category?: string; person?: string } {
  const category = input.category || "uncategorized";
  switch (input.intent_type) {
    case "expense":
      return { debit: expenseAccount(category), credit: requireWallet(input), category };
    case "income":
      return { debit: requireWallet(input), credit: incomeAccount(category), category };
    case "income_gift":
      return { debit: expenseAccount(category), credit: "income:gift", category, person: input.person };
    case "debt_lend": {
      const person = requirePerson(input);
      return { debit: receivableAccount(person), credit: requireWallet(input), category, person };
    }
    case "debt_lend_collect": {
      const person = requirePerson(input);
      return { debit: requireWallet(input), credit: receivableAccount(person), category, person };
    }
    case "debt_owe": {
      const person = requirePerson(input);
      return { debit: expenseAccount(category), credit: payableAccount(person), category, person };
    }
    case "debt_owe_pay": {
      const person = requirePerson(input);
      return { debit: payableAccount(person), credit: requireWallet(input), category, person };
    }
    case "debt_borrow": {
      const person = requirePerson(input);
      return { debit: requireWallet(input), credit: payableAccount(person), category, person };
    }
    case "debt_borrow_pay": {
      const person = requirePerson(input);
      return { debit: payableAccount(person), credit: requireWallet(input), category, person };
    }
    case "debt_loan": {
      const person = requirePerson(input);
      return { debit: receivableAccount(person), credit: requireWallet(input), category, person };
    }
    case "debt_loan_collect": {
      const person = requirePerson(input);
      return { debit: requireWallet(input), credit: receivableAccount(person), category, person };
    }
  }
}

function validateAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("amount must be a positive integer");
  }
}

async function createNewWallet(env: FinanceEnv, input: CreateWalletInput): Promise<FinanceToolResult> {
  const db = requireDb(env);
  if (!Number.isInteger(input.initial_balance) || input.initial_balance < 0) {
    throw new Error("initial_balance must be a non-negative integer");
  }

  const account = walletAccount(input.wallet_name);
  await ensureAccount(db, account);

  if (input.initial_balance > 0) {
    const income = "income:initial_balance";
    await ensureAccount(db, income);
    await db
      .prepare(
        "INSERT INTO ledger (debit_account, credit_account, amount, description, category) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(account, income, input.initial_balance, "Initial wallet balance", "initial_balance")
      .run();
  }

  return { text: `Created wallet ${slug(input.wallet_name)}.`, data: { account } };
}

async function recordTransaction(env: FinanceEnv, input: RecordTransactionInput): Promise<FinanceToolResult> {
  const db = requireDb(env);
  validateAmount(input.amount);
  if (!input.description || !input.description.trim()) {
    throw new Error("description is required");
  }

  if (walletIntents.has(input.intent_type)) {
    const wallet = requireWallet(input);
    if (!(await accountExists(db, wallet))) {
      return {
        text: `I couldn't find a wallet named '${input.wallet_name}'. Would you like to create it?`,
        data: { missing_wallet: input.wallet_name },
      };
    }
  }

  const routed = routeTransaction(input);
  await ensureAccounts(db, [routed.debit, routed.credit]);
  await db
    .prepare(
      "INSERT INTO ledger (debit_account, credit_account, amount, description, category, person) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      routed.debit,
      routed.credit,
      input.amount,
      input.description,
      routed.category ?? null,
      routed.person ? slug(routed.person) : null,
    )
    .run();

  return {
    text: formatTransactionConfirmation(input, routed),
    data: { debit_account: routed.debit, credit_account: routed.credit, amount: input.amount },
  };
}

function formatTransactionConfirmation(
  input: RecordTransactionInput,
  routed: { debit: string; credit: string; person?: string },
): string {
  const amount = input.amount.toLocaleString("id-ID");
  if (input.intent_type === "debt_lend" || input.intent_type === "debt_loan") {
    return `Recorded: ${routed.person} owes you ${amount} for ${input.description}.`;
  }
  if (input.intent_type === "debt_owe" || input.intent_type === "debt_borrow") {
    return `Recorded: you owe ${routed.person} ${amount} for ${input.description}.`;
  }
  if (input.intent_type.includes("collect")) {
    return `Recorded: ${routed.person} paid you ${amount}.`;
  }
  if (input.intent_type.includes("pay")) {
    return `Recorded: you paid ${routed.person} ${amount}.`;
  }
  return `Recorded: ${input.description} ${amount}.`;
}

async function listWallets(env: FinanceEnv): Promise<WalletBalance[]> {
  const db = requireDb(env);
  const result = await db
    .prepare(
      `SELECT a.name AS account,
              COALESCE(SUM(CASE WHEN l.debit_account = a.name THEN l.amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN l.credit_account = a.name THEN l.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN ledger l ON (l.debit_account = a.name OR l.credit_account = a.name) AND l.is_reversed = 0
       WHERE a.name LIKE 'assets:wallets:%'
       GROUP BY a.name
       ORDER BY a.name`,
    )
    .all<{ account: string; balance: number }>();

  return result.results.map((row) => ({
    account: row.account,
    wallet: row.account.replace("assets:wallets:", ""),
    balance: Number(row.balance),
  }));
}

async function getDebtsSummary(env: FinanceEnv): Promise<DebtBalance[]> {
  const db = requireDb(env);
  const result = await db
    .prepare(
      `SELECT a.name AS account,
              COALESCE(SUM(CASE WHEN l.debit_account = a.name THEN l.amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN l.credit_account = a.name THEN l.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN ledger l ON (l.debit_account = a.name OR l.credit_account = a.name) AND l.is_reversed = 0
       WHERE a.name LIKE 'assets:receivables:%' OR a.name LIKE 'liabilities:payables:%'
       GROUP BY a.name
       HAVING balance != 0
       ORDER BY a.name`,
    )
    .all<{ account: string; balance: number }>();

  return result.results.map((row) => {
    const isReceivable = row.account.startsWith("assets:receivables:");
    return {
      account: row.account,
      person: row.account.replace(isReceivable ? "assets:receivables:" : "liabilities:payables:", ""),
      direction: isReceivable ? "lend" : "owe",
      balance: Math.abs(Number(row.balance)),
    };
  });
}

async function getFinanceBalances(env: FinanceEnv): Promise<FinanceBalances> {
  const db = requireDb(env);
  const categories = await db
    .prepare(
      `SELECT a.name AS account, a.type AS type,
              COALESCE(SUM(CASE WHEN l.debit_account = a.name THEN l.amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN l.credit_account = a.name THEN l.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN ledger l ON (l.debit_account = a.name OR l.credit_account = a.name) AND l.is_reversed = 0
       WHERE a.name LIKE 'expenses:%' OR a.name LIKE 'income:%'
       GROUP BY a.name, a.type
       HAVING balance != 0
       ORDER BY a.name`,
    )
    .all<{ account: string; type: "expense" | "income"; balance: number }>();

  const categoryBalances = categories.results.map((row) => ({
    account: row.account,
    category: row.account.replace(row.type === "expense" ? "expenses:" : "income:", ""),
    type: row.type,
    balance: Math.abs(Number(row.balance)),
  }));

  const enriched = await enrichCategoriesWithBudgets(env, categoryBalances as EnrichedCategory[]);

  return {
    wallets: await listWallets(env),
    debts: await getDebtsSummary(env),
    categories: enriched,
  };
}

async function getLedger(env: FinanceEnv, limit = 100): Promise<LedgerEntry[]> {
  const db = requireDb(env);
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const result = await db
    .prepare("SELECT * FROM ledger WHERE is_reversed = 0 ORDER BY id DESC LIMIT ?")
    .bind(safeLimit)
    .all<LedgerEntry>();

  return result.results;
}

type LedgerFilter = {
  from?: string;
  to?: string;
  wallet?: string;
  category?: string;
  type?: string;
  person?: string;
  includeReversed?: boolean;
};

type FilteredLedgerResult = {
  items: LedgerEntry[];
  total: number;
};

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function getFilteredLedger(env: FinanceEnv, filter: LedgerFilter, page: number, pageSize: number): Promise<{ items: LedgerEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const db = requireDb(env);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!filter.includeReversed) {
    conditions.push("is_reversed = 0");
  }

  if (filter.from) {
    if (!isValidDate(filter.from)) {
      throw new Error("Invalid 'from' date format. Use YYYY-MM-DD.");
    }
    conditions.push("created_at >= ?");
    params.push(filter.from + "T00:00:00Z");
  }

  if (filter.to) {
    if (!isValidDate(filter.to)) {
      throw new Error("Invalid 'to' date format. Use YYYY-MM-DD.");
    }
    conditions.push("created_at <= ?");
    params.push(filter.to + "T23:59:59Z");
  }

  if (filter.wallet) {
    const wallet = `assets:wallets:${slug(filter.wallet)}`;
    conditions.push("(debit_account = ? OR credit_account = ?)");
    params.push(wallet, wallet);
  }

  if (filter.category) {
    conditions.push("category = ?");
    params.push(slug(filter.category));
  }

  if (filter.person) {
    conditions.push("person = ?");
    params.push(slug(filter.person));
  }

  if (filter.type) {
    if (filter.type === "debt") {
      conditions.push("(debit_account LIKE 'assets:receivables:%' OR debit_account LIKE 'liabilities:payables:%' OR credit_account LIKE 'assets:receivables:%' OR credit_account LIKE 'liabilities:payables:%')");
    } else if (filter.type === "expense") {
      conditions.push("debit_account LIKE 'expenses:%'");
    } else if (filter.type === "income") {
      conditions.push("credit_account LIKE 'income:%'");
    }
  }

  const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM ledger ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const offset = (page - 1) * pageSize;
  const rows = await db
    .prepare(`SELECT * FROM ledger ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, offset)
    .all<LedgerEntry>();

  return {
    items: rows.results,
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

async function reverseTransaction(env: FinanceEnv, id: number): Promise<{ reversalId: number }> {
  const db = requireDb(env);
  const original = await db
    .prepare("SELECT * FROM ledger WHERE id = ?")
    .bind(id)
    .first<LedgerEntry>();

  if (!original) {
    throw new Error("Transaction not found");
  }

  if (original.is_reversed === 1) {
    throw new Error("Transaction is already reversed");
  }

  const reversalDescription = `[REVERSAL] ${original.description ?? ""}`;
  const result = await db
    .prepare(
      "INSERT INTO ledger (debit_account, credit_account, amount, description, category, person) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      original.credit_account,
      original.debit_account,
      original.amount,
      reversalDescription,
      original.category ?? null,
      original.person ?? null,
    )
    .run();

  const reversalId = result.meta.last_row_id;
  await db
    .prepare("UPDATE ledger SET is_reversed = 1, reversed_entry_id = ? WHERE id = ?")
    .bind(reversalId, id)
    .run();

  return { reversalId: Number(reversalId) };
}

async function editTransaction(
  env: FinanceEnv,
  id: number,
  updates: { amount?: number; description?: string; category?: string },
): Promise<{ reversalId: number; newEntryId: number }> {
  const db = requireDb(env);
  const original = await db
    .prepare("SELECT * FROM ledger WHERE id = ?")
    .bind(id)
    .first<LedgerEntry>();

  if (!original) {
    throw new Error("Transaction not found");
  }

  if (original.is_reversed === 1) {
    throw new Error("Transaction is already reversed");
  }

  const { reversalId } = await reverseTransaction(env, id);

  const newAmount = updates.amount ?? original.amount;
  const newDescription = updates.description ?? original.description ?? "";
  const newCategory = updates.category ?? original.category ?? null;

  if (!Number.isInteger(newAmount) || newAmount <= 0) {
    throw new Error("amount must be a positive integer");
  }
  if (!newDescription.trim()) {
    throw new Error("description is required");
  }

  const result = await db
    .prepare(
      "INSERT INTO ledger (debit_account, credit_account, amount, description, category, person) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      original.debit_account,
      original.credit_account,
      newAmount,
      newDescription,
      newCategory,
      original.person ?? null,
    )
    .run();

  return { reversalId, newEntryId: Number(result.meta.last_row_id) };
}

type PersonDebtDetail = {
  id: number;
  date: string;
  intent: string;
  amount: number;
  description: string | null;
  wallet: string | null;
};

type PersonDebtResult = {
  person: string;
  receivable: number;
  payable: number;
  net: number;
  direction: "they_owe_me" | "i_owe_them" | "settled";
  transactions: PersonDebtDetail[];
};

async function getPersonDebts(env: FinanceEnv, person: string): Promise<PersonDebtResult> {
  const db = requireDb(env);
  const personSlug = slug(person);
  const receivableAccount = `assets:receivables:${personSlug}`;
  const payableAccount = `liabilities:payables:${personSlug}`;

  const receivableRow = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN l.debit_account = ? THEN l.amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN l.credit_account = ? THEN l.amount ELSE 0 END), 0) AS balance
       FROM ledger l
       WHERE (l.debit_account = ? OR l.credit_account = ?) AND l.is_reversed = 0`,
    )
    .bind(receivableAccount, receivableAccount, receivableAccount, receivableAccount)
    .first<{ balance: number }>();

  const payableRow = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN l.debit_account = ? THEN l.amount ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN l.credit_account = ? THEN l.amount ELSE 0 END), 0) AS balance
       FROM ledger l
       WHERE (l.debit_account = ? OR l.credit_account = ?) AND l.is_reversed = 0`,
    )
    .bind(payableAccount, payableAccount, payableAccount, payableAccount)
    .first<{ balance: number }>();

  const receivable = Math.abs(Number(receivableRow?.balance ?? 0));
  const payable = Math.abs(Number(payableRow?.balance ?? 0));
  const net = receivable - payable;

  const direction: PersonDebtResult["direction"] = net > 0 ? "they_owe_me" : net < 0 ? "i_owe_them" : "settled";

  const transactionsResult = await db
    .prepare(
      `SELECT id, created_at, debit_account, credit_account, amount, description
       FROM ledger
       WHERE (debit_account = ? OR credit_account = ? OR debit_account = ? OR credit_account = ?)
         AND is_reversed = 0
       ORDER BY id DESC LIMIT 50`,
    )
    .bind(receivableAccount, receivableAccount, payableAccount, payableAccount)
    .all<{
      id: number;
      created_at: string;
      debit_account: string;
      credit_account: string;
      amount: number;
      description: string | null;
    }>();

  const transactions: PersonDebtDetail[] = transactionsResult.results.map((row) => {
    let intent = "transaction";
    let wallet: string | null = null;

    if (row.debit_account.startsWith("assets:receivables:")) {
      intent = "debt_lend";
      wallet = row.credit_account.replace("assets:wallets:", "");
    } else if (row.credit_account.startsWith("assets:receivables:")) {
      intent = "debt_lend_collect";
      wallet = row.debit_account.replace("assets:wallets:", "");
    } else if (row.debit_account.startsWith("liabilities:payables:")) {
      intent = "debt_owe_pay";
      wallet = row.credit_account.replace("assets:wallets:", "");
    } else if (row.credit_account.startsWith("liabilities:payables:")) {
      intent = "debt_owe";
      wallet = null;
    } else if (row.debit_account.startsWith("assets:wallets:") && row.credit_account.startsWith("liabilities:payables:")) {
      intent = "debt_borrow";
      wallet = row.debit_account.replace("assets:wallets:", "");
    } else if (row.debit_account.startsWith("liabilities:payables:") && row.credit_account.startsWith("assets:wallets:")) {
      intent = "debt_borrow_pay";
      wallet = row.credit_account.replace("assets:wallets:", "");
    }

    return {
      id: row.id,
      date: row.created_at,
      intent,
      amount: row.amount,
      description: row.description,
      wallet,
    };
  });

  return {
    person: personSlug,
    receivable,
    payable,
    net,
    direction,
    transactions,
  };
}

async function addReminder(env: FinanceEnv, input: AddReminderInput): Promise<FinanceToolResult> {
  const db = requireDb(env);
  validateAmount(input.amount);
  if (input.direction !== "owe" && input.direction !== "lend") {
    throw new Error("direction must be owe or lend");
  }

  await db
    .prepare("INSERT INTO debt_reminders (person, amount, due_date, direction, note) VALUES (?, ?, ?, ?, ?)")
    .bind(slug(input.person), input.amount, input.due_date, input.direction, input.note ?? null)
    .run();

  return { text: `Reminder added for ${slug(input.person)} on ${input.due_date}.` };
}

async function settleReminderByContext(env: FinanceEnv, person: string, amount?: number): Promise<FinanceToolResult> {
  const db = requireDb(env);
  const name = slug(person);
  if (amount !== undefined) {
    validateAmount(amount);
    await db
      .prepare("UPDATE debt_reminders SET is_paid = 1 WHERE person = ? AND amount = ? AND is_paid = 0")
      .bind(name, amount)
      .run();
  } else {
    await db.prepare("UPDATE debt_reminders SET is_paid = 1 WHERE person = ? AND is_paid = 0").bind(name).run();
  }

  return { text: `Settled reminders for ${name}.` };
}

async function getReminders(env: FinanceEnv, includePaid = false): Promise<Reminder[]> {
  const db = requireDb(env);
  const query = includePaid
    ? "SELECT * FROM debt_reminders ORDER BY due_date ASC, id ASC LIMIT 100"
    : "SELECT * FROM debt_reminders WHERE is_paid = 0 ORDER BY due_date ASC, id ASC LIMIT 100";
  const result = await db.prepare(query).all<Reminder>();
  return result.results;
}

async function getDueReminders(env: FinanceEnv, today: string): Promise<Reminder[]> {
  const db = requireDb(env);
  const result = await db
    .prepare(
      "SELECT * FROM debt_reminders WHERE due_date <= ? AND is_paid = 0 AND reminded_at IS NULL ORDER BY due_date ASC, id ASC LIMIT 20",
    )
    .bind(today)
    .all<Reminder>();
  return result.results;
}

async function markReminderSent(env: FinanceEnv, id: number): Promise<void> {
  const db = requireDb(env);
  await db.prepare("UPDATE debt_reminders SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
}

function formatIdr(amount: number): string {
  return amount.toLocaleString("id-ID");
}

function formatWallets(wallets: WalletBalance[]): string {
  if (wallets.length === 0) {
    return "No wallets found yet.";
  }

  return ["Wallets:", ...wallets.map((wallet) => `- ${wallet.wallet}: ${formatIdr(wallet.balance)}`)].join("\n");
}

function formatDebts(debts: DebtBalance[]): string {
  if (debts.length === 0) {
    return "No active debts found.";
  }

  return [
    "Debts:",
    ...debts.map((debt) => {
      const label = debt.direction === "lend" ? "owes you" : "you owe";
      return `- ${debt.person}: ${label} ${formatIdr(debt.balance)}`;
    }),
  ].join("\n");
}

async function executeFinanceToolCall(env: FinanceEnv, name: string, args: Record<string, unknown>): Promise<FinanceToolResult> {
  switch (name) {
    case "record_transaction":
      return recordTransaction(env, args as RecordTransactionInput);
    case "create_new_wallet":
      return createNewWallet(env, args as CreateWalletInput);
    case "get_wallets": {
      const wallets = await listWallets(env);
      return { text: formatWallets(wallets), data: wallets };
    }
    case "get_debts_summary": {
      const debts = await getDebtsSummary(env);
      return { text: formatDebts(debts), data: debts };
    }
    case "add_reminder":
      return addReminder(env, args as AddReminderInput);
    case "settle_reminder_by_context":
      return settleReminderByContext(env, String(args.person ?? ""), args.amount as number | undefined);
    default:
      throw new Error(`Unsupported finance tool: ${name}`);
  }
}

export {
  addReminder,
  createNewWallet,
  editTransaction,
  executeFinanceToolCall,
  getDebtsSummary,
  getDueReminders,
  getFilteredLedger,
  getFinanceBalances,
  getLedger,
  getPersonDebts,
  getReminders,
  listWallets,
  markReminderSent,
  recordTransaction,
  reverseTransaction,
  slug,
};
export type {
  AddReminderInput,
  CategoryBalance,
  CreateWalletInput,
  DebtBalance,
  FinanceBalances,
  FinanceEnv,
  FinanceIntentType,
  FinanceToolResult,
  LedgerEntry,
  LedgerFilter,
  PersonDebtResult,
  RecordTransactionInput,
  Reminder,
  ReminderDirection,
  WalletBalance,
};
