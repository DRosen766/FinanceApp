import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPlaidLink, PLAID_LINK_SRC, resetPlaidLinkLoader, type PlaidGlobal } from "./plaid-link";

/** Minimal DOM stand-in: tracks appended script tags and lets tests fire load/error. */
function fakeEnv() {
  const tags: FakeScript[] = [];
  class FakeScript {
    src = "";
    async = false;
    removed = false;
    listeners: Record<string, (() => void)[]> = {};
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    fire(type: string) {
      for (const fn of this.listeners[type] ?? []) fn();
    }
    remove() {
      this.removed = true;
    }
  }
  const win: { Plaid?: PlaidGlobal } = {};
  const env = {
    window: win,
    document: {
      head: { appendChild: (el: FakeScript) => (tags.push(el), el) },
      createElement: () => new FakeScript(),
      querySelector: (sel: string) =>
        tags.find((t) => !t.removed && sel === `script[src="${t.src}"]`) ?? null,
    },
  } as unknown as Parameters<typeof loadPlaidLink>[0];
  return { env, tags, win };
}

const plaid: PlaidGlobal = { create: vi.fn() };

describe("loadPlaidLink", () => {
  beforeEach(() => {
    resetPlaidLinkLoader();
  });

  it("adds exactly one script tag for concurrent and repeated loads", async () => {
    const { env, tags, win } = fakeEnv();
    const a = loadPlaidLink(env);
    const b = loadPlaidLink(env); // e.g. StrictMode remount or a second button
    expect(tags).toHaveLength(1);
    expect(tags[0].src).toBe(PLAID_LINK_SRC);
    win.Plaid = plaid;
    tags[0].fire("load");
    await expect(a).resolves.toBe(plaid);
    await expect(b).resolves.toBe(plaid);
    await expect(loadPlaidLink(env)).resolves.toBe(plaid);
    expect(tags).toHaveLength(1);
  });

  it("reuses an existing tag instead of adding another", async () => {
    const { env, tags, win } = fakeEnv();
    const existing = env!.document.createElement("script") as unknown as (typeof tags)[number];
    existing.src = PLAID_LINK_SRC;
    env!.document.head.appendChild(existing as unknown as HTMLScriptElement);
    const p = loadPlaidLink(env);
    expect(tags).toHaveLength(1);
    win.Plaid = plaid;
    existing.fire("load");
    await expect(p).resolves.toBe(plaid);
  });

  it("drops a failed tag so a retry adds a fresh one", async () => {
    const { env, tags, win } = fakeEnv();
    const first = loadPlaidLink(env);
    tags[0].fire("error");
    await expect(first).rejects.toThrow("Couldn't load Plaid Link");
    expect(tags[0].removed).toBe(true);

    const retry = loadPlaidLink(env);
    expect(tags).toHaveLength(2);
    win.Plaid = plaid;
    tags[1].fire("load");
    await expect(retry).resolves.toBe(plaid);
  });

  it("resolves immediately when Plaid is already on the page", async () => {
    const { env, tags, win } = fakeEnv();
    win.Plaid = plaid;
    await expect(loadPlaidLink(env)).resolves.toBe(plaid);
    expect(tags).toHaveLength(0);
  });
});
