import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "./crypto";
import type { SyncedInvestmentTransaction, TransactionSyncResult } from "./plaid";

let dir: string;
let dbFile: string;
const keyB64 = randomBytes(32).toString("base64");

async function loadDb() {
  vi.resetModules(); // fresh module state: db singleton and cached env
  return import("./db");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "financeapp-db-test-"));
  dbFile = path.join(dir, "test.db");
  Object.assign(process.env, {
    PLAID_CLIENT_ID: "test",
    PLAID_SECRET: "test",
    PLAID_ENV: "sandbox",
    TOKEN_ENCRYPTION_KEY: keyB64,
    SESSION_SECRET: "x".repeat(32),
    DASHBOARD_PASSWORD_HASH: "test",
    DATABASE_PATH: dbFile,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MERCHANT = "Zyxwv Distinctive Merchant";
const NAME = "ZYXWV PURCHASE 4417";

function syncResult(over: Partial<TransactionSyncResult> = {}): TransactionSyncResult {
  return {
    added: [
      {
        plaidTransactionId: "tx-1",
        plaidAccountId: "acct-1",
        date: "2026-11-01",
        authorizedDate: null,
        name: NAME,
        merchantName: MERCHANT,
        amount: 98765.43,
        currency: "USD",
        pending: false,
        category: "GENERAL_MERCHANDISE",
        categoryDetailed: null,
        paymentChannel: "online",
      },
    ],
    modified: [],
    removed: [],
    accounts: [
      { plaidAccountId: "acct-1", name: "Everyday Checking", mask: "1234", type: "depository", subtype: "checking" },
    ],
    nextCursor: "cursor-1",
    status: "HISTORICAL_UPDATE_COMPLETE",
    ...over,
  };
}

describe("db migrations", () => {
  it("upgrades a pre-migration (user_version 0) database in place, keeping items", async () => {
    const raw = new Database(dbFile);
    raw.exec(`CREATE TABLE items (
      id INTEGER PRIMARY KEY, plaid_item_id TEXT NOT NULL UNIQUE, institution_name TEXT,
      access_token_enc BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw
      .prepare(`INSERT INTO items (plaid_item_id, institution_name, access_token_enc) VALUES (?, ?, ?)`)
      .run("item-old", "Old Bank", encrypt("access-sandbox-old", Buffer.from(keyB64, "base64"), "item-old"));
    raw.close();

    const db = await loadDb();
    const items = db.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ plaidItemId: "item-old", accessToken: "access-sandbox-old", txCursor: null });

    const check = new Database(dbFile, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(db.SCHEMA_VERSION);
    check.close();
  });
});

describe("applyTransactionSync", () => {
  it("adds, modifies, removes, and stores the cursor", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Test Bank");
    const itemId = db.listItems()[0].id;

    db.applyTransactionSync(itemId, syncResult());
    let txs = db.listTransactions();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ merchantName: MERCHANT, amount: 98765.43, pending: false });
    expect(db.listItems()[0]).toMatchObject({ txCursor: "cursor-1", txStatus: "HISTORICAL_UPDATE_COMPLETE" });
    const [account] = db.listAccounts();
    expect(account).toMatchObject({ name: "Everyday Checking", mask: "1234", institutionName: "Test Bank" });
    expect(txs[0].accountId).toBe(account.id);

    const modified = { ...syncResult().added[0], amount: 1.23 };
    const added2 = { ...syncResult().added[0], plaidTransactionId: "tx-2", plaidAccountId: "acct-unknown" };
    db.applyTransactionSync(itemId, syncResult({ added: [added2], modified: [modified], nextCursor: "cursor-2" }));
    txs = db.listTransactions();
    expect(txs).toHaveLength(2);
    expect(txs.find((t) => t.amount === 1.23)).toBeDefined();
    // A transaction for an account Plaid didn't list gets a placeholder account, not a failure.
    expect(db.listAccounts().map((a) => a.name)).toContain("Unknown account");

    db.applyTransactionSync(itemId, syncResult({ added: [], removed: ["tx-1"], nextCursor: "cursor-3" }));
    expect(db.listTransactions()).toHaveLength(1);
    expect(db.listItems()[0].txCursor).toBe("cursor-3");
  });

  it("is atomic: a failure partway leaves cursor and rows unchanged", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Test Bank");
    const itemId = db.listItems()[0].id;
    db.applyTransactionSync(itemId, syncResult());

    const good = { ...syncResult().added[0], plaidTransactionId: "tx-good" };
    const bad = { ...syncResult().added[0], plaidTransactionId: "tx-bad", date: null as unknown as string };
    expect(() =>
      db.applyTransactionSync(itemId, syncResult({ added: [good, bad], removed: ["tx-1"], nextCursor: "cursor-X" })),
    ).toThrow();

    expect(db.listItems()[0].txCursor).toBe("cursor-1");
    expect(db.listTransactions().map((t) => t.merchantName)).toEqual([MERCHANT]);
    expect(db.listTransactions()).toHaveLength(1);
  });

  it("maps Plaid account ids to internal ids (server-side join for live balances)", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Test Bank");
    db.applyTransactionSync(db.listItems()[0].id, syncResult());
    const map = db.accountIdsByPlaidId();
    expect(map.get("acct-1")).toBe(db.listAccounts()[0].id);
    expect(map.size).toBe(1);
  });

  it("stores transaction and account details only as ciphertext", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-secret", "Test Bank");
    db.applyTransactionSync(db.listItems()[0].id, syncResult());

    const bytes = [dbFile, `${dbFile}-wal`]
      .filter(existsSync)
      .map((f) => readFileSync(f).toString("latin1"))
      .join("");
    for (const secret of [MERCHANT, NAME, "98765.43", "Everyday Checking", "access-sandbox-secret"]) {
      expect(bytes).not.toContain(secret);
    }
    // Sanity check that the scan works: the readable date and opaque id are present.
    expect(bytes).toContain("2026-11-01");
    expect(bytes).toContain("tx-1");
  });
});

// ---------------------------------------------------------------- investment transactions

const TICKER = "QZXV";
const INV_NAME = "QZXVW DIVIDEND RECEIVED";

const invTx = (id: string, date: string, over: Partial<SyncedInvestmentTransaction> = {}): SyncedInvestmentTransaction => ({
  plaidInvestmentTransactionId: id,
  plaidAccountId: "inv-acct",
  date,
  name: INV_NAME,
  type: "cash",
  subtype: "dividend",
  quantity: 0,
  price: 0,
  amount: -76543.21,
  fees: null,
  currency: "USD",
  ticker: TICKER,
  securityName: "Qzxv Fund",
  ...over,
});

const invAccounts = [
  { plaidAccountId: "inv-acct", name: "Individual Brokerage", mask: "4321", type: "investment", subtype: "brokerage" },
];

describe("investment transactions store", () => {
  it("migrates a v2 database to v3 keeping items, accounts and transactions", async () => {
    let db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Test Bank");
    db.applyTransactionSync(db.listItems()[0].id, syncResult());
    // Roll back to v2: drop the v3 (and later) objects and reset the version.
    const raw = new Database(dbFile);
    raw.exec(`DROP TABLE budgets;
      DROP TABLE investment_transactions;
      ALTER TABLE items DROP COLUMN inv_synced_at;
      ALTER TABLE items DROP COLUMN inv_backfilled_at;
      ALTER TABLE items DROP COLUMN inv_status;`);
    raw.pragma("user_version = 2");
    raw.close();

    db = await loadDb();
    expect(db.listItems()[0]).toMatchObject({ plaidItemId: "item-1", invBackfilledAt: null, invStatus: null });
    expect(db.listTransactions()).toHaveLength(1);
    expect(db.listInvestmentTransactions()).toEqual([]);
    const check = new Database(dbFile, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(db.SCHEMA_VERSION);
    check.close();
  });

  it("replaces only rows inside the fetched window and records backfill state", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Fidelity");
    const itemId = db.listItems()[0].id;

    db.applyInvestmentSync(itemId, {
      accounts: invAccounts,
      transactions: [invTx("old", "2025-01-15"), invTx("recent-kept", "2026-10-20"), invTx("recent-cancelled", "2026-10-21")],
      windowStart: "2024-11-05",
      windowEnd: "2026-11-05",
      backfill: true,
    });
    expect(db.listInvestmentTransactions()).toHaveLength(3);
    const item = db.listItems()[0];
    expect(item.invBackfilledAt).not.toBeNull();
    expect(item.invStatus).toBe("ok");
    const acct = db.listAccounts().find((a) => a.type === "investment");
    expect(acct).toMatchObject({ name: "Individual Brokerage", mask: "4321", institutionName: "Fidelity" });

    // A 30-day refresh no longer returns the cancelled row and corrects another.
    db.applyInvestmentSync(itemId, {
      accounts: invAccounts,
      transactions: [invTx("recent-kept", "2026-10-20", { amount: -1.5 })],
      windowStart: "2026-10-06",
      windowEnd: "2026-11-05",
      backfill: false,
    });
    const rows = db.listInvestmentTransactions();
    expect(rows.map((r) => r.date).sort()).toEqual(["2025-01-15", "2026-10-20"]);
    expect(rows.find((r) => r.date === "2026-10-20")).toMatchObject({ amount: -1.5, ticker: TICKER, accountId: acct!.id });
    expect(db.listItems()[0].invBackfilledAt).toBe(item.invBackfilledAt);
  });

  it("is atomic: a failure partway leaves stored rows and state unchanged", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Fidelity");
    const itemId = db.listItems()[0].id;
    const window = { windowStart: "2026-10-06", windowEnd: "2026-11-05" };
    db.applyInvestmentSync(itemId, { accounts: invAccounts, transactions: [invTx("a", "2026-10-10")], ...window, backfill: false });
    const before = db.listItems()[0];

    expect(() =>
      db.applyInvestmentSync(itemId, {
        accounts: invAccounts,
        transactions: [invTx("b", "2026-10-11"), invTx("bad", null as unknown as string)],
        ...window,
        backfill: true,
      }),
    ).toThrow();

    expect(db.listInvestmentTransactions().map((r) => r.date)).toEqual(["2026-10-10"]);
    expect(db.listItems()[0]).toMatchObject({ invSyncedAt: before.invSyncedAt, invBackfilledAt: null });
  });

  it("stores investment transaction details only as ciphertext", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Fidelity");
    db.applyInvestmentSync(db.listItems()[0].id, {
      accounts: invAccounts,
      transactions: [invTx("itx-1", "2026-10-10")],
      windowStart: "2026-10-06",
      windowEnd: "2026-11-05",
      backfill: false,
    });
    const bytes = [dbFile, `${dbFile}-wal`]
      .filter(existsSync)
      .map((f) => readFileSync(f).toString("latin1"))
      .join("");
    for (const secret of [TICKER, INV_NAME, "76543.21", "Individual Brokerage", "Qzxv Fund"]) {
      expect(bytes).not.toContain(secret);
    }
    expect(bytes).toContain("itx-1");
  });

  it("records and clears a quiet investments status", async () => {
    const db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Bank");
    const itemId = db.listItems()[0].id;
    db.setInvestmentStatus(itemId, "PRODUCTS_NOT_SUPPORTED");
    expect(db.listItems()[0]).toMatchObject({ invStatus: "PRODUCTS_NOT_SUPPORTED" });
    db.setInvestmentStatus(itemId, null);
    expect(db.listItems()[0]).toMatchObject({ invStatus: null, invSyncedAt: null });
  });
});

describe("budgets store", () => {
  it("migrates a v3 database to v4 keeping existing data", async () => {
    let db = await loadDb();
    db.saveItem("item-1", "access-sandbox-1", "Test Bank");
    const raw = new Database(dbFile);
    raw.exec(`DROP TABLE budgets;`);
    raw.pragma("user_version = 3");
    raw.close();

    db = await loadDb();
    expect(db.listItems()).toHaveLength(1);
    expect(db.getBudgetAmounts().size).toBe(0);
    expect(db.SCHEMA_VERSION).toBe(4);
  });

  it("upserts and clears amounts atomically", async () => {
    const db = await loadDb();
    db.setBudgetAmounts(new Map([["dining", 250], ["groceries", 400.5]]));
    db.setBudgetAmounts(new Map<string, number | null>([["dining", 300], ["groceries", null]]));
    expect([...db.getBudgetAmounts()]).toEqual([["dining", 300]]);
  });

  it("stores amounts only as ciphertext, bound to their category", async () => {
    const db = await loadDb();
    db.setBudgetAmounts(new Map([["dining", 98765.43]]));
    const bytes = [dbFile, `${dbFile}-wal`]
      .filter(existsSync)
      .map((f) => readFileSync(f).toString("latin1"))
      .join("");
    expect(bytes).not.toContain("98765.43");

    // Moving a ciphertext onto another category fails authentication (AAD).
    const raw = new Database(dbFile);
    raw.prepare(`INSERT INTO budgets (category, amount_enc) SELECT 'shopping', amount_enc FROM budgets WHERE category = 'dining'`).run();
    raw.close();
    expect(() => db.getBudgetAmounts()).toThrow();
  });
});
