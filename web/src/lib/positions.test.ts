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
      { id: "a1", name: "IRA", mask: "1111", subtype: "ira", balance: 250 },
      { id: "a2", name: "401k", mask: "2222", subtype: "401k", balance: 390 },
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

  it("keeps empty accounts (no holdings, no balance) out of value and gain", () => {
    const [empty, zero] = summarize(
      [
        { id: "a9", name: "Empty", mask: null, subtype: null, balance: null },
        { id: "a8", name: "Zero", mask: null, subtype: null, balance: 0 },
      ],
      [],
    );
    for (const s of [empty, zero]) {
      expect(s.balanceOnly).toBe(false);
      expect(s.totals).toMatchObject({ value: 0, gainPct: null, partial: false });
    }
  });

  it("counts balance-only accounts (balance, no holdings) toward value but not gain", () => {
    const accounts = [
      { id: "brk", name: "Brokerage", mask: null, subtype: "brokerage", balance: 200 },
      { id: "hsa", name: "HSA", mask: null, subtype: "hsa", balance: 500 },
    ];
    const summaries = summarize(accounts, [
      h({ accountId: "brk", value: 200, costBasis: 100 }),
    ]);
    const [brk, hsa] = summaries;

    // Holdings cover this balance, so there is no unitemized gap.
    expect(brk.balanceOnly).toBe(false);
    expect(brk.totals.value).toBe(200);

    expect(hsa.balanceOnly).toBe(true);
    expect(hsa.rows).toEqual([]);
    expect(hsa.totals).toMatchObject({ value: 500, costBasis: 0, gain: 0, gainPct: null, partial: true });

    const total = grandTotal(summaries);
    expect(total).toMatchObject({ value: 700, costBasis: 100, gain: 100, partial: true });
    expect(total.gainPct).toBeCloseTo(1);
  });

  it("adds a material balance gap as unitemized value (no cost basis)", () => {
    const [s] = summarize(
      [{ id: "brk", name: "Brokerage", mask: null, subtype: "brokerage", balance: 1000 }],
      [h({ accountId: "brk", value: 800, costBasis: 600 })],
    );
    expect(s.unitemized).toBe(200);
    expect(s.totals).toMatchObject({ value: 1000, costBasis: 600, gain: 200, partial: true });
  });

  it("ignores tiny gaps and holdings above the balance (price-timing noise)", () => {
    const [tiny, over] = summarize(
      [
        { id: "t", name: "T", mask: null, subtype: null, balance: 1000.5 },
        { id: "o", name: "O", mask: null, subtype: null, balance: 900 },
      ],
      [h({ accountId: "t", value: 1000, costBasis: 900 }), h({ accountId: "o", value: 1000, costBasis: 900 })],
    );
    expect(tiny.unitemized).toBe(0);
    expect(tiny.totals).toMatchObject({ value: 1000, partial: false });
    expect(over.unitemized).toBe(0);
    expect(over.totals.value).toBe(1000);
  });
});
