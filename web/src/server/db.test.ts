import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "./crypto";
import type { TransactionSyncResult } from "./plaid";

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
