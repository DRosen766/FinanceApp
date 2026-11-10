/**
 * Evaluate a local Ollama model as a transaction classifier on a holdout set of the
 * already-labelled transactions (labels = categorize() from src/lib/budgets.ts).
 *
 *   npm run eval:classify -- --env .env.prod [--model qwen3:0.6b] [--holdout 0.2]
 *       [--seed v1] [--concurrency 4] [--limit N] [--host http://127.0.0.1:11434]
 *
 * Prints aggregate metrics only. Per-transaction predictions (which contain descriptors)
 * go to eval-results/ (gitignored, mode 0600). Ollama must be on loopback.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    env: { type: "string" },
    model: { type: "string", default: "qwen3:0.6b" },
    holdout: { type: "string", default: "0.2" },
    seed: { type: "string", default: "v1" },
    concurrency: { type: "string", default: "4" },
    limit: { type: "string" },
    host: { type: "string", default: process.env.OLLAMA_HOST_URL ?? "http://127.0.0.1:11434" },
    "out-dir": { type: "string", default: "eval-results" },
  },
});

async function main() {
  if (!args.env) throw new Error("Pass --env <file> (e.g. .env.prod) so the DB key and path are loaded.");
  process.loadEnvFile(args.env);

  // Imported after the env file is loaded; db.ts reads env lazily but keep the order obvious.
  const { listAccounts, listCategoryOverrides, listTransactions } = await import("../src/server/db");
  const { toCashRow } = await import("../src/lib/transactions");
  const cls = await import("../src/lib/classify-eval");

  const host = cls.assertLoopbackUrl(args.host);
  const fraction = Number(args.holdout);
  const concurrency = Math.max(1, Number(args.concurrency) | 0);
  if (!(fraction > 0 && fraction < 1)) throw new Error("--holdout must be between 0 and 1.");

  const overrides = listCategoryOverrides();
  const rows = listTransactions().map((t) => {
    const o = overrides.get(t.id);
    return o ? { ...toCashRow(t), budgetCategory: o.category } : toCashRow(t);
  });
  const accounts = new Map(listAccounts().map((a) => [a.id, { type: a.type, subtype: a.subtype ?? null }]));
  const examples = cls.toExamples(rows, accounts);
  const { train, holdout: fullHoldout } = cls.splitExamples(examples, args.seed, fraction);
  const holdout = args.limit ? fullHoldout.slice(0, Number(args.limit)) : fullHoldout;

  const tags = (await (await fetch(new URL("/api/tags", host))).json()) as { models: { name: string }[] };
  if (!tags.models.some((m) => m.name === args.model)) {
    throw new Error(`Model ${args.model} isn't installed. Run: ollama pull ${args.model}`);
  }

  console.log(`${examples.length} labelled transactions → ${train.length} train / ${fullHoldout.length} holdout (seed ${args.seed})`);
  console.log(`Evaluating ${args.model} on ${holdout.length} holdout rows…`);

  type Result = { id: number; gold: string; pred: string | null; ms: number };
  const results: Result[] = new Array(holdout.length);
  let next = 0;
  let done = 0;
  const started = Date.now();

  async function classify(e: (typeof holdout)[number]): Promise<Result> {
    const t0 = Date.now();
    const res = await fetch(new URL("/api/chat", host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: args.model,
        stream: false,
        think: false,
        format: cls.RESPONSE_SCHEMA,
        options: { temperature: 0, seed: 0 },
        messages: [
          { role: "system", content: cls.SYSTEM_PROMPT },
          { role: "user", content: cls.userPrompt(e) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return { id: e.id, gold: e.label, pred: cls.parsePrediction(body.message?.content ?? ""), ms: Date.now() - t0 };
  }

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < holdout.length) {
        const i = next++;
        results[i] = await classify(holdout[i]);
        if (++done % 10 === 0 || done === holdout.length) process.stdout.write(`\r  ${done}/${holdout.length}`);
      }
    }),
  );
  const wallMs = Date.now() - started;
  process.stdout.write("\n\n");

  const m = cls.computeMetrics(results.map((r) => ({ gold: r.gold as never, pred: r.pred as never })));
  const pct = (v: number | null) => (v === null ? "   —" : `${(v * 100).toFixed(0).padStart(3)}%`);
  console.log(`Accuracy      ${pct(m.accuracy)}  (${m.correct}/${m.n})`);
  console.log(`Macro F1      ${pct(m.macroF1)}`);
  console.log(`Majority base ${pct(m.majorityBaseline)}`);
  console.log(`Invalid       ${m.invalid}`);
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`Latency       p50 ${lat[Math.floor(lat.length / 2)] ?? 0} ms, wall ${(wallMs / 1000).toFixed(1)} s\n`);
  console.log("class             support  pred   prec   rec    f1");
  for (const c of m.perClass) {
    if (!c.support && !c.predicted) continue;
    console.log(
      `${c.label.padEnd(17)} ${String(c.support).padStart(7)} ${String(c.predicted).padStart(5)}  ${pct(c.precision)}  ${pct(c.recall)}  ${pct(c.f1)}`,
    );
  }

  // Per-row detail stays local: descriptors are real financial data.
  const outDir = path.resolve(args["out-dir"]);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.model.replace(/[^\w.-]/g, "_")}.json`);
  const byId = new Map(holdout.map((e) => [e.id, e]));
  const report = {
    model: args.model,
    seed: args.seed,
    holdoutFraction: fraction,
    systemPrompt: cls.SYSTEM_PROMPT,
    metrics: m,
    wallMs,
    predictions: results.map((r) => ({ ...byId.get(r.id)!, pred: r.pred, correct: r.pred === r.gold, ms: r.ms })),
  };
  writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`\nDetail (local only, contains descriptors): ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
