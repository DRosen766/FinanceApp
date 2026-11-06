// Pure logic for the Projection page. No secrets, no I/O.
//
// Model: value(m) = today's balance + average monthly net flow × m. Investment growth (market
// returns, dividends, interest, capital gains) is deliberately excluded; only money moving into
// or out of an account counts. Flows are averaged over the trailing 90 days.
import { z } from "zod";
import type { TxRow } from "./transactions";

/** Default averaging window, in days. */
export const WINDOW_DAYS = 90;
export const AVG_MONTH_DAYS = 365.25 / 12;
const DAY_MS = 86_400_000;

/** Investment cash subtypes that are money in or out, not growth. */
const INVESTMENT_FLOW_SUBTYPES = new Set([
  "deposit",
  "contribution",
  "withdrawal",
  "distribution",
  "margin expense",
]);

/**
 * Whether a transaction counts as money in or out for the projection.
 * - Cash (bank/card) rows: all posted rows. Pending rows are skipped; they post later.
 * - Investment rows: fees, plus cash rows whose subtype is a deposit/contribution/withdrawal/
 *   distribution/margin expense. Dividends, interest, capital gains, buys, sells and in-kind
 *   transfers are growth or reshuffling and are excluded.
 */
export function countsForProjection(r: TxRow): boolean {
  if (r.kind === "cash") return !r.pending;
  if (r.investmentType === "fee") return true;
  return r.investmentType === "cash" && INVESTMENT_FLOW_SUBTYPES.has(r.investmentSubtype ?? "");
}

export type Flow = {
  /** Average money in per month (positive magnitude). */
  in: number;
  /** Average money out per month (positive magnitude). */
  out: number;
  /** in − out: positive means the account grows. */
  net: number;
  /** Days of history the average is based on (≤ the window length). */
  days: number;
  limited: boolean;
};

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Inclusive YYYY-MM-DD date range the averages are taken over. */
export type AvgWindow = { from: string; to: string };

const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const windowDays = (w: AvgWindow) => Math.round((dayMs(w.to) - dayMs(w.from)) / DAY_MS) + 1;

/** The last `days` days ending today, inclusive. */
export function presetWindow(days: number, today: Date): AvgWindow {
  const t = utcDay(today);
  return { from: isoDay(t - (days - 1) * DAY_MS), to: isoDay(t) };
}

/**
 * Average monthly in/out per account over an inclusive date window. `historyStart` gives, per
 * account, the earliest date stored data could exist from (the earliest stored transaction of
 * its link). If that is inside the window, the average is taken over the days actually covered
 * and flagged as limited.
 */
export function monthlyFlows(
  rows: TxRow[],
  window: AvgWindow,
  historyStart: Map<number, string>,
  accountIds: number[],
): Map<number, Flow> {
  const fullDays = windowDays(window);

  const sums = new Map<number, { in: number; out: number }>();
  for (const id of accountIds) sums.set(id, { in: 0, out: 0 });
  for (const r of rows) {
    const s = sums.get(r.accountId);
    if (!s || r.date < window.from || r.date > window.to || !countsForProjection(r)) continue;
    // Plaid: positive amount = money out of the account.
    if (r.amount > 0) s.out += r.amount;
    else s.in += -r.amount;
  }

  const out = new Map<number, Flow>();
  for (const [id, s] of sums) {
    const start = historyStart.get(id);
    let days = fullDays;
    if (start && start > window.from) days = Math.max(1, windowDays({ from: start, to: window.to }));
    days = Math.min(days, fullDays);
    const scale = AVG_MONTH_DAYS / days;
    const avgIn = s.in * scale;
    const avgOut = s.out * scale;
    out.set(id, {
      in: avgIn,
      out: avgOut,
      net: avgIn - avgOut,
      days,
      limited: days < fullDays,
    });
  }
  return out;
}

export type ProjAccount = {
  /** Stable key used in the URL: the internal account id. Never a Plaid id. */
  key: string;
  accountId: number | null;
  itemId: number;
  institution: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  /** Current balance; for credit/loan accounts, the amount owed. */
  balance: number;
  currency: string | null;
};

export type ProjLine = {
  key: string;
  label: string;
  institution: string;
  /** Today's balance. */
  value: number;
  flow: Flow;
  currency: string | null;
};

/** Credit cards and loans: left out of the projection (see buildLines). */
export const isLiability = (a: Pick<ProjAccount, "type">) => a.type === "credit" || a.type === "loan";

const ZERO_FLOW: Flow = {
  in: 0,
  out: 0,
  net: 0,
  days: Number.POSITIVE_INFINITY, // neutral for min() in addFlows
  limited: false,
};

function addFlows(a: Flow, b: Flow): Flow {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    net: a.net + b.net,
    days: Math.min(a.days, b.days),
    limited: a.limited || b.limited,
  };
}

export function accountLabel(a: Pick<ProjAccount, "name" | "mask">) {
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

/**
 * One projection line per asset account. Credit cards and loans are left out entirely: their
 * balances get paid from checking, so they already reach the projection as payments in
 * checking's outflow. Subtracting the balance as well would count the debt twice, and adding
 * card spending would count it twice too (once on the card, again as the payment).
 */
export function buildLines(accounts: ProjAccount[], flows: Map<number, Flow>): ProjLine[] {
  return accounts
    .filter((a) => !isLiability(a))
    .map((a) => ({
      key: a.key,
      label: accountLabel(a),
      institution: a.institution,
      value: a.balance,
      flow: (a.accountId !== null ? flows.get(a.accountId) : undefined) ?? ZERO_FLOW,
      currency: a.currency,
    }));
}

export function totalLine(lines: ProjLine[]): ProjLine {
  return {
    key: "total",
    label: "Total",
    institution: "",
    value: lines.reduce((s, l) => s + l.value, 0),
    flow: lines.reduce((f, l) => addFlows(f, l.flow), ZERO_FLOW),
    currency: "USD",
  };
}

/** Monthly points 0..months: a straight line, because growth is excluded on purpose. */
export function project(value: number, monthlyNet: number, months: number): number[] {
  return Array.from({ length: months + 1 }, (_, m) => value + monthlyNet * m);
}

export const HORIZONS = ["1", "2", "5"] as const;
/** Averaging window: preset lengths in days, or a custom from/to range. */
export const WINDOWS = ["30", "90", "180", "365", "custom"] as const;
export const WINDOW_LABELS: Record<(typeof WINDOWS)[number], string> = {
  "30": "Last month",
  "90": "Last 3 months",
  "180": "Last 6 months",
  "365": "Last year",
  custom: "Custom range",
};
export type ProjectionParams = {
  h: (typeof HORIZONS)[number];
  account: string;
  w: (typeof WINDOWS)[number];
  /** Custom range (inclusive), set only when w is "custom" and the range is valid. */
  from: string | null;
  to: string | null;
  /** True when a custom range was asked for but was invalid, so the default was used. */
  invalidRange: boolean;
};
export const DEFAULT_PROJECTION_PARAMS: ProjectionParams = {
  h: "1",
  account: "total",
  w: "90",
  from: null,
  to: null,
  invalidRange: false,
};

/** Strict YYYY-MM-DD that is a real calendar date. */
function isoDate(v: string | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(ms) || isoDay(ms) !== v ? null : v;
}

type RawParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Each field falls back to its default independently. `account` is "total" or an internal id.
 * A custom range must be valid dates with from ≤ to ≤ today; otherwise the 3-month default is
 * used and `invalidRange` is set so the page can say so.
 */
export function parseProjectionParams(params: RawParams, today = new Date()): ProjectionParams {
  const h = z.enum(HORIZONS).safeParse(first(params.h));
  const account = z
    .union([z.literal("total"), z.string().regex(/^[1-9]\d{0,9}$/)])
    .safeParse(first(params.account));
  const w = z.enum(WINDOWS).safeParse(first(params.w));
  const out: ProjectionParams = {
    ...DEFAULT_PROJECTION_PARAMS,
    h: h.success ? h.data : DEFAULT_PROJECTION_PARAMS.h,
    account: account.success ? account.data : DEFAULT_PROJECTION_PARAMS.account,
    w: w.success ? w.data : DEFAULT_PROJECTION_PARAMS.w,
  };
  if (out.w === "custom") {
    const from = isoDate(first(params.from));
    const to = isoDate(first(params.to));
    const todayIso = isoDay(utcDay(today));
    if (from && to && from <= to && to <= todayIso) {
      out.from = from;
      out.to = to;
    } else {
      out.w = DEFAULT_PROJECTION_PARAMS.w;
      out.invalidRange = true;
    }
  }
  return out;
}

/** The averaging window the params select. */
export function resolveWindow(p: ProjectionParams, today: Date): AvgWindow {
  if (p.w === "custom" && p.from && p.to) return { from: p.from, to: p.to };
  return presetWindow(Number(p.w === "custom" ? WINDOW_DAYS : p.w), today);
}

/** Query string for links, omitting defaults. */
export function projectionQuery(p: ProjectionParams, overrides: Partial<ProjectionParams> = {}): string {
  const m = { ...p, ...overrides };
  const q = new URLSearchParams();
  if (m.account !== DEFAULT_PROJECTION_PARAMS.account) q.set("account", m.account);
  if (m.h !== DEFAULT_PROJECTION_PARAMS.h) q.set("h", m.h);
  if (m.w !== DEFAULT_PROJECTION_PARAMS.w) q.set("w", m.w);
  if (m.w === "custom" && m.from && m.to) {
    q.set("from", m.from);
    q.set("to", m.to);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
