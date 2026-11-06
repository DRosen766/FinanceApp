import { describe, expect, it } from "vitest";
import {
  applyFilters,
  cutoffDate,
  DEFAULT_FILTERS,
  paginate,
  parseFilters,
  prettyCategory,
  summarize,
  toCashRow,
  toInvestmentRow,
  toQuery,
  type TxRow,
} from "./transactions";

const TODAY = new Date("2026-11-05T12:00:00Z");

let nextId = 1;
const tx = (over: Partial<TxRow>): TxRow => ({
  id: nextId++,
  kind: "cash",
  countsAsCash: true,
  accountId: 1,
  date: "2026-11-01",
  pending: false,
  name: "Coffee Shop 123",
  merchantName: "Coffee Shop",
  amount: 5,
  currency: "USD",
  category: "FOOD_AND_DRINK",
  ...over,
});

describe("parseFilters", () => {
  it("returns defaults for empty params", () => {
    expect(parseFilters({})).toEqual(DEFAULT_FILTERS);
  });

  it("parses valid params", () => {
    expect(parseFilters({ account: "3", range: "365", q: "  uber ", flow: "out", page: "2" })).toEqual({
      account: 3,
      range: "365",
      q: "uber",
      flow: "out",
      kind: "all",
      page: 2,
    });
  });

  it("falls back per field on invalid input, without resetting valid fields", () => {
    expect(
      parseFilters({ account: "-1", range: "abc", q: "x".repeat(101), flow: "sideways", kind: "x", page: "-1" }),
    ).toEqual(DEFAULT_FILTERS);
    expect(parseFilters({ range: "abc", flow: "in" })).toMatchObject({ range: "90", flow: "in" });
  });

  it("uses the first value of repeated params", () => {
    expect(parseFilters({ flow: ["in", "out"] }).flow).toBe("in");
  });
});

describe("applyFilters", () => {
  const rows = [
    tx({ accountId: 1, date: "2026-11-04", amount: 12.5, name: "UBER TRIP", merchantName: "Uber" }),
    tx({ accountId: 2, date: "2026-11-04", amount: -1000, name: "PAYROLL", merchantName: null, pending: true }),
    tx({ accountId: 1, date: "2026-09-01", amount: 40 }),
    tx({ accountId: 1, date: "2025-01-01", amount: 3 }),
  ];

  it("filters by date range (inclusive cutoff) and sorts newest first, pending first within a day", () => {
    const out = applyFilters(rows, { ...DEFAULT_FILTERS, range: "90" }, TODAY);
    expect(out.map((r) => r.date)).toEqual(["2026-11-04", "2026-11-04", "2026-09-01"]);
    expect(out[0].pending).toBe(true);
    expect(cutoffDate("90", TODAY)).toBe("2026-08-07");
    expect(cutoffDate("all", TODAY)).toBeNull();
  });

  it("filters by account, flow and case-insensitive search on name or merchant", () => {
    const all = { ...DEFAULT_FILTERS, range: "all" as const };
    expect(applyFilters(rows, { ...all, account: 2 }, TODAY)).toHaveLength(1);
    expect(applyFilters(rows, { ...all, flow: "in" }, TODAY).map((r) => r.name)).toEqual(["PAYROLL"]);
    expect(applyFilters(rows, { ...all, flow: "out" }, TODAY)).toHaveLength(3);
    expect(applyFilters(rows, { ...all, q: "uber" }, TODAY)).toHaveLength(1);
    expect(applyFilters(rows, { ...all, q: "payroll" }, TODAY)).toHaveLength(1);
  });
});

describe("summarize / paginate / helpers", () => {
  it("splits money in and out as positive magnitudes (Plaid: positive = out)", () => {
    expect(summarize([tx({ amount: 10 }), tx({ amount: -250 }), tx({ amount: 2.5 })])).toEqual({
      count: 3,
      moneyIn: 250,
      moneyOut: 12.5,
    });
  });

  it("paginates and clamps out-of-range pages", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(paginate(items, 1)).toMatchObject({ page: 1, pages: 3 });
    expect(paginate(items, 3).rows).toHaveLength(50);
    expect(paginate(items, 99).page).toBe(3);
    expect(paginate([], 5)).toMatchObject({ page: 1, pages: 1, rows: [] });
  });

  it("prettifies categories and builds minimal query strings", () => {
    expect(prettyCategory("FOOD_AND_DRINK")).toBe("Food and drink");
    expect(prettyCategory(null)).toBe("—");
    expect(toQuery(DEFAULT_FILTERS)).toBe("");
    expect(toQuery({ ...DEFAULT_FILTERS, q: "a&b", account: 4 }, { page: 2 })).toBe(
      "?account=4&q=a%26b&page=2",
    );
  });
});

// ---------------------------------------------------------------- investment rows

const inv = (over: Partial<Parameters<typeof toInvestmentRow>[0]>) =>
  toInvestmentRow({
    id: nextId++,
    accountId: 9,
    date: "2026-11-02",
    name: "BOUGHT VANGUARD TOTAL",
    type: "buy",
    subtype: "buy",
    quantity: 2,
    price: 250,
    amount: 500,
    fees: null,
    currency: "USD",
    ticker: "VTI",
    ...over,
  });

describe("investment transactions", () => {
  const buy = inv({});
  const sell = inv({ type: "sell", subtype: "sell", amount: -300, quantity: -1 });
  const dividend = inv({ type: "cash", subtype: "dividend", amount: -12.34, quantity: 0, ticker: "VTI" });
  const contribution = inv({ type: "cash", subtype: "contribution", amount: -1000, quantity: 0, ticker: null });
  const fee = inv({ type: "fee", subtype: "account fee", amount: 5, quantity: 0, ticker: null });
  const transferIn = inv({ type: "transfer", subtype: "transfer", amount: 0, quantity: 10 });
  const coffee = toCashRow({
    id: buy.id, // same numeric id as an investment row on purpose
    accountId: 1,
    date: "2026-11-02",
    pending: false,
    name: "COFFEE",
    merchantName: "Coffee",
    amount: 4,
    currency: "USD",
    category: "FOOD_AND_DRINK",
  });
  const rows = [buy, sell, dividend, contribution, fee, transferIn, coffee];
  const all = { ...DEFAULT_FILTERS, range: "all" as const };

  it("labels rows by subtype and marks only cash and fee types as cash movement", () => {
    expect(prettyCategory(dividend.category)).toBe("Dividend");
    expect(prettyCategory(fee.category)).toBe("Account fee");
    expect([buy, sell, transferIn].map((r) => r.countsAsCash)).toEqual([false, false, false]);
    expect([dividend, contribution, fee].map((r) => r.countsAsCash)).toEqual([true, true, true]);
    expect(coffee.countsAsCash).toBe(true);
  });

  it("leaves buys, sells and transfers out of In/Out but still counts the rows", () => {
    expect(summarize(rows)).toEqual({ count: 7, moneyIn: 1012.34, moneyOut: 9 });
  });

  it("applies the money in/out filter only to cash movement", () => {
    expect(applyFilters(rows, { ...all, flow: "in" }, TODAY)).toEqual(
      expect.arrayContaining([dividend, contribution]),
    );
    expect(applyFilters(rows, { ...all, flow: "in" }, TODAY)).toHaveLength(2);
    expect(applyFilters(rows, { ...all, flow: "out" }, TODAY).map((r) => r.name)).toEqual(
      expect.arrayContaining(["COFFEE"]),
    );
    expect(applyFilters(rows, { ...all, flow: "out" }, TODAY)).toHaveLength(2); // fee + coffee
  });

  it("filters by kind and searches tickers", () => {
    expect(applyFilters(rows, { ...all, kind: "investment" }, TODAY)).toHaveLength(6);
    expect(applyFilters(rows, { ...all, kind: "cash" }, TODAY)).toEqual([coffee]);
    expect(applyFilters(rows, { ...all, q: "vti" }, TODAY)).toHaveLength(4);
    expect(parseFilters({ kind: "investment" }).kind).toBe("investment");
    expect(toQuery({ ...DEFAULT_FILTERS, kind: "investment" })).toBe("?kind=investment");
  });

  it("keeps a cash row and an investment row with the same numeric id distinct and stably ordered", () => {
    const out = applyFilters([buy, coffee], all, TODAY);
    expect(out.map((r) => r.kind)).toEqual(["cash", "investment"]);
  });
});
