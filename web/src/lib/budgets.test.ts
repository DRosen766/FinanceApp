import { describe, expect, it } from "vitest";
import {
  addMonths,
  BUDGET_CATEGORIES,
  budgetsFor,
  carryoverInto,
  changedBudgets,
  monthlyActuals,
  trackingStartMonth,
  type BudgetEntry,
  BUDGET_FIELD_PREFIX,
  categorize,
  CATEGORY_IDS,
  monthRange,
  parseBudgetForm,
  parseMonth,
  summarizeBudget,
  TRANSFER,
  AUTO,
  ASSIGNMENT_OPTIONS,
  parseCategoryChoice,
  BUDGETABLE_IDS,
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

  it("applies a per-transaction override before anything else", () => {
    const r = cash("2026-11-01", 10, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", {
      budgetCategory: "groceries",
    });
    expect(categorize(r)).toBe("groceries");
    // An unknown override id is ignored rather than trusted.
    expect(categorize({ ...r, budgetCategory: "bogus" })).toBe("shopping");
  });

  it("honors a manual Not budgeted override", () => {
    const r = cash("2026-11-01", 10, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT", { budgetCategory: "transfer" });
    expect(categorize(r)).toBe(TRANSFER);
  });

  it("counts Amazon delivery tips as groceries", () => {
    const r = cash("2026-11-01", 5, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", {
      name: "Amazon Tips*AB12CD",
      merchantName: "Amazon",
    });
    expect(categorize(r)).toBe("groceries");
  });

  it.each([
    ["Anthropic", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "software"],
    ["OpenAI", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "software"],
    ["GitHub", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "software"],
    ["Amazon Web Services", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "software"],
    ["Rocket Money", "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING", "software"],
    ["Any.do", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "software"],
    ["Amazon", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "shopping"], // plain Amazon isn't AWS
    ["Supercuts", "PERSONAL_CARE_HAIR_AND_BEAUTY", "personal_care"], // not "supa"
    ["Notional Plumbing", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "everything_else"],
  ])("merchant %s (%s) → %s", (merchant, detailed, expected) => {
    const r = cash("2026-11-01", 10, detailed.split("_").slice(0, 2).join("_"), detailed, { merchantName: merchant });
    expect(categorize(r)).toBe(expected);
  });

  it("counts intercity rail as travel but keeps local transit in transit", () => {
    const rail = (merchantName: string) =>
      categorize(cash("2026-11-01", 50, "TRANSPORTATION", "TRANSPORTATION_PUBLIC_TRANSIT", { merchantName }));
    expect(rail("Amtrak")).toBe("travel");
    expect(rail("Greyhound")).toBe("travel");
    expect(rail("SEPTA")).toBe("transit");
    expect(rail("Metro Fare Autoload")).toBe("transit");
  });

  it("counts card rewards as earnings and fund trades as transfers", () => {
    expect(categorize(cash("2026-11-01", -5, "OTHER", "OTHER_OTHER", { name: "CREDIT-CASH BACK REWARD" }))).toBe("earnings");
    expect(categorize(cash("2026-11-01", -5, "OTHER", "OTHER_OTHER", { name: "CREDIT-TRAVEL REWARD" }))).toBe("earnings");
    expect(categorize(cash("2026-11-01", -900, "OTHER", "OTHER_OTHER", { name: "YOU SOLD SOME FUND" }))).toBe(TRANSFER);
    expect(categorize(cash("2026-11-01", 900, "OTHER", "OTHER_OTHER", { name: "YOU BOUGHT SOME FUND" }))).toBe(TRANSFER);
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
  const amounts: BudgetEntry[] = [
    { category: "earnings", fromMonth: "2000-01", amount: 5000 },
    { category: "bills", fromMonth: "2000-01", amount: 300 },
    { category: "dining", fromMonth: "2000-01", amount: 200 },
    { category: "shopping", fromMonth: "2000-01", amount: 100 },
  ];

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
    const s = summarizeBudget(rows, "2026-11", amounts, TODAY, "2026-10-01", null);
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
    const s = summarizeBudget(rows, "2026-11", amounts, TODAY, "2026-08-12", null);
    expect(s.lines.find((l) => l.id === "dining")!.avg3).toBe(200);
  });

  it("uses a full first month, and has no average without history", () => {
    const rows = [cash("2026-08-01", 90, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT")];
    expect(summarizeBudget(rows, "2026-11", amounts, TODAY, "2026-08-01", null).lines.find((l) => l.id === "dining")!.avg3).toBe(30);
    expect(summarizeBudget([], "2026-11", amounts, TODAY, null, null).lines[0].avg3).toBeNull();
  });

  it("never averages over the partial current month (viewing next month)", () => {
    const rows = [
      cash("2026-10-10", 300, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
      cash("2026-11-02", 900, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
    ];
    const s = summarizeBudget(rows, "2026-12", amounts, TODAY, "2026-10-01", null);
    expect(s.lines.find((l) => l.id === "dining")!.avg3).toBe(300); // only October
    expect(s.daysLeft).toBeNull();
  });
});

describe("effective-dated budgets", () => {
  const entries: BudgetEntry[] = [
    { category: "dining", fromMonth: "2000-01", amount: 200 },
    { category: "dining", fromMonth: "2026-10", amount: 250 },
    { category: "shopping", fromMonth: "2000-01", amount: 100 },
    { category: "shopping", fromMonth: "2026-10", amount: null }, // budget removed from October
  ];

  it("uses the latest row at or before the month", () => {
    expect([...budgetsFor(entries, "2026-09")]).toEqual([["dining", 200], ["shopping", 100]]);
    expect([...budgetsFor(entries, "2026-10")]).toEqual([["dining", 250]]);
    expect([...budgetsFor(entries, "2027-05")]).toEqual([["dining", 250]]);
  });

  it("reports only changed amounts", () => {
    const submitted = new Map<(typeof CATEGORY_IDS)[number], number | null>([
      ["dining", 250],
      ["shopping", 40],
      ["groceries", null],
    ]);
    expect([...changedBudgets(entries, "2026-11", submitted)]).toEqual([["shopping", 40]]);
  });
});

describe("carryover", () => {
  const entries: BudgetEntry[] = [
    { category: "earnings", fromMonth: "2000-01", amount: 5000 },
    { category: "dining", fromMonth: "2000-01", amount: 200 },
    { category: "dining", fromMonth: "2026-10", amount: 300 },
    { category: "shopping", fromMonth: "2000-01", amount: 100 },
  ];
  const rows = [
    cash("2026-08-15", 999, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // before tracking
    cash("2026-09-03", 150, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // +50
    cash("2026-09-04", 160, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES"), // −60
    cash("2026-10-02", 320, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // −20 (new 300 budget)
    cash("2026-10-05", -10, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES"), // refund: +110
    cash("2026-10-09", -2500, "INCOME", "INCOME_SALARY"),
    cash("2026-10-09", 500, "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"), // ignored
    cash("2026-11-02", 40, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
  ];
  const actuals = monthlyActuals(rows);

  it("carries overspending forward as a deficit, but never unspent budget", () => {
    const into = (m: string) => carryoverInto(actuals, entries, "2026-09", m);
    expect(into("2026-09").get("dining")).toBe(0);
    expect(into("2026-10").get("dining")).toBe(0); // 50 unspent: not carried
    expect(into("2026-10").get("shopping")).toBe(-60); // overspent: carried
    expect(into("2026-11").get("dining")).toBe(-20); // 0 + (300 − 320)
    expect(into("2026-11").get("shopping")).toBe(0); // −60 + 110 pays it off; the extra 50 is not carried
    expect(into("2026-12").get("dining")).toBe(0); // −20 + (300 − 40) → capped at 0
    for (const m of ["2026-10", "2026-11", "2026-12"]) for (const v of into(m).values()) expect(v).toBeLessThanOrEqual(0);
  });

  it("pays a deficit back over several months", () => {
    const e: BudgetEntry[] = [{ category: "dining", fromMonth: "2000-01", amount: 100 }];
    const a = monthlyActuals([
      cash("2026-09-10", 400, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // −300
      cash("2026-10-10", 50, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // +50 → −250
      cash("2026-11-10", 0.5, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), // +99.5 → −150.5
    ]);
    expect(carryoverInto(a, e, "2026-09", "2026-10").get("dining")).toBe(-300);
    expect(carryoverInto(a, e, "2026-09", "2026-11").get("dining")).toBe(-250);
    expect(carryoverInto(a, e, "2026-09", "2026-12").get("dining")).toBe(-150.5);
  });

  it("has no carryover for Earnings, before the start, or without history", () => {
    expect(carryoverInto(actuals, entries, "2026-09", "2026-11").has("earnings")).toBe(false);
    expect(carryoverInto(actuals, entries, "2026-09", "2026-08").size).toBe(0);
    expect(carryoverInto(actuals, entries, null, "2026-11").size).toBe(0);
  });

  it("leaves a tally unchanged in months without a budget", () => {
    const groceries = carryoverInto(actuals, entries, "2026-09", "2026-11").get("groceries");
    expect(groceries).toBe(0);
  });

  it("feeds the month view: a deficit lowers remaining, and spendable never exceeds the budget", () => {
    const s = summarizeBudget(rows, "2026-11", entries, TODAY, "2026-08-15", "2026-09");
    const dining = s.lines.find((l) => l.id === "dining")!;
    expect(dining.carryover).toBe(-20);
    expect(dining.remaining).toBe(300 - 20 - 40);
    expect(s.lines.find((l) => l.id === "shopping")!.remaining).toBe(100); // not 150
    expect(s.lines.find((l) => l.id === "earnings")!.carryover).toBeNull();
    expect(s.lines.find((l) => l.id === "groceries")!.carryover).toBeNull(); // no budget
    expect(s.carryover).toBe(-20); // dining −20 + shopping 0
    expect(s.remaining).toBe(400 - 20 - 40);
    expect(s.trackingStart).toBe("2026-09");
  });

  it("starts tracking at the first full month every item has history", () => {
    expect(trackingStartMonth(["2024-11-07", "2026-08-12", "2026-08-08"])).toBe("2026-09");
    expect(trackingStartMonth(["2026-08-01"])).toBe("2026-08");
    expect(trackingStartMonth([])).toBeNull();
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
    expect(r.amounts.size).toBe(BUDGETABLE_IDS.length);
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

describe("parseCategoryChoice", () => {
  const f = (id: string, category: string) => {
    const d = new FormData();
    d.set("id", id);
    d.set("category", category);
    return d;
  };
  it("accepts every option plus Automatic", () => {
    for (const o of ASSIGNMENT_OPTIONS) expect(parseCategoryChoice(f("7", o.value))).toEqual({ id: 7, category: o.value });
    expect(parseCategoryChoice(f("7", AUTO))).toEqual({ id: 7, category: AUTO });
    expect(ASSIGNMENT_OPTIONS.map((o) => o.value)).toContain(TRANSFER);
  });
  it("rejects anything else", () => {
    expect(parseCategoryChoice(f("7", "constructor"))).toBeNull();
    expect(parseCategoryChoice(f("07", "dining"))).toBeNull();
    expect(parseCategoryChoice(f("1e3", "dining"))).toBeNull();
    expect(parseCategoryChoice(new FormData())).toBeNull();
  });
});

describe("excluded categories", () => {
  it("Education is excluded and Plaid's education category maps to it", () => {
    expect(BUDGET_CATEGORIES.find((c) => c.id === "education")?.group).toBe("excluded");
    expect(BUDGETABLE_IDS).not.toContain("education");
    expect(categorize(cash("2026-11-01", 40, "GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION"))).toBe("education");
    expect(categorize(cash("2026-11-01", 40, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT", { budgetCategory: "education" }))).toBe("education");
  });

  it("are listed but never budgeted, carried over, or counted as spending", () => {
    const rows = [
      cash("2026-10-05", 100, "GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION"),
      cash("2026-11-02", 50, "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
      cash("2026-11-03", 400, "GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION"),
    ];
    // Even a stray stored budget for an excluded category is ignored.
    const entries: BudgetEntry[] = [
      { category: "dining", fromMonth: "2000-01", amount: 200 },
      { category: "education", fromMonth: "2000-01", amount: 1000 },
    ];
    const s = summarizeBudget(rows, "2026-11", entries, TODAY, "2026-08-01", "2026-09");
    const edu = s.lines.find((l) => l.id === "education")!;
    expect(edu).toMatchObject({ group: "excluded", actual: 400, budgeted: null, carryover: null, remaining: null });
    expect(edu.rows).toHaveLength(1);
    expect(s.excludedSpend).toBe(400);
    expect(s.currentSpend).toBe(50);
    expect(s.spendingBudget).toBe(200);
    expect(s.carryover).toBe(0); // dining underspent: nothing rolls over
    expect(s.remaining).toBe(150);
    expect(carryoverInto(monthlyActuals(rows), entries, "2026-09", "2026-11").has("education")).toBe(false);
  });

  it("have no budget field: the form ignores one if sent", () => {
    const m = new Map<string, string>();
    for (const id of BUDGETABLE_IDS) m.set(BUDGET_FIELD_PREFIX + id, "");
    m.set(BUDGET_FIELD_PREFIX + "education", "500");
    const r = parseBudgetForm({ get: (n: string) => m.get(n) ?? null });
    expect(r.ok && r.amounts.has("education")).toBe(false);
  });
});
