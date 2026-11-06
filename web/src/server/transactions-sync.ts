import "server-only";
import {
  applyInvestmentSync,
  applyTransactionSync,
  listItems,
  setInvestmentStatus,
  type StoredItem,
} from "./db";
import { describePlaidError, getInvestmentTransactions, syncTransactions } from "./plaid";

/** Plaid itself only checks institutions 1–4×/day, so syncing more often than this is waste. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Investments history: full backfill once (Plaid serves up to 24 months), then a recent window. */
export const INV_BACKFILL_DAYS = 730;
export const INV_REFRESH_DAYS = 30;

/** Codes meaning "this item has no investments to fetch": stored, and not retried unless forced. */
const INV_QUIET_CODES = new Set(["PRODUCTS_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS"]);

export type ItemSyncState = {
  itemId: number;
  institutionName: string;
  /** Plaid transactions_update_status, e.g. HISTORICAL_UPDATE_COMPLETE. */
  status: string | null;
  syncedAt: string | null;
  /** Plaid error code from the last cash sync attempt in this request, if it failed. */
  error?: string;
  /**
   * Error code from the last investments fetch (stored on the item, so it stays visible while
   * the retry is throttled). Quiet codes are excluded.
   */
  investmentError?: string;
};

type ItemSyncErrors = { error?: string; investmentError?: string };

// One in-flight sync per item, so concurrent page loads share it instead of racing on the cursor.
const inFlight = new Map<number, Promise<ItemSyncErrors>>();

const isStale = (syncedAt: string | null, now: number) =>
  !syncedAt || now - Date.parse(syncedAt) >= SYNC_INTERVAL_MS;

function wantsCash(item: StoredItem, now: number, force: boolean) {
  return force || isStale(item.txSyncedAt, now);
}

function wantsInvestments(item: StoredItem, now: number, force: boolean) {
  if (force) return true;
  if (item.invStatus && INV_QUIET_CODES.has(item.invStatus)) return false;
  return isStale(item.invSyncedAt, now);
}

/** YYYY-MM-DD (UTC) `days` before `today`. */
export function isoDaysAgo(days: number, today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function logFailure(kind: string, itemId: number, err: unknown): string {
  const info = describePlaidError(err);
  if (info.errorCode === "UNKNOWN_ERROR") {
    // Not a Plaid API error (e.g. DB failure). Log the message only, never the object.
    console.error(`${kind} sync failed`, { itemId, message: (err as Error).message });
  } else {
    console.error(`plaid ${kind} sync failed`, { itemId, ...info });
  }
  return info.errorCode;
}

async function syncCash(item: StoredItem): Promise<string | undefined> {
  try {
    applyTransactionSync(item.id, await syncTransactions(item.accessToken, item.txCursor));
    return undefined;
  } catch (err) {
    return logFailure("transactions", item.id, err);
  }
}

async function syncInvestments(item: StoredItem, now: Date): Promise<string | undefined> {
  const backfill = !item.invBackfilledAt;
  const windowStart = isoDaysAgo(backfill ? INV_BACKFILL_DAYS : INV_REFRESH_DAYS, now);
  const windowEnd = isoDaysAgo(0, now);
  try {
    const result = await getInvestmentTransactions(item.accessToken, windowStart, windowEnd);
    applyInvestmentSync(item.id, { ...result, windowStart, windowEnd, backfill });
    return undefined;
  } catch (err) {
    const quiet = INV_QUIET_CODES.has(describePlaidError(err).errorCode);
    // Quiet codes are expected for bank-only links and aren't logged as failures.
    const code = quiet ? describePlaidError(err).errorCode : logFailure("investments", item.id, err);
    try {
      // Recording the code also stamps inv_synced_at, so failures are retried at most every
      // 5 minutes ("Refresh now" retries immediately) instead of on every page load.
      setInvestmentStatus(item.id, code);
    } catch (dbErr) {
      console.error("investments status write failed", { itemId: item.id, message: (dbErr as Error).message });
    }
    return quiet ? undefined : code;
  }
}

/**
 * Cash and investments are synced independently: a failure in one never blocks the other.
 * Exported for tests.
 */
export async function syncItem(item: StoredItem, opts: { force?: boolean } = {}): Promise<ItemSyncErrors> {
  const now = new Date();
  const force = opts.force === true;
  const [error, investmentError] = await Promise.all([
    wantsCash(item, now.getTime(), force) ? syncCash(item) : undefined,
    wantsInvestments(item, now.getTime(), force) ? syncInvestments(item, now) : undefined,
  ]);
  return { error, investmentError };
}

/**
 * Brings every item's stored cash and investment transactions up to date. Each kind is skipped
 * if synced within the last 5 minutes, unless `force`. Failures are per item and per kind:
 * stored rows for a failing item remain visible.
 */
export async function syncAllItems(opts: { force?: boolean } = {}): Promise<ItemSyncState[]> {
  const now = Date.now();
  const force = opts.force === true;
  const items = listItems();
  const errors = new Map<number, ItemSyncErrors>();

  await Promise.all(
    items
      .filter((item) => wantsCash(item, now, force) || wantsInvestments(item, now, force))
      .map(async (item) => {
        let run = inFlight.get(item.id);
        if (!run) {
          run = syncItem(item, { force }).finally(() => inFlight.delete(item.id));
          inFlight.set(item.id, run);
        }
        errors.set(item.id, await run);
      }),
  );

  // Re-read so status/syncedAt reflect what was just written.
  return listItems().map((item) => {
    const stored =
      item.invStatus && item.invStatus !== "ok" && !INV_QUIET_CODES.has(item.invStatus)
        ? item.invStatus
        : undefined;
    return {
      itemId: item.id,
      institutionName: item.institutionName ?? "Unknown institution",
      status: item.txStatus,
      syncedAt: item.txSyncedAt,
      error: errors.get(item.id)?.error,
      investmentError: errors.get(item.id)?.investmentError ?? stored,
    };
  });
}
