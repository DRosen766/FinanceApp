import { describe, expect, it } from "vitest";
import { grandTotal, summarize, toRow, type PositionHolding } from "./positions";

const h = (over: Partial<PositionHolding>): PositionHolding => ({
  accountId: "a1",
  ticker: "X",
  name: "X Corp",
  quantity: 1,
  price: 100,
  value: 100,
  costBasis: 80,
  currency: "USD",
  ...over,
});

describe("positions math", () => {
  it("computes gain and gain %", () => {
    const r = toRow(h({ value: 150, costBasis: 100 }));
    expect(r.gain).toBe(50);
    expect(r.gainPct).toBeCloseTo(0.5);
    const loss = toRow(h({ value: 75, costBasis: 100 }));
    expect(loss.gain).toBe(-25);
    expect(loss.gainPct).toBeCloseTo(-0.25);
  });

  it("leaves gain empty when cost basis is unknown", () => {
    expect(toRow(h({ costBasis: null }))).toMatchObject({ gain: null, gainPct: null });
  });

  it("does not divide by zero on a zero cost basis", () => {
    const r = toRow(h({ value: 10, costBasis: 0 }));
    expect(r.gain).toBe(10);
    expect(r.gainPct).toBeNull();
  });

  it("groups by account, sorts by value desc, and totals", () => {
    const accounts = [
      { id: "a1", name: "IRA", mask: "1111", subtype: "ira" },
      { id: "a2", name: "401k", mask: "2222", subtype: "401k" },
    ];
    const holdings = [
      h({ accountId: "a1", ticker: "SMALL", value: 50, costBasis: 40 }),
      h({ accountId: "a1", ticker: "BIG", value: 200, costBasis: 100 }),
      h({ accountId: "a2", ticker: "NOBASIS", value: 300, costBasis: null }),
      h({ accountId: "a2", ticker: "DOWN", value: 90, costBasis: 100 }),
    ];
    const [ira, k401] = summarize(accounts, holdings);

    expect(ira.rows.map((r) => r.ticker)).toEqual(["BIG", "SMALL"]);
    expect(ira.totals).toMatchObject({ value: 250, costBasis: 140, gain: 110, partial: false });
    expect(ira.totals.gainPct).toBeCloseTo(110 / 140);

    // value includes every holding; cost basis and gain only those with a basis
    expect(k401.totals).toMatchObject({ value: 390, costBasis: 100, gain: -10, partial: true });

    const total = grandTotal([ira, k401]);
    expect(total).toMatchObject({ value: 640, costBasis: 240, gain: 100, partial: true });
  });

  it("keeps accounts with no holdings", () => {
    const [only] = summarize([{ id: "a9", name: "Empty", mask: null, subtype: null }], []);
    expect(only.rows).toEqual([]);
    expect(only.totals).toMatchObject({ value: 0, gainPct: null, partial: false });
  });
});
