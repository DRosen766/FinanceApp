/**
 * Evaluate local models as transaction classifiers on a holdout set of the already-labelled
 * transactions (labels = categorize() from src/lib/budgets.ts).
 *
 *   npm run eval:classify -- --env .env.prod [--backend embed|chat] [--holdout 0.2] [--seed v1]
 *
 *   --backend embed  "System 1": one encoder pass per transaction (--embed-model, default
 *                    qwen3-embedding:0.6b), scored by three heads: zero-shot prototype, kNN
 *                    and a linear probe trained on the train split.
 *   --backend chat   Generative: a chat model (--model, default qwen3:0.6b) picks a label under
 *                    constrained decoding. Also --concurrency N, --limit N.
 *
 * Prints aggregate metrics only. Per-transaction predictions (which contain descriptors) go
 * to eval-results/ (gitignored, mode 0600). Ollama must be on loopback.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Assignment } from "../src/lib/budgets";
import type { Example, Metrics } from "../src/lib/classify-eval";

const { values: args } = parseArgs({
  options: {
    env: { type: "string" },
    backend: { type: "string", default: "embed" },
    model: { type: "string", default: "qwen3:0.6b" },
    "embed-model": { type: "string", default: "qwen3-embedding:0.6b" },
    k: { type: "string", default: "5" },
    holdout: { type: "string", default: "0.2" },
    seed: { type: "string", default: "v1" },
    concurrency: { type: "string", default: "4" },
    limit: { type: "string" },
    host: { type: "string", default: process.env.OLLAMA_HOST_URL ?? "http://127.0.0.1:11434" },
    "out-dir": { type: "string", default: "eval-results" },
  },
});

type Prediction = { id: number; pred: Assignment | null; ms?: number };
type Run = { name: string; predictions: Prediction[] };

async function main() {
  if (!args.env) throw new Error("Pass --env <file> (e.g. .env.prod) so the DB key and path are loaded.");
  if (args.backend !== "embed" && args.backend !== "chat") throw new Error("--backend must be embed or chat.");
  process.loadEnvFile(args.env);

  const { listAccounts, listCategoryOverrides, listTransactions } = await import("../src/server/db");
  const { toCashRow } = await import("../src/lib/transactions");
  const cls = await import("../src/lib/classify-eval");

  const host = cls.assertLoopbackUrl(args.host);
  const fraction = Number(args.holdout);
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

  const model = args.backend === "embed" ? args["embed-model"] : args.model;
  const tags = (await (await fetch(new URL("/api/tags", host))).json()) as { models: { name: string }[] };
  if (!tags.models.some((m) => m.name === model)) throw new Error(`Model ${model} isn't installed. Run: ollama pull ${model}`);

  console.log(`${examples.length} labelled transactions → ${train.length} train / ${fullHoldout.length} holdout (seed ${args.seed})`);
  console.log(`Backend ${args.backend}, model ${model}, ${holdout.length} holdout rows\n`);

  const started = Date.now();
  const runs = args.backend === "embed" ? await runEmbed(host, model, train, holdout) : await runChat(host, model, holdout);
  const wallMs = Date.now() - started;

  const results = runs.map((r) => {
    const gold = new Map(holdout.map((e) => [e.id, e.label]));
    return { ...r, metrics: cls.computeMetrics(r.predictions.map((p) => ({ gold: gold.get(p.id)!, pred: p.pred }))) };
  });
  for (const r of results) printMetrics(r.name, r.metrics);
  console.log(`Wall time ${(wallMs / 1000).toFixed(1)} s`);

  // Per-row detail stays local: descriptors are real financial data.
  const outDir = path.resolve(args["out-dir"]);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.backend}-${model.replace(/[^\w.-]/g, "_")}.json`);
  const byId = new Map(holdout.map((e) => [e.id, e]));
  const report = {
    backend: args.backend,
    model,
    seed: args.seed,
    holdoutFraction: fraction,
    systemPrompt: cls.SYSTEM_PROMPT,
    wallMs,
    runs: results.map((r) => ({
      name: r.name,
      metrics: r.metrics,
      predictions: r.predictions.map((p) => ({ ...byId.get(p.id)!, pred: p.pred, correct: p.pred === byId.get(p.id)!.label, ms: p.ms })),
    })),
  };
  writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Detail (local only, contains descriptors): ${path.relative(process.cwd(), file)}`);

  // ---------------------------------------------------------------- backends

  async function runEmbed(host: URL, model: string, train: Example[], holdout: Example[]): Promise<Run[]> {
    const emb = await import("../src/lib/embed-classify");
    const prefix = emb.embedPrefix(model);
    const embed = async (texts: string[]) => {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await fetch(new URL("/api/embed", host), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({ model, input: texts.slice(i, i + 64) }),
        });
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
        out.push(...((await res.json()) as { embeddings: number[][] }).embeddings);
      }
      return out.map(emb.toVec);
    };

    const t0 = Date.now();
    const trainV = await embed(train.map((e) => prefix + cls.userPrompt(e)));
    const holdV = await embed(holdout.map((e) => prefix + cls.userPrompt(e)));
    const embedMs = Date.now() - t0;
    const protoV = await embed(cls.LABELS.map((l) => `${l.replace(/_/g, " ")}: ${cls.DESCRIPTIONS[l]}`));
    console.log(`Embedded ${train.length + holdout.length} rows in ${(embedMs / 1000).toFixed(1)} s (${((embedMs / (train.length + holdout.length)) || 0).toFixed(1)} ms/row)\n`);

    const trainSet = train.map((e, i) => ({ v: trainV[i], label: e.label }));
    const protos = cls.LABELS.map((label, i) => ({ v: protoV[i], label }));
    const k = Math.max(1, Number(args.k) | 0);
    const t1 = Date.now();
    const linear = emb.trainLinear(trainSet);
    console.log(`Trained linear probe in ${((Date.now() - t1) / 1000).toFixed(1)} s\n`);

    const run = (name: string, f: (v: Float64Array) => Assignment): Run => ({
      name,
      predictions: holdout.map((e, i) => ({ id: e.id, pred: f(holdV[i]) })),
    });
    return [
      run("prototype (zero-shot)", (v) => emb.prototypePredict(protos, v)),
      run(`kNN (k=${k})`, (v) => emb.knnPredict(trainSet, v, k)),
      run("linear probe", linear),
    ];
  }

  async function runChat(host: URL, model: string, holdout: Example[]): Promise<Run[]> {
    const concurrency = Math.max(1, Number(args.concurrency) | 0);
    const predictions: Prediction[] = new Array(holdout.length);
    let next = 0;
    let done = 0;
    const classify = async (e: Example): Promise<Prediction> => {
      const t0 = Date.now();
      const res = await fetch(new URL("/api/chat", host), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
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
      return { id: e.id, pred: cls.parsePrediction(body.message?.content ?? ""), ms: Date.now() - t0 };
    };
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < holdout.length) {
          const i = next++;
          predictions[i] = await classify(holdout[i]);
          if (++done % 10 === 0 || done === holdout.length) process.stdout.write(`\r  ${done}/${holdout.length}`);
        }
      }),
    );
    process.stdout.write("\n\n");
    const lat = predictions.map((p) => p.ms ?? 0).sort((a, b) => a - b);
    console.log(`Latency p50 ${lat[Math.floor(lat.length / 2)] ?? 0} ms\n`);
    return [{ name: "chat (constrained decoding)", predictions }];
  }
}

function printMetrics(name: string, m: Metrics) {
  const pct = (v: number | null) => (v === null ? "   —" : `${(v * 100).toFixed(0).padStart(3)}%`);
  console.log(`== ${name}`);
  console.log(`Accuracy ${pct(m.accuracy)} (${m.correct}/${m.n})   Macro F1 ${pct(m.macroF1)}   Majority base ${pct(m.majorityBaseline)}   Invalid ${m.invalid}`);
  console.log("  class             support  pred   prec   rec    f1");
  for (const c of m.perClass) {
    if (!c.support && !c.predicted) continue;
    console.log(
      `  ${c.label.padEnd(17)} ${String(c.support).padStart(7)} ${String(c.predicted).padStart(5)}  ${pct(c.precision)}  ${pct(c.recall)}  ${pct(c.f1)}`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
