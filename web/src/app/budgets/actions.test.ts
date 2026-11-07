import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_FIELD_PREFIX, CATEGORY_IDS } from "@/lib/budgets";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  setBudgetAmounts: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/server/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/server/db", () => ({ setBudgetAmounts: mocks.setBudgetAmounts }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { saveBudgets } from "./actions";

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const id of CATEGORY_IDS) f.set(BUDGET_FIELD_PREFIX + id, "");
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe("saveBudgets server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing without a session", async () => {
    mocks.requireSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(saveBudgets(form({ budget_dining: "100" }))).rejects.toThrow("/login");
    expect(mocks.setBudgetAmounts).not.toHaveBeenCalled();
  });

  it("saves valid amounts and returns to the same month", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    await expect(saveBudgets(form({ month: "2026-10", budget_dining: "100" }))).rejects.toThrow(
      "NEXT_REDIRECT /budgets?month=2026-10&saved=1",
    );
    const saved = mocks.setBudgetAmounts.mock.calls[0][0] as Map<string, number | null>;
    expect(saved.get("dining")).toBe(100);
    expect(saved.get("groceries")).toBeNull();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/budgets");
  });

  it("saves nothing when any amount is invalid, and keeps amounts out of the URL", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    const err = await saveBudgets(form({ month: "bogus", budget_dining: "-7341", budget_shopping: "12" })).catch((e: Error) => e);
    expect(String(err)).toMatch(/\/budgets\?month=\d{4}-\d{2}&invalid=dining$/);
    expect(String(err)).not.toContain("7341");
    expect(mocks.setBudgetAmounts).not.toHaveBeenCalled();
  });
});
