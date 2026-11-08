// Amazon payments-page import: find grocery-delivery orders and match their charges to bank
// transactions. Pure functions; the pasted text is never stored, only the resulting category
// overrides (see server/db.ts category_overrides).
//
// Input is the text of amazon.com → Your Account → Payments → Transactions, copied as-is:
//   Nov 01, 2026·Amazon Tips
//   Visa••••1234
//   Order #114-0000000-0000000
//   -$5.00
//   Charged

export type AmazonCharge = {
  date: string; // YYYY-MM-DD
  descriptor: string;
  last4: string | null;
  orderId: string | null;
  /** Plaid sign convention: positive = money out (a charge), negative = refund. */
  amount: number;
  status: string | null;
};

export const MAX_IMPORT_CHARS = 500_000;
const MAX_CHARGES = 10_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HEADER_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s*[·•]\s*(.+)$/;
const CARD_RE = /[•*]{2,}\s*(\d{4})$/;
const ORDER_RE = /^Order\s*#\s*([A-Za-z0-9-]{5,40})$/;
const AMOUNT_RE = /^([-+−])\s*\$([\d,]+\.\d{2})$/;
const STATUS_RE = /^(Charged|Pending|Refunded|Declined|Failed)$/i;

function isoDate(mon: string, day: string, year: string): string | null {
  const m = MONTHS.indexOf(mon);
  if (m < 0) return null;
  const d = new Date(Date.UTC(Number(year), m, Number(day)));
  if (d.getUTCDate() !== Number(day)) return null;
  return d.toISOString().slice(0, 10);
}

/** Parse the pasted page text. Unrecognized lines are skipped; an entry needs a date and amount. */
export function parseAmazonTransactions(text: string): AmazonCharge[] {
  const out: AmazonCharge[] = [];
  let cur: Omit<AmazonCharge, "amount"> & { amount: number | null } | null = null;
  const flush = () => {
    if (cur && cur.amount !== null && out.length < MAX_CHARGES) out.push({ ...cur, amount: cur.amount });
    cur = null;
  };
  for (const raw of text.slice(0, MAX_IMPORT_CHARS).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = HEADER_RE.exec(line);
    if (h) {
      flush();
      const date = isoDate(h[1], h[2], h[3]);
      cur = date ? { date, descriptor: h[4].trim(), last4: null, orderId: null, amount: null, status: null } : null;
      continue;
    }
    if (!cur) continue;
    const c = CARD_RE.exec(line);
    const o = ORDER_RE.exec(line);
    const a = AMOUNT_RE.exec(line);
    const s = STATUS_RE.exec(line);
    if (c && !cur.last4) cur.last4 = c[1];
    else if (o) cur.orderId = o[1];
    else if (a) {
      const n = Number(a[2].replace(/,/g, ""));
      // The page shows charges as "-$" (money out) and refunds as "+$".
      cur.amount = a[1] === "+" ? -n : n;
    } else if (s) cur.status = s[1].toLowerCase();
  }
  flush();
  return out;
}

const isTip = (c: AmazonCharge) => /\bamazon tips?\b/i.test(c.descriptor);

/**
 * Charges belonging to grocery deliveries: every charge (order, tip, refund) of an order that
 * has an "Amazon Tips" charge, since only Whole Foods / Amazon Fresh deliveries take tips.
 * Pending charges are skipped: the bank's pending row is replaced with a new one when it posts.
 */
export function groceryCharges(charges: AmazonCharge[]): { orders: number; charges: AmazonCharge[] } {
  const orders = new Set(charges.filter((c) => isTip(c) && c.orderId).map((c) => c.orderId!));
  return {
    orders: orders.size,
    charges: charges.filter(
      (c) => c.status !== "pending" && ((c.orderId && orders.has(c.orderId)) || isTip(c)),
    ),
  };
}

export type BankTx = {
  id: number;
  date: string;
  amount: number;
  pending: boolean;
  name: string;
  merchantName: string | null;
  /** Last 4 of the account the transaction is on. */
  mask: string | null;
};

const DAY = 86_400_000;
const dayGap = (bank: string, amazon: string) =>
  Math.round((Date.parse(`${bank}T00:00:00Z`) - Date.parse(`${amazon}T00:00:00Z`)) / DAY);
/** A bank row usually posts on or a few days after Amazon's charge date. */
const MIN_GAP = -2;
const MAX_GAP = 5;

/**
 * Match charges to posted Amazon bank transactions one-to-one: same card (last 4), same amount
 * to the cent, bank date within [-2, +5] days. Closest dates are paired first. Returns the
 * matched bank transaction ids.
 */
export function matchCharges(charges: AmazonCharge[], txs: BankTx[]): Set<number> {
  const amazonTxs = txs.filter(
    (t) => !t.pending && /amazon|amzn/i.test(`${t.merchantName ?? ""} ${t.name}`),
  );
  const pairs: { ci: number; tx: number; gap: number }[] = [];
  charges.forEach((c, ci) => {
    const cents = Math.round(c.amount * 100);
    for (const t of amazonTxs) {
      if (c.last4 && t.mask !== c.last4) continue;
      if (Math.round(t.amount * 100) !== cents) continue;
      const gap = dayGap(t.date, c.date);
      if (gap >= MIN_GAP && gap <= MAX_GAP) pairs.push({ ci, tx: t.id, gap });
    }
  });
  pairs.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || a.gap - b.gap);
  const usedCharges = new Set<number>();
  const matched = new Set<number>();
  for (const p of pairs) {
    if (usedCharges.has(p.ci) || matched.has(p.tx)) continue;
    usedCharges.add(p.ci);
    matched.add(p.tx);
  }
  return matched;
}
