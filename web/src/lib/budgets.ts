// Pure budget logic: map transactions to budget categories, summarize a month, parse input.
// No secrets, no I/O. Budget amounts themselves live encrypted in the DB (server/db.ts).
import type { TxRow } from "./transactions";

/** "excluded": tracked and listed, but never budgeted and not counted in monthly spending. */
export type BudgetGroup = "basics" | "spending" | "excluded";

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
  { id: "education", name: "Education", group: "excluded" },
] as const satisfies readonly { id: string; name: string; group: BudgetGroup }[];

export type CategoryId = (typeof BUDGET_CATEGORIES)[number]["id"];
export const CATEGORY_IDS: readonly CategoryId[] = BUDGET_CATEGORIES.map((c) => c.id);
const ID_SET = new Set<string>(CATEGORY_IDS);
export const isCategoryId = (v: string): v is CategoryId => ID_SET.has(v);
const EXCLUDED = new Set<string>(BUDGET_CATEGORIES.filter((c) => c.group === "excluded").map((c) => c.id));
export const isExcluded = (id: string) => EXCLUDED.has(id);
/** Categories that take a budget (everything except the excluded group). */
export const BUDGETABLE_IDS: readonly CategoryId[] = CATEGORY_IDS.filter((id) => !EXCLUDED.has(id));

/** Not budgeted: moves money between your own accounts (or pays a card already counted). */
export const TRANSFER = "transfer" as const;
export type Assignment = CategoryId | typeof TRANSFER;
export const isAssignment = (v: string): v is Assignment => v === TRANSFER || ID_SET.has(v);

/** Dropdown value meaning "no manual choice: use the automatic category". */
export const AUTO = "auto" as const;
/** What a transaction's category can be set to by hand, in display order. */
export const ASSIGNMENT_OPTIONS: readonly { value: Assignment; label: string }[] = [
  ...BUDGET_CATEGORIES.map((c) => ({ value: c.id, label: c.name })),
  { value: TRANSFER, label: "Not budgeted" },
];
export const assignmentLabel = (a: Assignment): string =>
  ASSIGNMENT_OPTIONS.find((o) => o.value === a)?.label ?? a;

/**
 * Parse the manual-category form: a positive integer transaction id and either AUTO (clear the
 * manual choice) or a known assignment. Anything else is rejected.
 */
export function parseCategoryChoice(
  form: FormData,
): { id: number; category: Assignment | typeof AUTO } | null {
  const id = form.get("id");
  const category = form.get("category");
  if (typeof id !== "string" || !/^[1-9]\d{0,15}$/.test(id)) return null;
  if (typeof category !== "string" || (category !== AUTO && !isAssignment(category))) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? { id: n, category } : null;
}

// Descriptor rules, checked before Plaid's category. Keep these generic (merchant-level),
// never tied to the owner's own data.
const BY_NAME: [RegExp, Assignment][] = [
  // Only Whole Foods / Amazon Fresh deliveries take tips.
  [/\bamazon tips?\b/i, "groceries"],
  // Software, SaaS and cloud vendors. Plaid files most of these under
  // GENERAL_SERVICES_OTHER_GENERAL_SERVICES, which also holds unrelated services, so match the
  // vendor. Checked before Plaid's category so AWS doesn't land in Shopping with other Amazon.
  [
    /\b(amazon web services|aws|anthropic|claude\.ai|openai|chatgpt|github|gitlab|vercel|netlify|heroku|cloudflare|digitalocean|linode|supabase|supa|google (cloud|workspace|one|storage)|gsuite|microsoft|msft|apple\.com\/bill|icloud|adobe|dropbox|notion|obsidian|any\.do|todoist|evernote|1password|lastpass|bitwarden|nordvpn|expressvpn|jetbrains|cursor|figma|canva|zoom\.us|slack|elevenlabs|perplexity|midjourney|rocket money|squarespace|godaddy|namecheap|backblaze)\b/i,
    "software",
  ],
  // Card rewards are money in, not a refund of whatever Plaid guessed (usually OTHER_OTHER).
  [/\b(cash ?back|travel|statement) rewards?\b|\brewards? (credit|redemption)\b/i, "earnings"],
  // Fund trades settling in a cash-management account move money between your own holdings.
  [/\byou (sold|bought)\b/i, TRANSFER],
  // Intercity rail and coach are trips, not commuting; Plaid files them as PUBLIC_TRANSIT.
  [/\b(amtrak|via rail|greyhound|megabus|flixbus|peter pan bus|brightline|acela)\b/i, "travel"],
];

// Plaid personal_finance_category → budget category. Detailed wins over primary.
const BY_DETAILED: Record<string, Assignment> = {
  // Card purchases are already counted as spending; paying the card is not new spending.
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: TRANSFER,
  FOOD_AND_DRINK_GROCERIES: "groceries",
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: "groceries",
  GENERAL_MERCHANDISE_ELECTRONICS: "software",
  GENERAL_SERVICES_INSURANCE: "bills",
  GENERAL_SERVICES_EDUCATION: "education",
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
 * Budget category for a row, or null when the row isn't part of budgeting at all. Order: a
 * per-transaction override (row.budgetCategory), descriptor rules, then Plaid's category.
 * Investment activity (buys, sells, dividends inside a brokerage) is not budgeted; money
 * moving into or out of a brokerage shows up on the cash side as a transfer.
 */
export function categorize(row: TxRow): Assignment | null {
  if (row.kind !== "cash") return null;
  if (row.budgetCategory && isAssignment(row.budgetCategory)) return row.budgetCategory;
  const text = `${row.merchantName ?? ""} ${row.name}`;
  for (const [re, id] of BY_NAME) if (re.test(text)) return id;
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
  /**
   * Deficit carried in from earlier overspending (≤ 0; unspent budget doesn't roll over); null
   * for Earnings, without a budget this month, or before carryover tracking starts.
   */
  carryover: number | null;
  /** budgeted + carryover − actual; null without a budget. Negative = over (or earnings short). */
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
  /** Sum of spending categories' carryover. */
  carryover: number;
  currentSpend: number;
  /** Spending in excluded categories: shown, but not part of currentSpend or remaining. */
  excludedSpend: number;
  /** spendingBudget + carryover − currentSpend. */
  remaining: number;
  /** First month of the carryover tally, or null if there's no history yet. */
  trackingStart: Month | null;
  /** Earnings budget − bills budget − spending budget. */
  leftForSavings: number;
  /** Days left in the month including today; null unless `month` is the current month. */
  daysLeft: number | null;
};

const signed = (id: CategoryId, amount: number) => (id === "earnings" ? -amount : amount);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Summarize one month. `historyStart` is the earliest stored cash transaction date: months
 * that begin before it are partial and are left out of the 3-month average. `trackingStart`
 * is the first month of the carryover tally (see trackingStartMonth).
 * Pending transactions count, so the current month is up to date.
 */
export function summarizeBudget(
  rows: TxRow[],
  month: Month,
  entries: BudgetEntry[],
  today: Date,
  historyStart: string | null,
  trackingStart: Month | null,
): BudgetSummary {
  const amounts = budgetsFor(entries, month);
  const carry = carryoverInto(monthlyActuals(rows), entries, trackingStart, month);
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
    const budgeted = isExcluded(c.id) ? null : (amounts.get(c.id) ?? null);
    const act = round2(actual.get(c.id) ?? 0);
    const carryover = budgeted === null ? null : (carry.get(c.id) ?? null);
    return {
      id: c.id,
      name: c.name,
      group: c.group,
      budgeted,
      carryover,
      actual: act,
      remaining: budgeted === null ? null : round2(budgeted + (carryover ?? 0) - act),
      avg3: avgMonths.length ? round2((prior.get(c.id) ?? 0) / avgMonths.length) : null,
      rows: byCat.get(c.id) ?? [],
    };
  });

  const spending = lines.filter((l) => l.group === "spending");
  const spendingBudget = round2(spending.reduce((s, l) => s + (l.budgeted ?? 0), 0));
  const carryover = round2(spending.reduce((s, l) => s + (l.carryover ?? 0), 0));
  const currentSpend = round2(spending.reduce((s, l) => s + l.actual, 0));
  const excludedSpend = round2(lines.filter((l) => l.group === "excluded").reduce((s, l) => s + l.actual, 0));
  const budgetOf = (id: CategoryId) => amounts.get(id) ?? 0;
  const isCurrent = month === monthOf(today);
  return {
    month,
    lines,
    transfers,
    spendingBudget,
    carryover,
    currentSpend,
    excludedSpend,
    remaining: round2(spendingBudget + carryover - currentSpend),
    trackingStart,
    leftForSavings: round2(budgetOf("earnings") - budgetOf("bills") - spendingBudget),
    daysLeft: isCurrent ? days - today.getUTCDate() + 1 : null,
  };
}

/** First day of the first full month on or after `isoDate`. */
function monthStartAfter(isoDate: string): string {
  const m = isoDate.slice(0, 7);
  return isoDate.endsWith("-01") ? `${m}-01` : `${addMonths(m, 1)}-01`;
}

// ---------------------------------------------------------------- effective-dated budgets

/** A stored budget row: `amount` applies from `fromMonth` until the category's next row. */
export type BudgetEntry = { category: string; fromMonth: Month; amount: number | null };

/** Amount in effect for `month` per category (the latest row at or before it); no-budget rows omitted. */
export function budgetsFor(entries: BudgetEntry[], month: Month): Map<string, number> {
  const latest = new Map<string, BudgetEntry>();
  for (const e of entries) {
    if (e.fromMonth > month) continue;
    const cur = latest.get(e.category);
    if (!cur || e.fromMonth > cur.fromMonth) latest.set(e.category, e);
  }
  const out = new Map<string, number>();
  for (const [c, e] of latest) if (e.amount !== null) out.set(c, e.amount);
  return out;
}

/** Only the submitted amounts that differ from what's in effect for `month`. */
export function changedBudgets(
  entries: BudgetEntry[],
  month: Month,
  submitted: Map<CategoryId, number | null>,
): Map<CategoryId, number | null> {
  const current = budgetsFor(entries, month);
  const out = new Map<CategoryId, number | null>();
  for (const [id, amount] of submitted) {
    if ((current.get(id) ?? null) !== amount) out.set(id, amount);
  }
  return out;
}

// ---------------------------------------------------------------- carryover

/**
 * First month of the carryover tally: the first full month in which every linked item has
 * stored history. Starting earlier would read a missing account's months as unspent budget.
 * `firstDates` is the earliest stored transaction date of each item that has any.
 */
export function trackingStartMonth(firstDates: string[]): Month | null {
  if (!firstDates.length) return null;
  const latest = firstDates.reduce((m, d) => (d > m ? d : m));
  return monthStartAfter(latest).slice(0, 7);
}

/** Net actual per month and budget category (same sign rules as the month view). */
export function monthlyActuals(rows: TxRow[]): Map<Month, Map<CategoryId, number>> {
  const out = new Map<Month, Map<CategoryId, number>>();
  for (const r of rows) {
    const a = categorize(r);
    if (a === null || a === TRANSFER) continue;
    const m = r.date.slice(0, 7);
    const byCat = out.get(m) ?? new Map<CategoryId, number>();
    byCat.set(a, (byCat.get(a) ?? 0) + signed(a, r.amount));
    out.set(m, byCat);
  }
  return out;
}

/**
 * Carryover into `month` per expense category: overspending carries forward as a deficit
 * (≤ 0) until later underspending pays it back; unspent budget does NOT roll forward, so a
 * month never has more to spend than its own budget. Each month from `start` up to, not
 * including, `month`: carry = min(0, carry + budget − actual). A month without a budget for a
 * category leaves its tally unchanged. Earnings has no carryover. Empty before `start`.
 */
export function carryoverInto(
  actuals: Map<Month, Map<CategoryId, number>>,
  entries: BudgetEntry[],
  start: Month | null,
  month: Month,
): Map<CategoryId, number> {
  const carry = new Map<CategoryId, number>();
  if (start === null || month < start) return carry;
  for (const c of BUDGET_CATEGORIES) if (c.id !== "earnings" && !isExcluded(c.id)) carry.set(c.id, 0);
  for (let m = start; m < month; m = addMonths(m, 1)) {
    const budgets = budgetsFor(entries, m);
    for (const id of carry.keys()) {
      const b = budgets.get(id);
      if (b === undefined) continue;
      carry.set(id, Math.min(0, carry.get(id)! + b - (actuals.get(m)?.get(id) ?? 0)));
    }
  }
  for (const [id, v] of carry) carry.set(id, round2(v));
  return carry;
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
  for (const id of BUDGETABLE_IDS) {
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
