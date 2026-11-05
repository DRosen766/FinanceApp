import "server-only";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { decrypt, encrypt, parseKey } from "./crypto";
import { env } from "./env";
import type { SyncedAccount, SyncedTransaction, TransactionSyncResult } from "./plaid";

type Db = InstanceType<typeof Database>;

// Built from runtime values on purpose: a literal path.join(process.cwd(), "data", ...) is
// statically traced by Turbopack, which would pull the live database (encrypted tokens)
// into the build's file traces, and fails outright when data/ is a symlink.
const DEFAULT_DB_SEGMENTS = ["data", "finance.db"];
function defaultDbPath(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), ...DEFAULT_DB_SEGMENTS);
}

/*
 * Schema migrations, keyed on PRAGMA user_version. Append only: never edit a shipped step.
 * Each step runs in its own transaction together with the version bump.
 *
 * What is readable vs encrypted (AES-256-GCM via crypto.ts, AAD in parentheses):
 *   items.access_token_enc        (plaid_item_id)
 *   accounts.data_enc             ("acct:" + plaid_account_id)  name, mask, type, subtype
 *   transactions.data_enc         ("tx:" + plaid_transaction_id) name, merchant, amount, category…
 * Readable: opaque Plaid ids, sync cursor/status/time, transaction date and pending flag.
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // v1: items (pre-existing databases already have this table at user_version 0).
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id               INTEGER PRIMARY KEY,
        plaid_item_id    TEXT NOT NULL UNIQUE,
        institution_name TEXT,
        access_token_enc BLOB NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
  // v2: transactions sync state + encrypted accounts/transactions.
  (db) =>
    db.exec(`
      ALTER TABLE items ADD COLUMN tx_cursor TEXT;
      ALTER TABLE items ADD COLUMN tx_synced_at TEXT;
      ALTER TABLE items ADD COLUMN tx_status TEXT;

      CREATE TABLE accounts (
        id               INTEGER PRIMARY KEY,
        item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        plaid_account_id TEXT NOT NULL UNIQUE,
        data_enc         BLOB NOT NULL
      );

      CREATE TABLE transactions (
        plaid_transaction_id TEXT PRIMARY KEY,
        account_id           INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date                 TEXT NOT NULL,
        pending              INTEGER NOT NULL,
        data_enc             BLOB NOT NULL
      );
      CREATE INDEX transactions_date ON transactions(date DESC);
      CREATE INDEX transactions_account ON transactions(account_id);
    `),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

let db: Db | undefined;

function getDb(): Db {
  if (db) return db;
  const file = env().DATABASE_PATH ?? defaultDbPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const conn = new Database(file);
  chmodSync(file, 0o600);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  migrate(conn);
  db = conn;
  return db;
}

const key = () => parseKey(env().TOKEN_ENCRYPTION_KEY);

const sealJson = (value: unknown, k: Buffer, aad: string) =>
  encrypt(JSON.stringify(value), k, aad);
const openJson = <T>(blob: Buffer, k: Buffer, aad: string) => JSON.parse(decrypt(blob, k, aad)) as T;

// ---------------------------------------------------------------- items

export function saveItem(plaidItemId: string, accessToken: string, institutionName: string | null) {
  getDb()
    .prepare(
      `INSERT INTO items (plaid_item_id, institution_name, access_token_enc)
       VALUES (?, ?, ?)
       ON CONFLICT(plaid_item_id) DO UPDATE SET
         institution_name = excluded.institution_name,
         access_token_enc = excluded.access_token_enc`,
    )
    .run(plaidItemId, institutionName, encrypt(accessToken, key(), plaidItemId));
}

export type StoredItem = {
  /** Internal row id. The only item identifier that may be sent to the browser. */
  id: number;
  plaidItemId: string;
  institutionName: string | null;
  accessToken: string;
  txCursor: string | null;
  txSyncedAt: string | null;
  txStatus: string | null;
};

type ItemRow = {
  id: number;
  plaid_item_id: string;
  institution_name: string | null;
  access_token_enc: Buffer;
  tx_cursor: string | null;
  tx_synced_at: string | null;
  tx_status: string | null;
};

const SELECT_ITEMS = `SELECT id, plaid_item_id, institution_name, access_token_enc,
                             tx_cursor, tx_synced_at, tx_status FROM items`;

function toStoredItem(r: ItemRow, k: Buffer): StoredItem {
  return {
    id: r.id,
    plaidItemId: r.plaid_item_id,
    institutionName: r.institution_name,
    accessToken: decrypt(r.access_token_enc, k, r.plaid_item_id),
    txCursor: r.tx_cursor,
    txSyncedAt: r.tx_synced_at,
    txStatus: r.tx_status,
  };
}

/** Decrypted items. Server-side only; never pass the result to a Client Component. */
export function listItems(): StoredItem[] {
  const rows = getDb().prepare(`${SELECT_ITEMS} ORDER BY id`).all() as ItemRow[];
  const k = key();
  return rows.map((r) => toStoredItem(r, k));
}

export function getItem(id: number): StoredItem | null {
  const row = getDb().prepare(`${SELECT_ITEMS} WHERE id = ?`).get(id) as ItemRow | undefined;
  return row ? toStoredItem(row, key()) : null;
}

// ---------------------------------------------------------------- transactions sync

type AccountData = Omit<SyncedAccount, "plaidAccountId">;
type TransactionData = Omit<SyncedTransaction, "plaidTransactionId" | "plaidAccountId" | "date" | "pending">;

const UNKNOWN_ACCOUNT: AccountData = { name: "Unknown account", mask: null, type: "other", subtype: null };

/**
 * Applies one /transactions/sync result atomically: accounts, added/modified upserts,
 * removals, and the new cursor either all land or none do, so the cursor never runs ahead of
 * (or behind) the stored data.
 */
export function applyTransactionSync(itemId: number, result: TransactionSyncResult): void {
  const conn = getDb();
  const k = key();

  const upsertAccount = conn.prepare(
    `INSERT INTO accounts (item_id, plaid_account_id, data_enc) VALUES (?, ?, ?)
     ON CONFLICT(plaid_account_id) DO UPDATE SET item_id = excluded.item_id, data_enc = excluded.data_enc`,
  );
  const insertAccountIfMissing = conn.prepare(
    `INSERT INTO accounts (item_id, plaid_account_id, data_enc) VALUES (?, ?, ?)
     ON CONFLICT(plaid_account_id) DO NOTHING`,
  );
  const accountIdFor = conn.prepare(`SELECT id FROM accounts WHERE plaid_account_id = ?`);
  const upsertTx = conn.prepare(
    `INSERT INTO transactions (plaid_transaction_id, account_id, date, pending, data_enc)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(plaid_transaction_id) DO UPDATE SET
       account_id = excluded.account_id, date = excluded.date,
       pending = excluded.pending, data_enc = excluded.data_enc`,
  );
  const removeTx = conn.prepare(`DELETE FROM transactions WHERE plaid_transaction_id = ?`);
  const saveCursor = conn.prepare(
    `UPDATE items SET tx_cursor = ?, tx_status = ?, tx_synced_at = ? WHERE id = ?`,
  );

  conn.transaction(() => {
    for (const a of result.accounts) {
      const { plaidAccountId, ...data } = a;
      upsertAccount.run(itemId, plaidAccountId, sealJson(data, k, `acct:${plaidAccountId}`));
    }
    const accountIds = new Map<string, number>();
    const resolveAccount = (plaidAccountId: string): number => {
      let id = accountIds.get(plaidAccountId);
      if (id === undefined) {
        insertAccountIfMissing.run(
          itemId,
          plaidAccountId,
          sealJson(UNKNOWN_ACCOUNT, k, `acct:${plaidAccountId}`),
        );
        id = (accountIdFor.get(plaidAccountId) as { id: number }).id;
        accountIds.set(plaidAccountId, id);
      }
      return id;
    };
    for (const t of [...result.added, ...result.modified]) {
      const { plaidTransactionId, plaidAccountId, date, pending, ...data } = t;
      upsertTx.run(
        plaidTransactionId,
        resolveAccount(plaidAccountId),
        date,
        pending ? 1 : 0,
        sealJson(data satisfies TransactionData, k, `tx:${plaidTransactionId}`),
      );
    }
    for (const id of result.removed) removeTx.run(id);
    saveCursor.run(result.nextCursor, result.status, new Date().toISOString(), itemId);
  })();
}

// ---------------------------------------------------------------- reads

export type StoredAccount = AccountData & {
  /** Internal row id; safe to put in URLs. */
  id: number;
  itemId: number;
  institutionName: string | null;
};

export function listAccounts(): StoredAccount[] {
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.item_id, a.plaid_account_id, a.data_enc, i.institution_name
       FROM accounts a JOIN items i ON i.id = a.item_id ORDER BY a.id`,
    )
    .all() as {
    id: number;
    item_id: number;
    plaid_account_id: string;
    data_enc: Buffer;
    institution_name: string | null;
  }[];
  const k = key();
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    institutionName: r.institution_name,
    ...openJson<AccountData>(r.data_enc, k, `acct:${r.plaid_account_id}`),
  }));
}

export type StoredTransaction = TransactionData & {
  /** Internal row id; never the Plaid transaction id. */
  id: number;
  accountId: number;
  date: string;
  pending: boolean;
};

/** All stored transactions, decrypted, newest first. Filtering happens in src/lib/transactions.ts. */
export function listTransactions(): StoredTransaction[] {
  const rows = getDb()
    .prepare(
      `SELECT rowid AS id, plaid_transaction_id, account_id, date, pending, data_enc
       FROM transactions ORDER BY date DESC, rowid DESC`,
    )
    .all() as {
    id: number;
    plaid_transaction_id: string;
    account_id: number;
    date: string;
    pending: number;
    data_enc: Buffer;
  }[];
  const k = key();
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    pending: r.pending === 1,
    ...openJson<TransactionData>(r.data_enc, k, `tx:${r.plaid_transaction_id}`),
  }));
}
