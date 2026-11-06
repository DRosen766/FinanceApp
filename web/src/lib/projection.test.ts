import { describe, expect, it } from "vitest";
import {
  AVG_MONTH_DAYS,
  buildLines,
  countsForProjection,
  DEFAULT_PROJECTION_PARAMS,
  monthlyFlows,
  parseProjectionParams,
  presetWindow,
  project,
  projectionQuery,
  resolveWindow,
  totalLine,
  type ProjAccount,
} from "./projection";
import { toCashRow, toInvestmentRow, type TxRow } from "./transactions";

const TODAY = new Date("2026-11-06T12:00:00Z");
let nextId = 1;

const cash = (accountId: number, date: string, amount: number, pending = false): TxRow =>
  toCashRow({
    id: nextId++,
    accountId,
    date,
    pending,
    name: "X",
    merchantName: null,
    amount,
    currency: "USD",
    category: null,
  });

const inv = (accountId: number, date: string, type: string, subtype: string, amount: number): TxRow =>
  toInvestmentRow({
    id: nextId++,
    accountId,
    date,
    name: "X",
    type,
    subtype,
    quantity: 0,
    price: 0,
    amount,
    fees: null,
    currency: "USD",
    ticker: null,
  });

describe("countsForProjection", () => {
  it("counts posted cash rows and investment deposits, withdrawals and fees only", () => {
    expect(countsForProjection(cash(1, "2026-11-01", 10))).toBe(true);
    expect(countsForProjection(cash(1, "2026-11-01", 10, true))).toBe(false);
    for (const [type, subtype] of [
      ["cash", "deposit"],
      ["cash", "contribution"],
      ["cash", "withdrawal"],
      ["cash", "distribution"],
      ["cash", "margin expense"],
      ["fee", "account fee"],
    ]) {
      expect(countsForProjection(inv(2, "2026-11-01", type, subtype, 1)), `${type}/${subtype}`).toBe(true);
    }
    for (const [type, subtype] of [
      ["cash", "dividend"],
      ["cash", "interest"],
      ["cash", "long-term capital gain"],
      ["cash", "short-term capital gain"],
      ["buy", "buy"],
      ["sell", "sell"],
      ["transfer", "transfer"],
    ]) {
      expect(countsForProjection(inv(2, "2026-11-01", type, subtype, 1)), `${type}/${subtype}`).toBe(false);
    }
  });
});

describe("monthlyFlows", () => {
  it("averages the trailing 90 days per month, converting Plaid's sign", () => {
    const rows = [
      cash(1, "2026-11-01", -900), // in (paycheck)
      cash(1, "2026-10-01", 300), // out
      cash(1, "2026-08-08", 999_999), // exactly 90 days ago: outside (window is (today−90, today])
      cash(1, "2026-12-01", 999_999), // future-dated: ignored
      inv(2, "2026-10-15", "cash", "dividend", -5_000), // growth: ignored
      inv(2, "2026-10-15", "cash", "deposit", -600),
    ];
    const flows = monthlyFlows(rows, presetWindow(90, TODAY), new Map(), [1, 2]);
    const scale = AVG_MONTH_DAYS / 90;
    expect(flows.get(1)!.in).toBeCloseTo(900 * scale);
    expect(flows.get(1)!.out).toBeCloseTo(300 * scale);
    expect(flows.get(1)!.net).toBeCloseTo(600 * scale);
    expect(flows.get(1)!.limited).toBe(false);
    expect(flows.get(2)!.net).toBeCloseTo(600 * scale);
  });

  it("averages over the days actually covered when history is short, and flags it", () => {
    const rows = [cash(1, "2026-10-08", 300)];
    const flows = monthlyFlows(rows, presetWindow(90, TODAY), new Map([[1, "2026-10-08"]]), [1]);
    const f = flows.get(1)!;
    expect(f.days).toBe(30); // Oct 8 .. Nov 6 inclusive
    expect(f.limited).toBe(true);
    expect(f.out).toBeCloseTo(300 * (AVG_MONTH_DAYS / 30));
  });

  it("gives accounts with no activity a zero flow", () => {
    expect(monthlyFlows([], presetWindow(90, TODAY), new Map(), [7]).get(7)).toMatchObject({ in: 0, out: 0, net: 0 });
  });
});

const acct = (over: Partial<ProjAccount>): ProjAccount => ({
  key: String(over.accountId ?? 0),
  accountId: 0,
  itemId: 1,
  institution: "Bank",
  name: "Account",
  mask: "0000",
  type: "depository",
  subtype: "checking",
  balance: 0,
  currency: "USD",
  ...over,
});

const flow = (net: number, days = 90) => ({
  in: Math.max(net, 0),
  out: Math.max(-net, 0),
  net,
  days,
  limited: days < 90,
  cardPaymentsOut: 0,
  cardPaymentsIn: 0,
});

describe("buildLines", () => {
  it("subtracts credit cards from the checking account at the same institution and adds their flows", () => {
    const accounts = [
      acct({ accountId: 1, name: "Checking", balance: 5_000 }),
      acct({ accountId: 2, name: "Card A", type: "credit", subtype: "credit card", balance: 1_200 }),
      acct({ accountId: 3, name: "Card B", type: "credit", subtype: "credit card", balance: 300 }),
      acct({ accountId: 4, itemId: 2, institution: "Broker", name: "Brokerage", type: "investment", subtype: "brokerage", balance: 50_000 }),
    ];
    const flows = new Map([
      [1, flow(-1_000)], // includes the card payment leaving checking
      [2, flow(400)], // payment in exceeds spending this period
      [3, flow(-200, 40)],
      [4, flow(500)],
    ]);
    const lines = buildLines(accounts, flows);
    expect(lines).toHaveLength(2);
    const checking = lines.find((l) => l.key === "1")!;
    expect(checking.value).toBe(3_500);
    expect(checking.flow.net).toBe(-800);
    expect(checking.flow.limited).toBe(true);
    expect(checking.folded).toBe(2);
    expect(checking.label).toBe("Checking ••0000 (less 2 credit cards)");
    expect(totalLine(lines)).toMatchObject({ value: 53_500, flow: expect.objectContaining({ net: -300 }) });
  });

  it("removes matched card payments from gross in/out when folding, leaving net unchanged", () => {
    const pay = (accountId: number, amount: number) =>
      toCashRow({
        id: nextId++,
        accountId,
        date: "2026-11-01",
        pending: false,
        name: "PAYMENT",
        merchantName: null,
        amount,
        currency: "USD",
        category: "LOAN_PAYMENTS",
        categoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      });
    const accounts = [
      acct({ accountId: 1, balance: 1_000 }),
      acct({ accountId: 2, type: "credit", subtype: "credit card", balance: 2_000 }),
    ];
    const rows = [
      cash(1, "2026-10-15", -4_000), // paycheck
      pay(1, 7_000), // payment out of checking (pays down an older balance)
      pay(2, -7_000), // same payment, received by the card
      cash(2, "2026-10-20", 3_000), // card spending
    ];
    const flows = monthlyFlows(rows, presetWindow(90, TODAY), new Map(), [1, 2]);
    const [line] = buildLines(accounts, flows);
    const scale = AVG_MONTH_DAYS / 90;
    expect(line.flow.in).toBeCloseTo(4_000 * scale); // not 11k
    expect(line.flow.out).toBeCloseTo(3_000 * scale); // not 10k
    expect(line.flow.net).toBeCloseTo(1_000 * scale);
    expect(line.value).toBe(-1_000);

    // Unfolded (no card linked), the payment is a real outflow and stays in the gross column.
    const alone = buildLines([accounts[0]], flows)[0];
    expect(alone.flow.out).toBeCloseTo(7_000 * scale);
  });

  it("a card payment from checking cancels out; only card spending remains", () => {
    const accounts = [
      acct({ accountId: 1, balance: 1_000 }),
      acct({ accountId: 2, type: "credit", subtype: "credit card", balance: 0 }),
    ];
    const rows = [
      cash(1, "2026-11-01", 500), // checking → card payment (out of checking)
      cash(2, "2026-11-01", -500), // same payment, into the card
      cash(2, "2026-10-20", 500), // card spending
    ];
    const flows = monthlyFlows(rows, presetWindow(90, TODAY), new Map(), [1, 2]);
    const [line] = buildLines(accounts, flows);
    expect(line.flow.out - line.flow.in).toBeCloseTo(500 * (AVG_MONTH_DAYS / 90));
  });

  it("falls back to a checking account at another institution", () => {
    const accounts = [
      acct({ accountId: 1, itemId: 1, balance: 100 }),
      acct({ accountId: 2, itemId: 2, type: "credit", subtype: "credit card", balance: 40 }),
    ];
    const lines = buildLines(accounts, new Map());
    expect(lines).toHaveLength(1);
    expect(lines[0].value).toBe(60);
  });

  it("shows liabilities alone as negative values when there is no checking account", () => {
    const accounts = [
      acct({ accountId: 1, subtype: "savings", balance: 100 }),
      acct({ accountId: 2, type: "loan", subtype: "student", balance: 9_000 }),
    ];
    const lines = buildLines(accounts, new Map());
    expect(lines.map((l) => l.value)).toEqual([100, -9_000]);
  });
});

describe("project", () => {
  it("is a straight line with one point per month", () => {
    expect(project(1_000, -100, 12)).toHaveLength(13);
    expect(project(1_000, -100, 3)).toEqual([1_000, 900, 800, 700]);
    expect(project(1_000, 0, 60).every((v) => v === 1_000)).toBe(true);
  });
});

describe("parseProjectionParams", () => {
  it("parses valid params and falls back per field", () => {
    expect(parseProjectionParams({}, TODAY)).toEqual(DEFAULT_PROJECTION_PARAMS);
    expect(parseProjectionParams({ h: "5", account: "12" }, TODAY)).toMatchObject({ h: "5", account: "12" });
    expect(parseProjectionParams({ h: "9", account: "12" }, TODAY)).toMatchObject({ h: "1", account: "12" });
    expect(parseProjectionParams({ h: "2", account: "abc" }, TODAY)).toMatchObject({ h: "2", account: "total" });
    expect(parseProjectionParams({ account: "-1" }).account).toBe("total");
    expect(parseProjectionParams({ account: ["3", "4"] }).account).toBe("3");
  });
});

describe("averaging window", () => {
  it("offers 1, 3, 6 and 12 month presets ending today", () => {
    for (const [w, from] of [
      ["30", "2026-10-08"],
      ["90", "2026-08-09"],
      ["180", "2026-05-11"],
      ["365", "2025-11-07"],
    ] as const) {
      const p = parseProjectionParams({ w }, TODAY);
      expect(resolveWindow(p, TODAY)).toEqual({ from, to: "2026-11-06" });
    }
    expect(parseProjectionParams({ w: "7" }, TODAY).w).toBe("90");
  });

  it("accepts a valid custom range and rejects invalid ones with a flag", () => {
    const ok = parseProjectionParams({ w: "custom", from: "2026-01-01", to: "2026-03-31" }, TODAY);
    expect(ok).toMatchObject({ w: "custom", from: "2026-01-01", to: "2026-03-31", invalidRange: false });
    expect(resolveWindow(ok, TODAY)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    for (const bad of [
      { from: "2026-03-31", to: "2026-01-01" }, // reversed
      { from: "2026-01-01", to: "2026-12-31" }, // future
      { from: "2026-02-30", to: "2026-03-31" }, // not a date
      { from: "2026-1-1", to: "2026-03-31" }, // wrong format
      { from: "2026-01-01" }, // missing end
    ]) {
      const p = parseProjectionParams({ w: "custom", ...bad }, TODAY);
      expect(p, JSON.stringify(bad)).toMatchObject({ w: "90", from: null, to: null, invalidRange: true });
    }
  });

  it("averages only inside a custom range, scaled by its length", () => {
    const rows = [cash(1, "2026-01-15", 300), cash(1, "2026-02-15", 300), cash(1, "2026-06-01", 9_999)];
    const window = { from: "2026-01-01", to: "2026-03-01" }; // 60 days
    const f = monthlyFlows(rows, window, new Map(), [1]).get(1)!;
    expect(f.days).toBe(60);
    expect(f.out).toBeCloseTo(600 * (AVG_MONTH_DAYS / 60));
    expect(f.limited).toBe(false);
  });

  it("flags limited history when the link's data starts inside a long window", () => {
    const f = monthlyFlows([], presetWindow(365, TODAY), new Map([[1, "2026-08-09"]]), [1]).get(1)!;
    expect(f).toMatchObject({ days: 90, limited: true });
  });

  it("keeps the window in links", () => {
    const p = parseProjectionParams({ w: "custom", from: "2026-01-01", to: "2026-03-31", h: "2" }, TODAY);
    expect(projectionQuery(p, { account: "4" })).toBe("?account=4&h=2&w=custom&from=2026-01-01&to=2026-03-31");
    expect(projectionQuery(parseProjectionParams({}, TODAY), { account: "4" })).toBe("?account=4");
  });
});
