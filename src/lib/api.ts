export type ApiAccount = {
  id: number;
  username: string;
  displayName: string;
};

export type WalletBalance = {
  account: string;
  wallet: string;
  balance: number;
};

export type DebtBalance = {
  account: string;
  person: string;
  direction: "lend" | "owe";
  balance: number;
};

export type CategoryBalance = {
  account: string;
  category: string;
  type: "expense" | "income";
  balance: number;
  budget?: number;
  budgetPeriod?: "monthly" | "weekly";
  usagePercent?: number;
  status?: "ok" | "warning" | "over";
};

export type FinanceSummary = {
  wallets: WalletBalance[];
  debts: DebtBalance[];
  categories: CategoryBalance[];
};

export type LedgerEntry = {
  id: number;
  debit_account: string;
  credit_account: string;
  amount: number;
  description: string | null;
  category: string | null;
  person: string | null;
  created_at: string;
  is_reversed: number;
  reversed_entry_id: number | null;
};

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type HabitWithStatus = {
  id: number;
  name: string;
  description: string | null;
  frequency: "daily" | "weekly";
  targetDays: number[] | null;
  checkedToday: boolean;
  currentStreak: number;
  bestStreak: number;
  completionThisMonth: number;
};

export type Budget = {
  id: number;
  category: string;
  amount: number;
  period: "monthly" | "weekly";
  createdAt: string;
  updatedAt: string;
};

export type PersonDebtResult = {
  person: string;
  receivable: number;
  payable: number;
  net: number;
  direction: "they_owe_me" | "i_owe_them" | "settled";
  transactions: Array<{
    id: number;
    date: string;
    intent: string;
    amount: number;
    description: string | null;
    wallet: string | null;
  }>;
};

const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "";

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && typeof options.body === "string") {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(body?.error?.message ?? `API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDateShort(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
  }).format(date);
}

export type {
  ApiAccount,
  Budget,
  CategoryBalance,
  DebtBalance,
  FinanceSummary,
  HabitWithStatus,
  LedgerEntry,
  PaginatedResponse,
  PersonDebtResult,
  WalletBalance,
};
