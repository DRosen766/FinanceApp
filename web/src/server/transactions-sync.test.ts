import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredItem } from "./db";

const mocks = vi.hoisted(() => ({
  syncTransactions: vi.fn(),
  getInvestmentTransactions: vi.fn(),
  applyTransactionSync: vi.fn(),
  applyInvestmentSync: vi.fn(),
  setInvestmentStatus: vi.fn(),
  listItems: vi.fn(),
}));
vi.mock("./plaid", async (importOriginal) => ({
  // Keep the real describePlaidError; replace only the network calls.
  describePlaidError: (await importOriginal<typeof import("./plaid")>()).describePlaidError,
  syncTransactions: mocks.syncTransactions,
  getInvestmentTransactions: mocks.getInvestmentTransactions,
}));
vi.mock("./db", () => ({
  applyTransactionSync: mocks.applyTransactionSync,
  applyInvestmentSync: mocks.applyInvestmentSync,
  setInvestmentStatus: mocks.setInvestmentStatus,
  listItems: mocks.listItems,
}));

import { INV_BACKFILL_DAYS, INV_REFRESH_DAYS, isoDaysAgo, syncAllItems, syncItem } from "./transactions-sync";

const plaidError = (code: string) =>
  Object.assign(new Error(code), { response: { data: { error_code: code } } });

const item = (over: Partial<StoredItem> = {}): StoredItem => ({
  id: 1,
  plaidItemId: "item-1",
  institutionName: "Fidelity",
  accessToken: "access-sandbox-1",
  txCursor: null,
  txSyncedAt: null,
  txStatus: null,
  invSyncedAt: null,
  invBackfilledAt: null,
  invStatus: null,
  ...over,
});

const recently = () => new Date(Date.now() - 60_000).toISOString();
const empty = { accounts: [], transactions: [] };

describe("investment sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.syncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], accounts: [], nextCursor: "c", status: "x" });
    mocks.getInvestmentTransactions.mockResolvedValue(empty);
  });

  it("backfills 730 days the first time, then refreshes the last 30 days", async () => {
    const today = new Date();
    await syncItem(item());
    expect(mocks.getInvestmentTransactions).toHaveBeenLastCalledWith(
      "access-sandbox-1",
      isoDaysAgo(INV_BACKFILL_DAYS, today),
      isoDaysAgo(0, today),
    );
    expect(mocks.applyInvestmentSync.mock.calls[0][1]).toMatchObject({ backfill: true });

    await syncItem(item({ invBackfilledAt: "2026-11-01T00:00:00Z" }));
    expect(mocks.getInvestmentTransactions.mock.lastCall?.[1]).toBe(isoDaysAgo(INV_REFRESH_DAYS, today));
    expect(mocks.applyInvestmentSync.mock.calls[1][1]).toMatchObject({ backfill: false });
  });

  it("stores a quiet code without reporting an error, then skips the item unless forced", async () => {
    mocks.getInvestmentTransactions.mockRejectedValueOnce(plaidError("PRODUCTS_NOT_SUPPORTED"));
    expect(await syncItem(item())).toEqual({ error: undefined, investmentError: undefined });
    expect(mocks.setInvestmentStatus).toHaveBeenCalledWith(1, "PRODUCTS_NOT_SUPPORTED");

    mocks.getInvestmentTransactions.mockClear();
    const quiet = item({ invStatus: "PRODUCTS_NOT_SUPPORTED", invSyncedAt: "2020-01-01T00:00:00Z" });
    await syncItem(quiet);
    expect(mocks.getInvestmentTransactions).not.toHaveBeenCalled();

    await syncItem(quiet, { force: true });
    expect(mocks.getInvestmentTransactions).toHaveBeenCalledTimes(1);
  });

  it("records non-quiet failures too, so they are throttled and stay visible", async () => {
    mocks.getInvestmentTransactions.mockRejectedValueOnce(plaidError("ADDITIONAL_CONSENT_REQUIRED"));
    await syncItem(item());
    expect(mocks.setInvestmentStatus).toHaveBeenCalledWith(1, "ADDITIONAL_CONSENT_REQUIRED");

    // Within 5 minutes: no Plaid call, but the stored code is still reported.
    mocks.listItems.mockReturnValue([
      item({ txSyncedAt: recently(), invSyncedAt: recently(), invStatus: "ADDITIONAL_CONSENT_REQUIRED" }),
    ]);
    mocks.getInvestmentTransactions.mockClear();
    const [state] = await syncAllItems();
    expect(mocks.getInvestmentTransactions).not.toHaveBeenCalled();
    expect(state.investmentError).toBe("ADDITIONAL_CONSENT_REQUIRED");
  });

  it("an investments failure doesn't block the cash sync, and vice versa", async () => {
    mocks.getInvestmentTransactions.mockRejectedValueOnce(plaidError("ITEM_LOGIN_REQUIRED"));
    expect(await syncItem(item())).toEqual({ error: undefined, investmentError: "ITEM_LOGIN_REQUIRED" });
    expect(mocks.applyTransactionSync).toHaveBeenCalledTimes(1);

    mocks.syncTransactions.mockRejectedValueOnce(plaidError("INSTITUTION_DOWN"));
    expect(await syncItem(item())).toEqual({ error: "INSTITUTION_DOWN", investmentError: undefined });
    expect(mocks.applyInvestmentSync).toHaveBeenCalledTimes(1);
  });

  it("throttles each kind separately and reports errors per item", async () => {
    mocks.listItems.mockReturnValue([item({ txSyncedAt: recently(), invSyncedAt: null })]);
    mocks.getInvestmentTransactions.mockRejectedValueOnce(plaidError("ADDITIONAL_CONSENT_REQUIRED"));

    const [state] = await syncAllItems();
    expect(mocks.syncTransactions).not.toHaveBeenCalled(); // cash synced a minute ago
    expect(mocks.getInvestmentTransactions).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ itemId: 1, investmentError: "ADDITIONAL_CONSENT_REQUIRED" });

    mocks.listItems.mockReturnValue([item({ txSyncedAt: recently(), invSyncedAt: recently() })]);
    vi.clearAllMocks();
    await syncAllItems();
    expect(mocks.syncTransactions).not.toHaveBeenCalled();
    expect(mocks.getInvestmentTransactions).not.toHaveBeenCalled();
  });
});
