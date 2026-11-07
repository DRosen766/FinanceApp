import { describe, expect, it } from "vitest";
import {
  addMonths,
  BUDGET_CATEGORIES,
  BUDGET_FIELD_PREFIX,
  categorize,
  CATEGORY_IDS,
  monthRange,
  parseBudgetForm,
  parseMonth,
  summarizeBudget,
  TRANSFER,
} from "./budgets";
import type { TxRow } from "./transactions";

let nextId = 1;
function cash(date: string, amount: number, category: string | null, detailed: string | null = null, over: Partial<TxRow> = {}): TxRow {
  return {
    id: nextId++,
    kind: "cash",
    accountId: 1,
    date,
    pending: false,
    name: "Test",
    merchantName: null,
    amount,
    currency: "USD",
    category,
    categoryDetailed: detailed,
    countsAsCash: true,
    ...over,
  };
}

const TODAY = new Date("2026-11-07T15:00:00Z");

describe("categorize", () => {
  it.each([
    ["FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT", "dining"],
    ["FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES", "groceries"],
    ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CONVENIENCE_STORES", "groceries"],
    ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "shopping"],
    ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS", "software"],
    ["TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "rideshare"],
    ["TRANSPORTATION", "TRANSPORTATION_PUBLIC_TRANSIT", "transit"],
    ["TRANSPORTATION", "TRANSPORTATION_GAS", "transit"],
    ["ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES", "entertainment"],
    ["PERSONAL_CARE", "PERSONAL_CARE_HAIR_AND_BEAUTY", "personal_care"],
    ["MEDICAL", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS", "medical"],
    ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_INTERNET_AND_CABLE", "bills"],
    ["GENERAL_SERVICES", "GENERAL_SERVICES_INSURANCE", "bills"],
    ["LOAN_PAYMENTS", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT", "bills"],
    ["TRAVEL", "TRAVEL_FLIGHTS", "travel"],
    ["INCOME", "INCOME_SALARY", "earnings"],
    ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", TRANSFER],
    ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", TRANSFER],
    ["TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", TRANSFER],
    ["BANK_FEES", "BANK_FEES_OTHER_BANK_FEES", "everything_else"],
    ["OTHER", "OTHER_OTHER", "everything_else"],
    [null, null, "everything_else"],
  ])("%s / %s → %s", (primary, detailed, expected) => {
    expect(categorize(cash("2026-11-01", 10, primary, detailed))).toBe(expected);
  });

  it("leaves investment activity out of budgets", () => {
    expect(categorize(cash("2026-11-01", 10, "dividend", null, { kind: "investment" }))).toBeNull();
  });

  it("only maps to known categories, and Hygiene exists for manual use", () => {
    expect(CATEGORY_IDS).toContain("hygiene");
    expect(new Set(CATEGORY_IDS).size).toBe(BUDGET_CATEGORIES.length);
  });
});

describe("months", () => {
  it("computes ranges, including leap years", () => {
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29", days: 29 });
    expect(monthRange("2026-11").to).toBe("2026-11-30");
  });

  it("adds months across years", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("parses the month param, falling back to the current month", () => {
    expect(parseMonth(undefined, TODAY)).toBe("2026-11");
    expect(parseMonth("2026-08", TODAY)).toBe("2026-08");
    expect(parseMonth("2026-12", TODAY)).toBe("2026-12"); // next month allowed
    expect(parseMonth("2027-01", TODAY)).toBe("2026-11");
    expect(parseMonth("2026-13", TODAY)).toBe("2026-11");
    expect(parseMonth("1999-12", TODAY)).toBe("2026-11");
    expect(parseMonth("2026-8", TODAY)).toBe("2026-11");
    expect(parseMonth(["2026-07", "x"], TODAY)).toBe("2026-07");
  });
});

describe("summarizeBudget", () => {
  const amounts = new Map<string, number>([
    ["earnings", 5000],
    ["bills", 300],
    ["dining", 200],
    ["shopping", 100],
  ]);

  it("sums the month per category with refunds netted, and excludes transfers", () => {
    const rows = [
      cash("2026-11-02", 50, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
      cash("2026-11-03", 30, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE", { pending: true }),
      cash("2026-11-04", 150, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"),
      cash("2026-11-05", -20, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"), // refund
      cash("2026-11-05", -2500, "INCOME", "INCOME_SALARY"),
      cash("2026-11-06", 900, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
      cash("2026-10-31", 999, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // other month
    ];
    const s = summarizeBudget(rows, "2026-11", amounts, TODAY, "2026-10-01");
    const line = (id: string) => s.lines.find((l) => l.id === id)!;

    expect(line("dining").actual).toBe(80); // pending included
    expect(line("dining").remaining).toBe(120);
    expect(line("shopping").actual).toBe(130);
    expect(line("shopping").remaining).toBe(-30);
    expect(line("earnings").actual).toBe(2500); // income shown positive
    expect(line("groceries").budgeted).toBeNull();
    expect(line("groceries").remaining).toBeNull();
    expect(s.transfers).toHaveLength(1);

    expect(s.spendingBudget).toBe(300); // basics excluded
    expect(s.currentSpend).toBe(210);
    expect(s.remaining).toBe(90);
    expect(s.leftForSavings).toBe(5000 - 300 - 300);
    expect(s.daysLeft).toBe(24); // Nov 7..30
  });

  it("averages only full months of history before the selected month", () => {
    const rows = [
      cash("2026-08-20", 600, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // partial August
      cash("2026-09-10", 100, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
      cash("2026-10-10", 300, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
    ];
    const s = summarizeBudget(rows, "2026-11", amounts, TODAY, "2026-08-12");
    expect(s.lines.find((l) => l.id === "dining")!.avg3).toBe(200);
  });

  it("uses a full first month, and has no average without history", () => {
    const rows = [cash("2026-08-01", 90, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT")];
    expect(summarizeBudget(rows, "2026-11", amounts, TODAY, "2026-08-01").lines.find((l) => l.id === "dining")!.avg3).toBe(30);
    expect(summarizeBudget([], "2026-11", amounts, TODAY, null).lines[0].avg3).toBeNull();
  });

  it("never averages over the partial current month (viewing next month)", () => {
    const rows = [
      cash("2026-10-10", 300, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
      cash("2026-11-02", 900, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
    ];
    const s = summarizeBudget(rows, "2026-12", amounts, TODAY, "2026-10-01");
    expect(s.lines.find((l) => l.id === "dining")!.avg3).toBe(300); // only October
    expect(s.daysLeft).toBeNull();
  });
});

describe("parseBudgetForm", () => {
  const form = (values: Record<string, string>, fillRest = "") => {
    const m = new Map<string, string>();
    for (const id of CATEGORY_IDS) m.set(BUDGET_FIELD_PREFIX + id, fillRest);
    for (const [k, v] of Object.entries(values)) m.set(k, v);
    return { get: (n: string) => m.get(n) ?? null };
  };

  it("parses amounts, accepting $ and thousands separators; blank clears", () => {
    const r = parseBudgetForm(form({ budget_dining: "$1,250.5", budget_shopping: " 300 " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amounts.get("dining")).toBe(1250.5);
    expect(r.amounts.get("shopping")).toBe(300);
    expect(r.amounts.get("groceries")).toBeNull();
    expect(r.amounts.size).toBe(CATEGORY_IDS.length);
  });

  it.each(["-5", "1.234", "abc", "1e5", "Infinity", "99999999999", "0x10", "1 000"])("rejects %s", (v) => {
    const r = parseBudgetForm(form({ budget_dining: v }));
    expect(r).toEqual({ ok: false, invalid: ["dining"] });
  });

  it("rejects a form missing a category field", () => {
    const r = parseBudgetForm({ get: () => null });
    expect(r.ok).toBe(false);
  });

  it("ignores unknown fields, so a forged field never creates a category", () => {
    const r = parseBudgetForm(form({ budget_evil: "5", "budget___proto__": "5" }));
    expect(r.ok && [...r.amounts.keys()].every((k) => CATEGORY_IDS.includes(k))).toBe(true);
  });
});
