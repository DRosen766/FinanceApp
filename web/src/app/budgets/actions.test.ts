import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_FIELD_PREFIX, CATEGORY_IDS } from "@/lib/budgets";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  setBudgetsFrom: vi.fn(),
  listBudgetEntries: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/server/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/server/db", () => ({
  setBudgetsFrom: mocks.setBudgetsFrom,
  listBudgetEntries: mocks.listBudgetEntries,
}));
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
    expect(mocks.setBudgetsFrom).not.toHaveBeenCalled();
  });

  it("saves only changed amounts, effective from the viewed month", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    mocks.listBudgetEntries.mockReturnValue([
      { category: "dining", fromMonth: "2026-01", amount: 100 },
      { category: "shopping", fromMonth: "2026-01", amount: 50 },
    ]);
    await expect(
      saveBudgets(form({ month: "2026-10", budget_dining: "100", budget_shopping: "75" })),
    ).rejects.toThrow("NEXT_REDIRECT /budgets?month=2026-10&saved=1");
    expect(mocks.setBudgetsFrom).toHaveBeenCalledWith("2026-10", new Map([["shopping", 75]]));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/budgets");
  });

  it("writes nothing when nothing changed", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    mocks.listBudgetEntries.mockReturnValue([]);
    await expect(saveBudgets(form({ month: "2026-10" }))).rejects.toThrow("saved=0");
    expect(mocks.setBudgetsFrom).not.toHaveBeenCalled();
  });

  it("saves nothing when any amount is invalid, and keeps amounts out of the URL", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    const err = await saveBudgets(form({ month: "bogus", budget_dining: "-7341", budget_shopping: "12" })).catch((e: Error) => e);
    expect(String(err)).toMatch(/\/budgets\?month=\d{4}-\d{2}&invalid=dining$/);
    expect(String(err)).not.toContain("7341");
    expect(mocks.setBudgetsFrom).not.toHaveBeenCalled();
  });
});
