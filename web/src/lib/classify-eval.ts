// Pure logic for evaluating a local LLM as a transaction classifier: labels, holdout split,
// prompt, response parsing and metrics. No I/O; scripts/eval-classifier.ts does the running.
//
// Ground truth is the app's current labelling, categorize() from budgets.ts: per-transaction
// overrides, then descriptor rules, then Plaid's personal_finance_category. The model never
// sees Plaid's category, only what a bank statement shows (descriptor, merchant, amount,
// account type), so accuracy measures agreement with that labelling.
import { createHash } from "node:crypto";
import { BUDGET_CATEGORIES, TRANSFER, categorize, type Assignment } from "./budgets";
import type { TxRow } from "./transactions";

export const LABELS: readonly Assignment[] = [...BUDGET_CATEGORIES.map((c) => c.id), TRANSFER];

/** One labelled example. `id` is the internal row id; everything else is model input. */
export type Example = {
  id: number;
  label: Assignment;
  name: string;
  merchantName: string | null;
  amount: number;
  accountType: string | null;
  accountSubtype: string | null;
};

export type AccountInfo = { type: string | null; subtype: string | null };

/** Labelled examples from cash rows; investment rows aren't budgeted and are skipped. */
export function toExamples(rows: TxRow[], accounts: Map<number, AccountInfo>): Example[] {
  const out: Example[] = [];
  for (const r of rows) {
    const label = categorize(r);
    if (label === null) continue;
    const acct = accounts.get(r.accountId);
    out.push({
      id: r.id,
      label,
      name: r.name,
      merchantName: r.merchantName,
      amount: r.amount,
      accountType: acct?.type ?? null,
      accountSubtype: acct?.subtype ?? null,
    });
  }
  return out;
}

/**
 * Deterministic holdout membership: a row is held out when the hash of `seed:id` falls below
 * `fraction`. Membership depends only on the row itself, so it never changes as new
 * transactions sync in, and a holdout row can never drift into a future training/few-shot set.
 */
export function isHoldout(id: number, seed: string, fraction: number): boolean {
  const h = createHash("sha256").update(`${seed}:${id}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000 < fraction;
}

export function splitExamples(examples: Example[], seed: string, fraction: number) {
  const train: Example[] = [];
  const holdout: Example[] = [];
  for (const e of examples) (isHoldout(e.id, seed, fraction) ? holdout : train).push(e);
  return { train, holdout };
}

// ---------------------------------------------------------------- prompt

const DESCRIPTIONS: Record<Assignment, string> = {
  earnings: "income: paychecks, direct deposits, interest, refunds of taxes",
  bills: "rent, utilities, phone, internet, insurance, loan payments",
  dining: "restaurants, cafes, bars, fast food, food delivery",
  entertainment: "movies, concerts, events, games, streaming, sports, hobbies",
  groceries: "supermarkets, grocery delivery, convenience stores",
  hygiene: "toiletries, cleaning supplies, haircuts",
  medical: "doctors, dentists, pharmacies, hospitals",
  personal_care: "gyms, spas, salons, wellness",
  rideshare: "Uber, Lyft, taxis",
  shopping: "general merchandise, clothing, online retail, department stores",
  software: "software subscriptions, apps, electronics, cloud services",
  transit: "public transit, gas, parking, tolls, car costs",
  travel: "flights, hotels, rental cars, vacation spending",
  everything_else: "anything that fits no other category",
  transfer: "moving money between the owner's own accounts, credit card payments, brokerage deposits",
};

export const SYSTEM_PROMPT = [
  "You classify personal bank and credit card transactions into budget categories.",
  "Reply with JSON {\"category\": \"<id>\"} using exactly one of these ids:",
  ...LABELS.map((l) => `- ${l}: ${DESCRIPTIONS[l]}`),
].join("\n");

/** User message for one transaction. Plaid's sign convention: positive amount = money out. */
export function userPrompt(e: Example): string {
  const lines = [
    `Description: ${e.name}`,
    `Merchant: ${e.merchantName ?? "unknown"}`,
    `Amount: $${Math.abs(e.amount).toFixed(2)} ${e.amount >= 0 ? "out of" : "into"} the account`,
    `Account: ${[e.accountType, e.accountSubtype].filter(Boolean).join(" / ") || "unknown"}`,
  ];
  return lines.join("\n");
}

/** JSON schema for Ollama's `format`: constrains decoding to one valid label. */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: { category: { type: "string", enum: [...LABELS] } },
  required: ["category"],
} as const;

/** The predicted label, or null when the reply isn't a valid one (counted as wrong). */
export function parsePrediction(content: string): Assignment | null {
  try {
    const v = (JSON.parse(content) as { category?: unknown }).category;
    return typeof v === "string" && (LABELS as readonly string[]).includes(v) ? (v as Assignment) : null;
  } catch {
    return null;
  }
}

/**
 * Only loopback Ollama hosts are allowed: the prompts contain real transaction descriptions,
 * which must not leave this machine.
 */
export function assertLoopbackUrl(raw: string): URL {
  const u = new URL(raw);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Ollama host must be loopback (127.0.0.1, localhost or ::1).");
  }
  return u;
}

// ---------------------------------------------------------------- metrics

export type ClassMetrics = { label: Assignment; support: number; predicted: number; precision: number | null; recall: number | null; f1: number | null };

export type Metrics = {
  n: number;
  correct: number;
  accuracy: number;
  /** Mean F1 over classes present in the gold labels. */
  macroF1: number;
  invalid: number;
  /** Accuracy of always predicting the most common gold label. */
  majorityBaseline: number;
  perClass: ClassMetrics[];
  /** confusion[gold][predicted]; "invalid" for unparseable replies. Zero cells omitted. */
  confusion: Record<string, Record<string, number>>;
};

export function computeMetrics(pairs: { gold: Assignment; pred: Assignment | null }[]): Metrics {
  const n = pairs.length;
  const confusion: Record<string, Record<string, number>> = {};
  const goldCount = new Map<string, number>();
  const predCount = new Map<string, number>();
  const tp = new Map<string, number>();
  let correct = 0;
  let invalid = 0;
  for (const { gold, pred } of pairs) {
    const p = pred ?? "invalid";
    if (pred === null) invalid++;
    confusion[gold] ??= {};
    confusion[gold][p] = (confusion[gold][p] ?? 0) + 1;
    goldCount.set(gold, (goldCount.get(gold) ?? 0) + 1);
    predCount.set(p, (predCount.get(p) ?? 0) + 1);
    if (gold === pred) {
      correct++;
      tp.set(gold, (tp.get(gold) ?? 0) + 1);
    }
  }
  const perClass: ClassMetrics[] = LABELS.map((label) => {
    const support = goldCount.get(label) ?? 0;
    const predicted = predCount.get(label) ?? 0;
    const t = tp.get(label) ?? 0;
    const precision = predicted ? t / predicted : null;
    const recall = support ? t / support : null;
    const f1 =
      precision === null || recall === null ? (support ? 0 : null) : precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, support, predicted, precision, recall, f1 };
  });
  const present = perClass.filter((c) => c.support > 0);
  const majority = Math.max(0, ...goldCount.values());
  return {
    n,
    correct,
    accuracy: n ? correct / n : 0,
    macroF1: present.length ? present.reduce((s, c) => s + (c.f1 ?? 0), 0) / present.length : 0,
    invalid,
    majorityBaseline: n ? majority / n : 0,
    perClass,
    confusion,
  };
}
