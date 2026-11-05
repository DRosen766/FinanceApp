import { describe, expect, it } from "vitest";
import {
  applyFilters,
  cutoffDate,
  DEFAULT_FILTERS,
  paginate,
  parseFilters,
  prettyCategory,
  summarize,
  toQuery,
  type TxRow,
} from "./transactions";

const TODAY = new Date("2026-11-05T12:00:00Z");

let nextId = 1;
const tx = (over: Partial<TxRow>): TxRow => ({
  id: nextId++,
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
      page: 2,
    });
  });

  it("falls back per field on invalid input, without resetting valid fields", () => {
    expect(
      parseFilters({ account: "-1", range: "abc", q: "x".repeat(101), flow: "sideways", page: "-1" }),
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
