import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_FIELD_PREFIX, CATEGORY_IDS } from "@/lib/budgets";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  setBudgetsFrom: vi.fn(),
  listBudgetEntries: vi.fn(),
  listAccounts: vi.fn(),
  listTransactions: vi.fn(),
  setCategoryOverrides: vi.fn(),
  listCategoryOverrides: vi.fn(() => new Map()),
  deleteCategoryOverride: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/server/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/server/db", () => ({
  setBudgetsFrom: mocks.setBudgetsFrom,
  listBudgetEntries: mocks.listBudgetEntries,
  listAccounts: mocks.listAccounts,
  listTransactions: mocks.listTransactions,
  setCategoryOverrides: mocks.setCategoryOverrides,
  listCategoryOverrides: mocks.listCategoryOverrides,
  deleteCategoryOverride: mocks.deleteCategoryOverride,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { importAmazonOrders, saveBudgets, setTransactionCategory } from "./actions";

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

describe("importAmazonOrders server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const page =
    "Nov 02, 2026·Amazon Tips\nVisa••••1111\nOrder #111-1\n-$7.00\nCharged\n" +
    "Nov 01, 2026·Amazon.com\nVisa••••1111\nOrder #111-1\n-$63.45\nCharged\n" +
    "Nov 01, 2026·AMZN Mktp US\nVisa••••1111\nOrder #111-2\n-$20.00\nCharged\n";
  const importForm = (text: string) => {
    const f = new FormData();
    f.set("month", "2026-11");
    f.set("amazon", text);
    return f;
  };

  it("does nothing without a session", async () => {
    mocks.requireSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(importAmazonOrders(importForm(page))).rejects.toThrow("/login");
    expect(mocks.setCategoryOverrides).not.toHaveBeenCalled();
  });

  it("marks matched grocery charges and reports only counts", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    mocks.listAccounts.mockReturnValue([{ id: 1, mask: "1111" }]);
    const t = (id: number, date: string, amount: number) => ({ id, accountId: 1, date, amount, pending: false, name: "AMAZON", merchantName: "Amazon" });
    mocks.listTransactions.mockReturnValue([t(10, "2026-11-03", 7), t(11, "2026-11-02", 63.45), t(12, "2026-11-02", 20)]);
    mocks.setCategoryOverrides.mockImplementation((m: Map<number, unknown>) => m.size);

    const err = await importAmazonOrders(importForm(page)).catch((e: Error) => e);
    expect(String(err)).toContain("/budgets?month=2026-11&amz=3-1-2-2#amazon");
    expect(String(err)).not.toMatch(/63|111-1/);
    const written = mocks.setCategoryOverrides.mock.calls[0][0] as Map<number, unknown>;
    expect([...written.keys()].sort()).toEqual([10, 11]); // not the non-grocery order
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/budgets");
  });

  it("never replaces a category set by hand", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    mocks.listAccounts.mockReturnValue([{ id: 1, mask: "1111" }]);
    const t = (id: number, date: string, amount: number) => ({ id, accountId: 1, date, amount, pending: false, name: "AMAZON", merchantName: "Amazon" });
    mocks.listTransactions.mockReturnValue([t(10, "2026-11-03", 7), t(11, "2026-11-02", 63.45)]);
    mocks.listCategoryOverrides.mockReturnValue(new Map([[11, { category: "shopping", source: "manual" }]]));
    mocks.setCategoryOverrides.mockImplementation((m: Map<number, unknown>) => m.size);
    await importAmazonOrders(importForm(page)).catch(() => {});
    const written = mocks.setCategoryOverrides.mock.calls[0][0] as Map<number, unknown>;
    expect([...written.keys()]).toEqual([10]);
  });

  it("rejects empty or oversized input", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    await expect(importAmazonOrders(importForm("  "))).rejects.toThrow("amz=invalid");
    await expect(importAmazonOrders(importForm("x".repeat(500_001)))).rejects.toThrow("amz=invalid");
    expect(mocks.setCategoryOverrides).not.toHaveBeenCalled();
  });
});

describe("setTransactionCategory server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const choice = (id: string, category: string) => {
    const f = new FormData();
    f.set("id", id);
    f.set("category", category);
    return f;
  };

  it("does nothing without a session", async () => {
    mocks.requireSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(setTransactionCategory(choice("5", "dining"))).rejects.toThrow("/login");
    expect(mocks.setCategoryOverrides).not.toHaveBeenCalled();
    expect(mocks.deleteCategoryOverride).not.toHaveBeenCalled();
  });

  it("stores a manual category, including Not budgeted", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    await setTransactionCategory(choice("5", "travel"));
    await setTransactionCategory(choice("6", "transfer"));
    expect(mocks.setCategoryOverrides.mock.calls).toEqual([
      [new Map([[5, { category: "travel", source: "manual" }]])],
      [new Map([[6, { category: "transfer", source: "manual" }]])],
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/budgets");
  });

  it("clears the manual category on Automatic", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    await setTransactionCategory(choice("5", "auto"));
    expect(mocks.deleteCategoryOverride).toHaveBeenCalledWith(5);
    expect(mocks.setCategoryOverrides).not.toHaveBeenCalled();
  });

  it.each([
    ["0", "dining"],
    ["-1", "dining"],
    ["1.5", "dining"],
    ["99999999999999999", "dining"],
    ["5", "bogus"],
    ["5", "__proto__"],
    ["5", ""],
  ])("ignores invalid input id=%s category=%s", async (id, category) => {
    mocks.requireSession.mockResolvedValue(undefined);
    await setTransactionCategory(choice(id, category));
    expect(mocks.setCategoryOverrides).not.toHaveBeenCalled();
    expect(mocks.deleteCategoryOverride).not.toHaveBeenCalled();
  });
});
