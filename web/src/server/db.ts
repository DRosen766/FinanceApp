import "server-only";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { decrypt, encrypt, parseKey } from "./crypto";
import { env } from "./env";

type Db = InstanceType<typeof Database>;

// Built from runtime values on purpose: a literal path.join(process.cwd(), "data", ...) is
// statically traced by Turbopack, which would pull the live database (encrypted tokens)
// into the build's file traces, and fails outright when data/ is a symlink.
const DEFAULT_DB_SEGMENTS = ["data", "finance.db"];
function defaultDbPath(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), ...DEFAULT_DB_SEGMENTS);
}
let db: Db | undefined;

function getDb(): Db {
  if (db) return db;
  const file = env().DATABASE_PATH ?? defaultDbPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  db = new Database(file);
  chmodSync(file, 0o600);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id               INTEGER PRIMARY KEY,
      plaid_item_id    TEXT NOT NULL UNIQUE,
      institution_name TEXT,
      access_token_enc BLOB NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

const key = () => parseKey(env().TOKEN_ENCRYPTION_KEY);

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
};

type ItemRow = {
  id: number;
  plaid_item_id: string;
  institution_name: string | null;
  access_token_enc: Buffer;
};

const SELECT_ITEMS = `SELECT id, plaid_item_id, institution_name, access_token_enc FROM items`;

function toStoredItem(r: ItemRow, k: Buffer): StoredItem {
  return {
    id: r.id,
    plaidItemId: r.plaid_item_id,
    institutionName: r.institution_name,
    accessToken: decrypt(r.access_token_enc, k, r.plaid_item_id),
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
