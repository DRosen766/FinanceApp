// Pure portfolio math for the Positions page. No secrets, no I/O.

export type PositionAccount = {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
  /** Account balance as reported by the institution (Plaid balances.current). */
  balance: number | null;
};

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
  /** True if some value has no cost basis (holding or balance-only account): gain is partial. */
  partial: boolean;
};

export type AccountSummary = {
  account: PositionAccount;
  rows: PositionRow[];
  /**
   * True when the institution reports a non-zero balance but no holdings (common for 529s and
   * workplace 401k/HSA accounts). The balance counts toward value; it has no cost basis.
   */
  balanceOnly: boolean;
  /**
   * Reported balance minus the sum of itemized holdings, when positive and material (e.g.
   * uninvested cash the institution doesn't list as a holding). Counts toward value, not gain.
   * 0 when holdings cover the balance.
   */
  unitemized: number;
  totals: Totals;
};

/** Ignore balance/holdings gaps below max($1, 0.1% of balance): price-timing noise. */
function materialGap(balance: number | null, itemized: number): number {
  if (balance === null) return 0;
  const gap = balance - itemized;
  return gap > Math.max(1, Math.abs(balance) * 0.001) ? gap : 0;
}

export function toRow(h: PositionHolding): PositionRow {
  if (h.costBasis === null) return { ...h, gain: null, gainPct: null };
  const gain = h.value - h.costBasis;
  return { ...h, gain, gainPct: h.costBasis !== 0 ? gain / h.costBasis : null };
}

function finish(value: number, costBasis: number, gain: number, partial: boolean): Totals {
  return { value, costBasis, gain, gainPct: costBasis !== 0 ? gain / costBasis : null, partial };
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
  return finish(value, costBasis, gain, partial);
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
    const balanceOnly = rows.length === 0 && account.balance !== null && account.balance !== 0;
    if (balanceOnly) {
      return { account, rows, balanceOnly, unitemized: 0, totals: finish(account.balance ?? 0, 0, 0, true) };
    }
    const t = totalsOf(rows);
    const unitemized = rows.length > 0 ? materialGap(account.balance, t.value) : 0;
    const totals = unitemized > 0 ? finish(t.value + unitemized, t.costBasis, t.gain, true) : t;
    return { account, rows, balanceOnly, unitemized, totals };
  });
}

/** Grand total across account summaries, including balance-only accounts. */
export function grandTotal(summaries: AccountSummary[]): Totals {
  let value = 0;
  let costBasis = 0;
  let gain = 0;
  let partial = false;
  for (const { totals } of summaries) {
    value += totals.value;
    costBasis += totals.costBasis;
    gain += totals.gain;
    partial ||= totals.partial;
  }
  return finish(value, costBasis, gain, partial);
}
