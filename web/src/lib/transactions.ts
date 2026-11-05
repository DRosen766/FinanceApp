// Pure filtering / summary logic for the Transactions page. No secrets, no I/O.
import { z } from "zod";

export type TxRow = {
  id: number;
  accountId: number;
  date: string; // YYYY-MM-DD
  pending: boolean;
  name: string;
  merchantName: string | null;
  /** Plaid convention: positive = money out, negative = money in. */
  amount: number;
  currency: string | null;
  category: string | null;
};

export const RANGES = ["30", "90", "365", "all"] as const;
export const FLOWS = ["all", "in", "out"] as const;
export const PAGE_SIZE = 100;

export type Filters = {
  account: number | null;
  range: (typeof RANGES)[number];
  q: string;
  flow: (typeof FLOWS)[number];
  page: number;
};

export const DEFAULT_FILTERS: Filters = { account: null, range: "90", q: "", flow: "all", page: 1 };

type RawParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Each field falls back to its default independently, so one bad param doesn't reset the rest. */
export function parseFilters(params: RawParams): Filters {
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const r = schema.safeParse(value);
    return r.success ? r.data : fallback;
  };
  return {
    account: pick(z.coerce.number().int().positive(), first(params.account), null as number | null),
    range: pick(z.enum(RANGES), first(params.range), DEFAULT_FILTERS.range),
    q: pick(z.string().trim().max(100), first(params.q) ?? "", ""),
    flow: pick(z.enum(FLOWS), first(params.flow), DEFAULT_FILTERS.flow),
    page: pick(z.coerce.number().int().min(1).max(100_000), first(params.page), 1),
  };
}

/** Date `days` before `today` (YYYY-MM-DD, UTC), inclusive lower bound. */
export function cutoffDate(range: Filters["range"], today: Date): string | null {
  if (range === "all") return null;
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - Number(range));
  return d.toISOString().slice(0, 10);
}

export function applyFilters(rows: TxRow[], f: Filters, today = new Date()): TxRow[] {
  const cutoff = cutoffDate(f.range, today);
  const q = f.q.toLowerCase();
  return rows
    .filter((r) => f.account === null || r.accountId === f.account)
    .filter((r) => cutoff === null || r.date >= cutoff)
    .filter((r) => f.flow === "all" || (f.flow === "out" ? r.amount > 0 : r.amount < 0))
    .filter(
      (r) =>
        q === "" ||
        r.name.toLowerCase().includes(q) ||
        (r.merchantName?.toLowerCase().includes(q) ?? false),
    )
    .sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? 1 : -1) : Number(b.pending) - Number(a.pending) || b.id - a.id,
    );
}

export type TxSummary = { count: number; moneyIn: number; moneyOut: number };

/** moneyIn / moneyOut are both positive magnitudes. */
export function summarize(rows: TxRow[]): TxSummary {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const r of rows) {
    if (r.amount > 0) moneyOut += r.amount;
    else moneyIn += -r.amount;
  }
  return { count: rows.length, moneyIn, moneyOut };
}

export function paginate<T>(rows: T[], page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages };
}

/** "FOOD_AND_DRINK" → "Food and drink". */
export function prettyCategory(category: string | null): string {
  if (!category) return "—";
  const s = category.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Query string for a filter set, omitting defaults (used for pagination links). */
export function toQuery(f: Filters, overrides: Partial<Filters> = {}): string {
  const merged = { ...f, ...overrides };
  const p = new URLSearchParams();
  if (merged.account !== null) p.set("account", String(merged.account));
  if (merged.range !== DEFAULT_FILTERS.range) p.set("range", merged.range);
  if (merged.q) p.set("q", merged.q);
  if (merged.flow !== DEFAULT_FILTERS.flow) p.set("flow", merged.flow);
  if (merged.page !== 1) p.set("page", String(merged.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}
