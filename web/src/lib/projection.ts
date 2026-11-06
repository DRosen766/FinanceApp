// Pure logic for the Projection page. No secrets, no I/O.
//
// Model: value(m) = today's balance + average monthly net flow × m. Investment growth (market
// returns, dividends, interest, capital gains) is deliberately excluded; only money moving into
// or out of an account counts. Flows are averaged over the trailing 90 days.
import { z } from "zod";
import type { TxRow } from "./transactions";

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
  /** Days of history the average is based on (≤ WINDOW_DAYS). */
  days: number;
  limited: boolean;
  /**
   * Credit card payments inside `in`/`out` (monthly magnitudes): paid out of this account, or
   * received by this card. When a card is folded into checking, the matched part is an internal
   * transfer and is removed from both gross columns (net is unaffected).
   */
  cardPaymentsOut: number;
  cardPaymentsIn: number;
};

const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Average monthly in/out per account over the trailing window (today − 90 days, today].
 * `historyStart` gives, per account, the earliest date stored data could exist from (the
 * earliest stored transaction of its link). If that is inside the window, the average is
 * taken over the days actually covered and flagged as limited.
 */
export function monthlyFlows(
  rows: TxRow[],
  today: Date,
  historyStart: Map<number, string>,
  accountIds: number[],
): Map<number, Flow> {
  const todayMs = utcDay(today);
  const windowStart = isoDay(todayMs - WINDOW_DAYS * DAY_MS);
  const todayIso = isoDay(todayMs);

  const sums = new Map<number, { in: number; out: number; payOut: number; payIn: number }>();
  for (const id of accountIds) sums.set(id, { in: 0, out: 0, payOut: 0, payIn: 0 });
  for (const r of rows) {
    const s = sums.get(r.accountId);
    if (!s || r.date <= windowStart || r.date > todayIso || !countsForProjection(r)) continue;
    // Plaid: positive amount = money out of the account.
    const isCardPayment = r.kind === "cash" && r.categoryDetailed === CARD_PAYMENT;
    if (r.amount > 0) {
      s.out += r.amount;
      if (isCardPayment) s.payOut += r.amount;
    } else {
      s.in += -r.amount;
      if (isCardPayment) s.payIn += -r.amount;
    }
  }

  const out = new Map<number, Flow>();
  for (const [id, s] of sums) {
    const start = historyStart.get(id);
    let days = WINDOW_DAYS;
    if (start && start > windowStart) {
      days = Math.max(1, Math.round((todayMs - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1);
    }
    days = Math.min(days, WINDOW_DAYS);
    const scale = AVG_MONTH_DAYS / days;
    const avgIn = s.in * scale;
    const avgOut = s.out * scale;
    out.set(id, {
      in: avgIn,
      out: avgOut,
      net: avgIn - avgOut,
      days,
      limited: days < WINDOW_DAYS,
      cardPaymentsOut: s.payOut * scale,
      cardPaymentsIn: s.payIn * scale,
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
  /** Today's value (credit folded in as negative). */
  value: number;
  flow: Flow;
  /** Number of credit/loan accounts folded into this line. */
  folded: number;
  currency: string | null;
};

const isLiability = (a: ProjAccount) => a.type === "credit" || a.type === "loan";
const ZERO_FLOW: Flow = {
  in: 0,
  out: 0,
  net: 0,
  days: WINDOW_DAYS,
  limited: false,
  cardPaymentsOut: 0,
  cardPaymentsIn: 0,
};

function addFlows(a: Flow, b: Flow): Flow {
  const days = Math.min(a.days, b.days);
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    net: a.net + b.net,
    days,
    limited: a.limited || b.limited,
    cardPaymentsOut: a.cardPaymentsOut + b.cardPaymentsOut,
    cardPaymentsIn: a.cardPaymentsIn + b.cardPaymentsIn,
  };
}

/**
 * Folds a card's flow into its checking line. Payments that left checking and arrived on the
 * card are an internal transfer: drop the matched amount from both gross in and out, so the
 * columns show income and spending rather than money moving between your own accounts.
 */
function foldCardFlow(line: Flow, card: Flow): Flow {
  const merged = addFlows(line, card);
  const internal = Math.min(line.cardPaymentsOut, card.cardPaymentsIn);
  return {
    ...merged,
    in: merged.in - internal,
    out: merged.out - internal,
    cardPaymentsOut: merged.cardPaymentsOut - internal,
    cardPaymentsIn: merged.cardPaymentsIn - internal,
  };
}

export function accountLabel(a: Pick<ProjAccount, "name" | "mask">) {
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

/**
 * One projection line per account, with credit cards and loans subtracted from a checking
 * account: the one at the same institution, else the first checking account anywhere. Card
 * flows are added to the checking flow, so a card payment from checking (out of checking,
 * into the card) cancels out and only card spending remains. With no checking account at
 * all, liabilities stand alone as negative values.
 */
export function buildLines(accounts: ProjAccount[], flows: Map<number, Flow>): ProjLine[] {
  const flowOf = (a: ProjAccount) => (a.accountId !== null ? flows.get(a.accountId) : undefined) ?? ZERO_FLOW;
  const lines = new Map<string, ProjLine>();
  const checking: ProjAccount[] = [];

  for (const a of accounts) {
    if (isLiability(a)) continue;
    lines.set(a.key, {
      key: a.key,
      label: accountLabel(a),
      institution: a.institution,
      value: a.balance,
      flow: flowOf(a),
      folded: 0,
      currency: a.currency,
    });
    if (a.type === "depository" && a.subtype === "checking") checking.push(a);
  }

  for (const card of accounts.filter(isLiability)) {
    const target = checking.find((c) => c.itemId === card.itemId) ?? checking[0];
    if (!target) {
      lines.set(card.key, {
        key: card.key,
        label: accountLabel(card),
        institution: card.institution,
        value: -card.balance,
        flow: flowOf(card),
        folded: 0,
        currency: card.currency,
      });
      continue;
    }
    const line = lines.get(target.key)!;
    line.value -= card.balance;
    line.flow = foldCardFlow(line.flow, flowOf(card));
    line.folded += 1;
  }

  for (const line of lines.values()) {
    if (line.folded > 0) {
      line.label += ` (less ${line.folded} credit ${line.folded === 1 ? "card" : "cards"})`;
    }
  }
  return [...lines.values()];
}

export function totalLine(lines: ProjLine[]): ProjLine {
  return {
    key: "total",
    label: "Total",
    institution: "",
    value: lines.reduce((s, l) => s + l.value, 0),
    flow: lines.reduce((f, l) => addFlows(f, l.flow), ZERO_FLOW),
    folded: 0,
    currency: "USD",
  };
}

/** Monthly points 0..months: a straight line, because growth is excluded on purpose. */
export function project(value: number, monthlyNet: number, months: number): number[] {
  return Array.from({ length: months + 1 }, (_, m) => value + monthlyNet * m);
}

export const HORIZONS = ["1", "2", "5"] as const;
export type ProjectionParams = { h: (typeof HORIZONS)[number]; account: string };
export const DEFAULT_PROJECTION_PARAMS: ProjectionParams = { h: "1", account: "total" };

type RawParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Each field falls back to its default independently. `account` is "total" or an internal id. */
export function parseProjectionParams(params: RawParams): ProjectionParams {
  const h = z.enum(HORIZONS).safeParse(first(params.h));
  const account = z
    .union([z.literal("total"), z.string().regex(/^[1-9]\d{0,9}$/)])
    .safeParse(first(params.account));
  return {
    h: h.success ? h.data : DEFAULT_PROJECTION_PARAMS.h,
    account: account.success ? account.data : DEFAULT_PROJECTION_PARAMS.account,
  };
}
