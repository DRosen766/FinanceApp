// Pure budget logic: map transactions to budget categories, summarize a month, parse input.
// No secrets, no I/O. Budget amounts themselves live encrypted in the DB (server/db.ts).
import type { TxRow } from "./transactions";

export type BudgetGroup = "basics" | "spending";

/** Budget categories, in display order. Ids are stored in the DB: never rename a shipped id. */
export const BUDGET_CATEGORIES = [
  { id: "earnings", name: "Earnings", group: "basics" },
  { id: "bills", name: "Bills & Utilities", group: "basics" },
  { id: "dining", name: "Dining & Drinks", group: "spending" },
  { id: "entertainment", name: "Entertainment & Rec.", group: "spending" },
  { id: "groceries", name: "Groceries", group: "spending" },
  { id: "hygiene", name: "Hygiene", group: "spending" },
  { id: "medical", name: "Medical", group: "spending" },
  { id: "personal_care", name: "Personal Care", group: "spending" },
  { id: "rideshare", name: "Rideshare", group: "spending" },
  { id: "shopping", name: "Shopping", group: "spending" },
  { id: "software", name: "Software & Tech", group: "spending" },
  { id: "transit", name: "Transit", group: "spending" },
  { id: "travel", name: "Travel & Vacation", group: "spending" },
  { id: "everything_else", name: "Everything Else", group: "spending" },
] as const satisfies readonly { id: string; name: string; group: BudgetGroup }[];

export type CategoryId = (typeof BUDGET_CATEGORIES)[number]["id"];
export const CATEGORY_IDS: readonly CategoryId[] = BUDGET_CATEGORIES.map((c) => c.id);
const ID_SET = new Set<string>(CATEGORY_IDS);
export const isCategoryId = (v: string): v is CategoryId => ID_SET.has(v);

/** Not budgeted: moves money between your own accounts (or pays a card already counted). */
export const TRANSFER = "transfer" as const;
export type Assignment = CategoryId | typeof TRANSFER;

// Plaid personal_finance_category → budget category. Detailed wins over primary.
const BY_DETAILED: Record<string, Assignment> = {
  // Card purchases are already counted as spending; paying the card is not new spending.
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: TRANSFER,
  FOOD_AND_DRINK_GROCERIES: "groceries",
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: "groceries",
  GENERAL_MERCHANDISE_ELECTRONICS: "software",
  GENERAL_SERVICES_INSURANCE: "bills",
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "rideshare",
};
const BY_PRIMARY: Record<string, Assignment> = {
  INCOME: "earnings",
  TRANSFER_IN: TRANSFER,
  TRANSFER_OUT: TRANSFER,
  LOAN_PAYMENTS: "bills",
  RENT_AND_UTILITIES: "bills",
  FOOD_AND_DRINK: "dining",
  ENTERTAINMENT: "entertainment",
  MEDICAL: "medical",
  PERSONAL_CARE: "personal_care",
  TRANSPORTATION: "transit",
  GENERAL_MERCHANDISE: "shopping",
  TRAVEL: "travel",
};

/**
 * Budget category for a row, or null when the row isn't part of budgeting at all.
 * Investment activity (buys, sells, dividends inside a brokerage) is not budgeted; money
 * moving into or out of a brokerage shows up on the cash side as a transfer.
 */
export function categorize(row: TxRow): Assignment | null {
  if (row.kind !== "cash") return null;
  if (row.categoryDetailed && BY_DETAILED[row.categoryDetailed]) return BY_DETAILED[row.categoryDetailed];
  if (row.category && BY_PRIMARY[row.category]) return BY_PRIMARY[row.category];
  return "everything_else";
}

// ---------------------------------------------------------------- months

/** "YYYY-MM" */
export type Month = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function monthOf(today: Date): Month {
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(m: Month, n: number): Month {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return monthOf(d);
}

/** Inclusive first and last YYYY-MM-DD of a month. */
export function monthRange(m: Month): { from: string; to: string; days: number } {
  const [y, mo] = m.split("-").map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(days).padStart(2, "0")}`, days };
}

export function monthLabel(m: Month): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Valid month from 2000-01 up to next month; anything else falls back to the current month. */
export function parseMonth(v: unknown, today: Date): Month {
  const current = monthOf(today);
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== "string" || !MONTH_RE.test(raw)) return current;
  return raw >= "2000-01" && raw <= addMonths(current, 1) ? raw : current;
}

// ---------------------------------------------------------------- summary

export type CategoryLine = {
  id: CategoryId;
  name: string;
  group: BudgetGroup;
  budgeted: number | null;
  /** Spending categories: net money out. Earnings: net money in. Refunds reduce spending. */
  actual: number;
  /** budgeted − actual; null without a budget. Negative = over budget (or earnings short). */
  remaining: number | null;
  /** Average monthly actual over up to 3 full months before this one; null with no history. */
  avg3: number | null;
  rows: TxRow[];
};

export type BudgetSummary = {
  month: Month;
  lines: CategoryLine[];
  transfers: TxRow[];
  spendingBudget: number;
  currentSpend: number;
  remaining: number;
  /** Earnings budget − bills budget − spending budget. */
  leftForSavings: number;
  /** Days left in the month including today; null unless `month` is the current month. */
  daysLeft: number | null;
};

const signed = (id: CategoryId, amount: number) => (id === "earnings" ? -amount : amount);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Summarize one month. `historyStart` is the earliest stored cash transaction date: months
 * that begin before it are partial and are left out of the 3-month average.
 * Pending transactions count, so the current month is up to date.
 */
export function summarizeBudget(
  rows: TxRow[],
  month: Month,
  amounts: Map<string, number>,
  today: Date,
  historyStart: string | null,
): BudgetSummary {
  const { from, to, days } = monthRange(month);
  const todayIso = today.toISOString().slice(0, 10);
  const avgMonths = [1, 2, 3]
    .map((n) => monthRange(addMonths(month, -n)))
    // Only full months: not before history begins, and not the (partial) current month.
    .filter((r) => historyStart !== null && r.from >= monthStartAfter(historyStart) && r.to < todayIso);
  const avgFrom = avgMonths.length ? avgMonths[avgMonths.length - 1].from : null;
  const avgTo = avgMonths.length ? avgMonths[0].to : null;

  const actual = new Map<CategoryId, number>();
  const prior = new Map<CategoryId, number>();
  const byCat = new Map<CategoryId, TxRow[]>();
  const transfers: TxRow[] = [];
  for (const r of rows) {
    const a = categorize(r);
    if (a === null) continue;
    const inMonth = r.date >= from && r.date <= to;
    if (a === TRANSFER) {
      if (inMonth) transfers.push(r);
      continue;
    }
    if (inMonth) {
      actual.set(a, (actual.get(a) ?? 0) + signed(a, r.amount));
      byCat.set(a, [...(byCat.get(a) ?? []), r]);
    } else if (avgFrom && avgTo && r.date >= avgFrom && r.date <= avgTo) {
      prior.set(a, (prior.get(a) ?? 0) + signed(a, r.amount));
    }
  }

  const lines: CategoryLine[] = BUDGET_CATEGORIES.map((c) => {
    const budgeted = amounts.get(c.id) ?? null;
    const act = round2(actual.get(c.id) ?? 0);
    return {
      id: c.id,
      name: c.name,
      group: c.group,
      budgeted,
      actual: act,
      remaining: budgeted === null ? null : round2(budgeted - act),
      avg3: avgMonths.length ? round2((prior.get(c.id) ?? 0) / avgMonths.length) : null,
      rows: byCat.get(c.id) ?? [],
    };
  });

  const spending = lines.filter((l) => l.group === "spending");
  const spendingBudget = round2(spending.reduce((s, l) => s + (l.budgeted ?? 0), 0));
  const currentSpend = round2(spending.reduce((s, l) => s + l.actual, 0));
  const budgetOf = (id: CategoryId) => amounts.get(id) ?? 0;
  const isCurrent = month === monthOf(today);
  return {
    month,
    lines,
    transfers,
    spendingBudget,
    currentSpend,
    remaining: round2(spendingBudget - currentSpend),
    leftForSavings: round2(budgetOf("earnings") - budgetOf("bills") - spendingBudget),
    daysLeft: isCurrent ? days - today.getUTCDate() + 1 : null,
  };
}

/** First day of the first full month on or after `isoDate`. */
function monthStartAfter(isoDate: string): string {
  const m = isoDate.slice(0, 7);
  return isoDate.endsWith("-01") ? `${m}-01` : `${addMonths(m, 1)}-01`;
}

// ---------------------------------------------------------------- form input

export const BUDGET_FIELD_PREFIX = "budget_";
export const MAX_BUDGET = 10_000_000;
const AMOUNT_RE = /^\d{1,8}(\.\d{1,2})?$/;

export type BudgetFormResult =
  | { ok: true; amounts: Map<CategoryId, number | null> }
  | { ok: false; invalid: CategoryId[] };

/**
 * Parse the budget form. Every known category must be present; blank clears its budget.
 * Accepts "1,250", "$1250.50"; rejects negatives, more than 2 decimals, and huge values.
 * Unknown fields are ignored, so a forged field can never create a new category row.
 */
export function parseBudgetForm(form: { get(name: string): unknown }): BudgetFormResult {
  const amounts = new Map<CategoryId, number | null>();
  const invalid: CategoryId[] = [];
  for (const id of CATEGORY_IDS) {
    const raw = form.get(BUDGET_FIELD_PREFIX + id);
    if (typeof raw !== "string") {
      invalid.push(id);
      continue;
    }
    const v = raw.trim().replace(/^\$/, "").replace(/,/g, "");
    if (v === "") {
      amounts.set(id, null);
      continue;
    }
    const n = Number(v);
    if (!AMOUNT_RE.test(v) || !Number.isFinite(n) || n > MAX_BUDGET) invalid.push(id);
    else amounts.set(id, n);
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, amounts };
}
