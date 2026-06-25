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
       LEFT JOIN ledger l ON l.debit_account = a.name OR l.credit_account = a.name
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
       LEFT JOIN ledger l ON l.debit_account = a.name OR l.credit_account = a.name
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
       LEFT JOIN ledger l ON l.debit_account = a.name OR l.credit_account = a.name
       WHERE a.name LIKE 'expenses:%' OR a.name LIKE 'income:%'
       GROUP BY a.name, a.type
       HAVING balance != 0
       ORDER BY a.name`,
    )
    .all<{ account: string; type: "expense" | "income"; balance: number }>();

  return {
    wallets: await listWallets(env),
    debts: await getDebtsSummary(env),
    categories: categories.results.map((row) => ({
      account: row.account,
      category: row.account.replace(row.type === "expense" ? "expenses:" : "income:", ""),
      type: row.type,
      balance: Math.abs(Number(row.balance)),
    })),
  };
}

async function getLedger(env: FinanceEnv, limit = 100): Promise<LedgerEntry[]> {
  const db = requireDb(env);
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const result = await db
    .prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?")
    .bind(safeLimit)
    .all<LedgerEntry>();

  return result.results;
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
  executeFinanceToolCall,
  getDebtsSummary,
  getDueReminders,
  getFinanceBalances,
  getLedger,
  getReminders,
  listWallets,
  markReminderSent,
  recordTransaction,
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
  RecordTransactionInput,
  Reminder,
  ReminderDirection,
  WalletBalance,
};
