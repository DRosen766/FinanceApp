// "System 1" classifiers over frozen sentence embeddings: one encoder pass per transaction, no
// token generation. Three heads, all pure and deterministic:
//   - prototype: zero-shot, nearest category-description embedding (no training data)
//   - knn: cosine-weighted vote of the k most similar training transactions
//   - linear: multinomial logistic regression (a linear probe) trained on the train split
// Hyperparameters are fixed defaults, never tuned on the holdout.
import type { Assignment } from "./budgets";

export type Vec = Float64Array;
export type Labelled = { v: Vec; label: Assignment };

export function toVec(xs: number[]): Vec {
  const v = Float64Array.from(xs);
  const n = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Instruction prefix per embedding model family (both recommend one for classification). */
export function embedPrefix(model: string): string {
  if (model.startsWith("qwen3-embedding")) {
    return "Instruct: Classify this bank transaction into a personal budget category\nQuery: ";
  }
  if (model.startsWith("nomic-embed")) return "classification: ";
  return "";
}

/** Zero-shot: the label whose description embedding is most similar. */
export function prototypePredict(prototypes: Labelled[], q: Vec): Assignment {
  let best = prototypes[0];
  let bestSim = -Infinity;
  for (const p of prototypes) {
    const s = dot(p.v, q);
    if (s > bestSim) [best, bestSim] = [p, s];
  }
  return best.label;
}

/** k nearest training rows by cosine similarity, votes weighted by similarity. */
export function knnPredict(train: Labelled[], q: Vec, k = 5): Assignment {
  const nearest = train
    .map((t) => ({ label: t.label, s: dot(t.v, q) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const votes = new Map<Assignment, number>();
  for (const n of nearest) votes.set(n.label, (votes.get(n.label) ?? 0) + Math.max(n.s, 0));
  // Ties go to the label of the closer neighbour (Map keeps first-insertion order = nearest first).
  let best = nearest[0].label;
  for (const [label, w] of votes) if (w > votes.get(best)!) best = label;
  return best;
}

export type LinearOptions = { epochs?: number; lr?: number; l2?: number };

/**
 * Multinomial logistic regression by full-batch gradient descent from zero weights, so the
 * result is deterministic. Only labels seen in training can be predicted.
 */
export function trainLinear(train: Labelled[], opts: LinearOptions = {}) {
  const { epochs = 300, lr = 2, l2 = 1e-4 } = opts;
  if (!train.length) throw new Error("trainLinear needs at least one example");
  const labels = [...new Set(train.map((t) => t.label))];
  const idx = new Map(labels.map((l, i) => [l, i]));
  const d = train[0].v.length;
  const C = labels.length;
  const W = Array.from({ length: C }, () => new Float64Array(d));
  const b = new Float64Array(C);
  const n = train.length;

  const scores = (x: Vec) => {
    const z = W.map((w, c) => dot(w, x) + b[c]);
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const s = e.reduce((a, v) => a + v, 0);
    return e.map((v) => v / s);
  };

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gW = Array.from({ length: C }, () => new Float64Array(d));
    const gb = new Float64Array(C);
    for (const t of train) {
      const p = scores(t.v);
      const y = idx.get(t.label)!;
      for (let c = 0; c < C; c++) {
        const g = p[c] - (c === y ? 1 : 0);
        if (g === 0) continue;
        gb[c] += g;
        const gw = gW[c];
        for (let i = 0; i < d; i++) gw[i] += g * t.v[i];
      }
    }
    for (let c = 0; c < C; c++) {
      b[c] -= (lr * gb[c]) / n;
      const w = W[c];
      const gw = gW[c];
      for (let i = 0; i < d; i++) w[i] -= lr * (gw[i] / n + l2 * w[i]);
    }
  }

  return (q: Vec): Assignment => {
    const p = scores(q);
    let best = 0;
    for (let c = 1; c < C; c++) if (p[c] > p[best]) best = c;
    return labels[best];
  };
}
