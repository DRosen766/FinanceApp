import { describe, expect, it } from "vitest";
import {
  LABELS,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  assertLoopbackUrl,
  computeMetrics,
  isHoldout,
  parsePrediction,
  splitExamples,
  toExamples,
  userPrompt,
  type Example,
} from "./classify-eval";
import { toCashRow, toInvestmentRow, type TxRow } from "./transactions";

const cash = (id: number, over: Partial<Parameters<typeof toCashRow>[0]> = {}): TxRow =>
  toCashRow({
    id,
    accountId: 1,
    date: "2026-01-05",
    pending: false,
    name: "SAMPLE MERCHANT",
    merchantName: null,
    amount: 10,
    currency: "USD",
    category: "FOOD_AND_DRINK",
    categoryDetailed: "FOOD_AND_DRINK_RESTAURANT",
    ...over,
  });

const ex = (id: number, label: Example["label"] = "dining"): Example => ({
  id,
  label,
  name: "X",
  merchantName: null,
  amount: 1,
  accountType: null,
  accountSubtype: null,
});

describe("toExamples", () => {
  it("labels cash rows with categorize() and joins account type", () => {
    const rows = [
      cash(1),
      cash(2, { category: "LOAN_PAYMENTS", categoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
      { ...cash(3), budgetCategory: "groceries" },
    ];
    const out = toExamples(rows, new Map([[1, { type: "credit", subtype: "credit card" }]]));
    expect(out.map((e) => e.label)).toEqual(["dining", "transfer", "groceries"]);
    expect(out[0]).toMatchObject({ accountType: "credit", accountSubtype: "credit card" });
  });

  it("skips investment rows", () => {
    const inv = toInvestmentRow({
      id: 9,
      accountId: 1,
      date: "2026-01-05",
      name: "BUY",
      type: "buy",
      subtype: "buy",
      ticker: null,
      quantity: 1,
      price: 1,
      amount: 1,
      fees: null,
      currency: "USD",
    });
    expect(toExamples([inv], new Map())).toEqual([]);
  });
});

describe("holdout split", () => {
  it("is deterministic and depends on seed", () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const a = ids.filter((id) => isHoldout(id, "v1", 0.2));
    expect(ids.filter((id) => isHoldout(id, "v1", 0.2))).toEqual(a);
    expect(ids.filter((id) => isHoldout(id, "v2", 0.2))).not.toEqual(a);
  });

  it("holds out roughly the requested fraction", () => {
    const { train, holdout } = splitExamples(Array.from({ length: 2000 }, (_, i) => ex(i)), "v1", 0.2);
    expect(train.length + holdout.length).toBe(2000);
    expect(holdout.length / 2000).toBeGreaterThan(0.17);
    expect(holdout.length / 2000).toBeLessThan(0.23);
  });

  it("keeps a row's membership when other rows are added", () => {
    const small = splitExamples(Array.from({ length: 50 }, (_, i) => ex(i)), "v1", 0.2).holdout.map((e) => e.id);
    const big = splitExamples(Array.from({ length: 500 }, (_, i) => ex(i)), "v1", 0.2).holdout.map((e) => e.id);
    expect(big.filter((id) => id < 50)).toEqual(small);
  });
});

describe("prompt", () => {
  it("lists every label and never includes Plaid's category", () => {
    for (const l of LABELS) expect(SYSTEM_PROMPT).toContain(`- ${l}:`);
    const p = userPrompt({ ...ex(1), name: "COFFEE", amount: -12.5, accountType: "depository", accountSubtype: "checking" });
    expect(p).toContain("$12.50 into the account");
    expect(p).toContain("depository / checking");
    expect(p).not.toMatch(/FOOD_AND_DRINK/);
  });

  it("schema enum matches labels", () => {
    expect(RESPONSE_SCHEMA.properties.category.enum).toEqual([...LABELS]);
  });
});

describe("parsePrediction", () => {
  it("accepts valid labels only", () => {
    expect(parsePrediction('{"category":"groceries"}')).toBe("groceries");
    expect(parsePrediction('{"category":"Groceries"}')).toBeNull();
    expect(parsePrediction("not json")).toBeNull();
    expect(parsePrediction("{}")).toBeNull();
  });
});

describe("assertLoopbackUrl", () => {
  it("allows loopback and rejects anything else", () => {
    expect(() => assertLoopbackUrl("http://127.0.0.1:11434")).not.toThrow();
    expect(() => assertLoopbackUrl("http://localhost:11434")).not.toThrow();
    expect(() => assertLoopbackUrl("http://[::1]:11434")).not.toThrow();
    expect(() => assertLoopbackUrl("http://0.0.0.0:11434")).toThrow();
    expect(() => assertLoopbackUrl("https://ollama.example.com")).toThrow();
    expect(() => assertLoopbackUrl("http://127.0.0.1.example.com")).toThrow();
  });
});

describe("computeMetrics", () => {
  it("computes accuracy, per-class P/R/F1, macro F1, baseline and confusion", () => {
    const m = computeMetrics([
      { gold: "dining", pred: "dining" },
      { gold: "dining", pred: "groceries" },
      { gold: "groceries", pred: "groceries" },
      { gold: "transfer", pred: null },
    ]);
    expect(m.accuracy).toBe(0.5);
    expect(m.invalid).toBe(1);
    expect(m.majorityBaseline).toBe(0.5);
    const dining = m.perClass.find((c) => c.label === "dining")!;
    expect(dining).toMatchObject({ support: 2, predicted: 1, precision: 1, recall: 0.5 });
    expect(dining.f1).toBeCloseTo(2 / 3);
    const groceries = m.perClass.find((c) => c.label === "groceries")!;
    expect(groceries).toMatchObject({ precision: 0.5, recall: 1 });
    expect(m.perClass.find((c) => c.label === "transfer")!.f1).toBe(0);
    expect(m.perClass.find((c) => c.label === "travel")!.f1).toBeNull();
    // mean of dining 2/3, groceries 2/3, transfer 0
    expect(m.macroF1).toBeCloseTo(4 / 9);
    expect(m.confusion).toEqual({ dining: { dining: 1, groceries: 1 }, groceries: { groceries: 1 }, transfer: { invalid: 1 } });
  });

  it("handles empty input", () => {
    expect(computeMetrics([])).toMatchObject({ n: 0, accuracy: 0, macroF1: 0, majorityBaseline: 0 });
  });
});
