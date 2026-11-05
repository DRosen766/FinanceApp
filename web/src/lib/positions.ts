// Pure portfolio math for the Positions page. No secrets, no I/O.

export type PositionAccount = { id: string; name: string; mask: string | null; subtype: string | null };

export type PositionHolding = {
  accountId: string;
  ticker: string | null;
  name: string;
  quantity: number;
  price: number;
  value: number;
  costBasis: number | null;
  currency: string | null;
};

export type PositionRow = PositionHolding & {
  gain: number | null;
  gainPct: number | null;
};

export type Totals = {
  value: number;
  /** Sum over holdings that have a cost basis. */
  costBasis: number;
  /** Sum over holdings that have a cost basis. */
  gain: number;
  gainPct: number | null;
  /** True if any holding lacks a cost basis, so gain totals are partial. */
  partial: boolean;
};

export type AccountSummary = {
  account: PositionAccount;
  rows: PositionRow[];
  totals: Totals;
};

export function toRow(h: PositionHolding): PositionRow {
  if (h.costBasis === null) return { ...h, gain: null, gainPct: null };
  const gain = h.value - h.costBasis;
  return { ...h, gain, gainPct: h.costBasis !== 0 ? gain / h.costBasis : null };
}

export function totalsOf(rows: PositionRow[]): Totals {
  let value = 0;
  let costBasis = 0;
  let gain = 0;
  let partial = false;
  for (const r of rows) {
    value += r.value;
    if (r.costBasis === null || r.gain === null) {
      partial = true;
    } else {
      costBasis += r.costBasis;
      gain += r.gain;
    }
  }
  return { value, costBasis, gain, gainPct: costBasis !== 0 ? gain / costBasis : null, partial };
}

/** Groups holdings by account (value-descending), with per-account totals. */
export function summarize(
  accounts: PositionAccount[],
  holdings: PositionHolding[],
): AccountSummary[] {
  return accounts.map((account) => {
    const rows = holdings
      .filter((h) => h.accountId === account.id)
      .map(toRow)
      .sort((a, b) => b.value - a.value);
    return { account, rows, totals: totalsOf(rows) };
  });
}

/** Grand total across account summaries. */
export function grandTotal(summaries: AccountSummary[]): Totals {
  return totalsOf(summaries.flatMap((s) => s.rows));
}
