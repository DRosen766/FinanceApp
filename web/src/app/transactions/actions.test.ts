import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  syncAllItems: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/server/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/server/transactions-sync", () => ({ syncAllItems: mocks.syncAllItems }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { refreshTransactions } from "./actions";

describe("refreshTransactions server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing without a session (requireSession redirects by throwing)", async () => {
    mocks.requireSession.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(refreshTransactions()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.syncAllItems).not.toHaveBeenCalled();
  });

  it("forces a sync when authenticated", async () => {
    mocks.requireSession.mockResolvedValue(undefined);
    mocks.syncAllItems.mockResolvedValue([]);
    await refreshTransactions();
    expect(mocks.syncAllItems).toHaveBeenCalledWith({ force: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/transactions");
  });
});
