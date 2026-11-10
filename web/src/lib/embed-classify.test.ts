import { describe, expect, it } from "vitest";
import { dot, embedPrefix, knnPredict, prototypePredict, toVec, trainLinear, type Labelled } from "./embed-classify";

const L = (xs: number[], label: Labelled["label"]): Labelled => ({ v: toVec(xs), label });

describe("vectors", () => {
  it("normalizes to unit length", () => {
    const v = toVec([3, 4]);
    expect(dot(v, v)).toBeCloseTo(1);
    expect([...v]).toEqual([0.6, 0.8]);
  });
});

describe("embedPrefix", () => {
  it("uses the model family's classification instruction", () => {
    expect(embedPrefix("qwen3-embedding:0.6b")).toMatch(/^Instruct: .*\nQuery: $/);
    expect(embedPrefix("nomic-embed-text:latest")).toBe("classification: ");
    expect(embedPrefix("other")).toBe("");
  });
});

describe("prototypePredict", () => {
  it("picks the most similar prototype", () => {
    const protos = [L([1, 0], "dining"), L([0, 1], "groceries")];
    expect(prototypePredict(protos, toVec([0.2, 0.9]))).toBe("groceries");
  });
});

describe("knnPredict", () => {
  const train = [L([1, 0], "dining"), L([0.9, 0.1], "dining"), L([0, 1], "groceries"), L([0.1, 0.9], "groceries"), L([0.2, 0.95], "groceries")];
  it("takes the weighted majority of the k nearest", () => {
    expect(knnPredict(train, toVec([0.95, 0.05]), 3)).toBe("dining");
    expect(knnPredict(train, toVec([0.05, 1]), 3)).toBe("groceries");
  });
  it("k=1 is nearest neighbour", () => {
    expect(knnPredict(train, toVec([1, 0.01]), 1)).toBe("dining");
  });
});

describe("trainLinear", () => {
  it("separates linearly separable classes and is deterministic", () => {
    const train = [
      L([1, 0, 0], "dining"),
      L([0.9, 0.2, 0], "dining"),
      L([0, 1, 0], "groceries"),
      L([0.1, 0.9, 0.1], "groceries"),
      L([0, 0, 1], "transfer"),
      L([0.1, 0, 0.9], "transfer"),
    ];
    const f = trainLinear(train, { epochs: 200 });
    expect(f(toVec([0.8, 0.1, 0.1]))).toBe("dining");
    expect(f(toVec([0.1, 0.8, 0.1]))).toBe("groceries");
    expect(f(toVec([0.1, 0.1, 0.8]))).toBe("transfer");
    const g = trainLinear(train, { epochs: 200 });
    expect(g(toVec([0.5, 0.4, 0.3]))).toBe(f(toVec([0.5, 0.4, 0.3])));
  });

  it("rejects an empty training set", () => {
    expect(() => trainLinear([])).toThrow();
  });
});
