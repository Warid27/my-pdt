type FinanceToolName =
  | "record_transaction"
  | "create_new_wallet"
  | "get_wallets"
  | "get_debts_summary"
  | "add_reminder"
  | "settle_reminder_by_context";

type FinanceToolCall = {
  name: FinanceToolName;
  arguments: Record<string, unknown>;
};

type ToolDefinition = {
  type: "function";
  function: {
    name: FinanceToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const financeTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "record_transaction",
      description: "Record a personal finance event through backend-owned double-entry ledger routing.",
      parameters: {
        type: "object",
        properties: {
          intent_type: {
            type: "string",
            enum: [
              "expense",
              "income",
              "income_gift",
              "debt_lend",
              "debt_lend_collect",
              "debt_owe",
              "debt_owe_pay",
              "debt_borrow",
              "debt_borrow_pay",
              "debt_loan",
              "debt_loan_collect",
            ],
          },
          amount: { type: "integer", minimum: 1 },
          description: { type: "string" },
          wallet_name: { type: "string" },
          person: { type: "string" },
          category: { type: "string" },
        },
        required: ["intent_type", "amount", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_new_wallet",
      description: "Create a new wallet after user confirmation and seed it with an optional initial balance.",
      parameters: {
        type: "object",
        properties: {
          wallet_name: { type: "string" },
          initial_balance: { type: "integer", minimum: 0 },
        },
        required: ["wallet_name", "initial_balance"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wallets",
      description: "List existing wallets and computed balances before resolving ambiguous wallet names.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_debts_summary",
      description: "Return aggregated receivable and payable balances by person.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "add_reminder",
      description: "Create a debt payment reminder.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          amount: { type: "integer", minimum: 1 },
          due_date: { type: "string" },
          direction: { type: "string", enum: ["owe", "lend"] },
          note: { type: "string" },
        },
        required: ["person", "amount", "due_date", "direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "settle_reminder_by_context",
      description: "Mark unpaid reminders as paid using person and optional amount context.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          amount: { type: "integer", minimum: 1 },
        },
        required: ["person"],
      },
    },
  },
];

const financeToolNames = new Set<FinanceToolName>(financeTools.map((tool) => tool.function.name));

function isFinanceToolName(value: string): value is FinanceToolName {
  return financeToolNames.has(value as FinanceToolName);
}

export { financeTools, isFinanceToolName };
export type { FinanceToolCall, FinanceToolName, ToolDefinition };
