import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Fake Plaid client: only the method under test. The real module's other exports are kept.
const fake = vi.hoisted(() => ({ transactionsSync: vi.fn() }));
vi.mock("plaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("plaid")>()),
  PlaidApi: class {
    constructor() {
      return fake;
    }
  },
}));

import * as plaid from "./plaid";

beforeAll(() => {
  Object.assign(process.env, {
    PLAID_CLIENT_ID: "test",
    PLAID_SECRET: "test",
    PLAID_ENV: "sandbox",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    SESSION_SECRET: "x".repeat(32),
    DASHBOARD_PASSWORD_HASH: "test",
  });
});

describe("plaid read-only allowlist", () => {
  it("exports only the approved functions (and never the raw client)", () => {
    // Adding to this list is a security review event: only read-only endpoints are allowed.
    expect(Object.keys(plaid).sort()).toEqual(
      [
        "createLinkToken",
        "describePlaidError",
        "exchangePublicToken",
        "getAccounts",
        "getHoldings",
        "syncTransactions",
      ].sort(),
    );
  });

  it("describePlaidError extracts only the error code and request id", () => {
    const axiosLike = {
      config: { headers: { "PLAID-SECRET": "super-secret" }, data: '{"access_token":"access-x"}' },
      response: { data: { error_code: "ITEM_LOGIN_REQUIRED", request_id: "req-1", extra: "x" } },
    };
    const info = plaid.describePlaidError(axiosLike);
    expect(info).toEqual({ errorCode: "ITEM_LOGIN_REQUIRED", requestId: "req-1" });
    expect(JSON.stringify(info)).not.toMatch(/super-secret|access-x/);
  });
});

// ---------------------------------------------------------------- syncTransactions

const plaidTx = (id: string) => ({
  transaction_id: id,
  account_id: "acct-1",
  date: "2026-11-01",
  authorized_date: null,
  name: `NAME ${id}`,
  merchant_name: "Merchant",
  amount: 10,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  pending: false,
  pending_transaction_id: null,
  personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
  payment_channel: "in store",
  // Fields that must be dropped by narrowing:
  location: { address: "1 Secret St" },
  payment_meta: { reference_number: "REF-SECRET" },
  account_owner: "Owner Name",
  original_description: "ORIGINAL SECRET",
});

const page = (over: Record<string, unknown>) => ({
  data: {
    added: [],
    modified: [],
    removed: [],
    accounts: [{ account_id: "acct-1", name: "Checking", mask: "0000", type: "depository", subtype: "checking" }],
    next_cursor: "c-end",
    has_more: false,
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    ...over,
  },
});

const mutationError = () =>
  Object.assign(new Error("mutation"), {
    response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } },
  });

describe("syncTransactions", () => {
  beforeEach(() => {
    fake.transactionsSync.mockReset();
  });

  it("follows has_more across pages and narrows each transaction", async () => {
    fake.transactionsSync
      .mockResolvedValueOnce(page({ added: [plaidTx("t1")], next_cursor: "c1", has_more: true }))
      .mockResolvedValueOnce(page({ added: [plaidTx("t2")], removed: [{ transaction_id: "t0" }], next_cursor: "c2" }));

    const out = await plaid.syncTransactions("access-x", null);

    expect(fake.transactionsSync).toHaveBeenCalledTimes(2);
    expect(fake.transactionsSync.mock.calls[0][0]).toMatchObject({ cursor: undefined, count: 500 });
    expect(fake.transactionsSync.mock.calls[1][0]).toMatchObject({ cursor: "c1" });
    expect(out.added.map((t) => t.plaidTransactionId)).toEqual(["t1", "t2"]);
    expect(out.removed).toEqual(["t0"]);
    expect(out.nextCursor).toBe("c2");
    expect(out.added[0]).toMatchObject({ category: "FOOD_AND_DRINK", merchantName: "Merchant" });
    expect(JSON.stringify(out)).not.toMatch(/Secret St|REF-SECRET|Owner Name|ORIGINAL SECRET/);
  });

  it("restarts the whole loop from the ORIGINAL cursor after a mutation-during-pagination error", async () => {
    fake.transactionsSync
      .mockResolvedValueOnce(page({ added: [plaidTx("stale")], next_cursor: "c1", has_more: true }))
      .mockRejectedValueOnce(mutationError())
      .mockResolvedValueOnce(page({ added: [plaidTx("fresh")], next_cursor: "c9" }));

    const out = await plaid.syncTransactions("access-x", "c0");

    const cursors = fake.transactionsSync.mock.calls.map((c) => c[0].cursor);
    expect(cursors).toEqual(["c0", "c1", "c0"]);
    // Results from the abandoned attempt are discarded.
    expect(out.added.map((t) => t.plaidTransactionId)).toEqual(["fresh"]);
    expect(out.nextCursor).toBe("c9");
  });

  it("gives up after repeated mutation errors", async () => {
    fake.transactionsSync.mockImplementation(async () => {
      throw mutationError();
    });
    await expect(plaid.syncTransactions("access-x", "c0")).rejects.toThrow("mutation");
    expect(fake.transactionsSync).toHaveBeenCalledTimes(4); // 1 + 3 restarts
  });

  it("rethrows other Plaid errors immediately, without retrying", async () => {
    fake.transactionsSync.mockImplementation(async () => {
      throw Object.assign(new Error("login"), {
        response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } },
      });
    });
    await expect(plaid.syncTransactions("access-x", "c0")).rejects.toThrow("login");
    expect(fake.transactionsSync).toHaveBeenCalledTimes(1);
  });
});
