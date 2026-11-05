import "server-only";
import { applyTransactionSync, listItems, type StoredItem } from "./db";
import { describePlaidError, syncTransactions } from "./plaid";

/** Plaid itself only checks institutions 1–4×/day, so syncing more often than this is waste. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

export type ItemSyncState = {
  itemId: number;
  institutionName: string;
  /** Plaid transactions_update_status, e.g. HISTORICAL_UPDATE_COMPLETE. */
  status: string | null;
  syncedAt: string | null;
  /** Plaid error code from the last attempt in this request, if it failed. */
  error?: string;
};

// One in-flight sync per item, so concurrent page loads share it instead of racing on the cursor.
const inFlight = new Map<number, Promise<string | undefined>>();

function isStale(item: StoredItem, now: number): boolean {
  if (!item.txSyncedAt) return true;
  return now - Date.parse(item.txSyncedAt) >= SYNC_INTERVAL_MS;
}

async function syncItem(item: StoredItem): Promise<string | undefined> {
  try {
    const result = await syncTransactions(item.accessToken, item.txCursor);
    applyTransactionSync(item.id, result);
    return undefined;
  } catch (err) {
    const info = describePlaidError(err);
    if (info.errorCode === "UNKNOWN_ERROR") {
      // Not a Plaid API error (e.g. DB failure). Log the message only, never the object.
      console.error("transactions sync failed", { itemId: item.id, message: (err as Error).message });
    } else {
      console.error("plaid transactions_sync failed", { itemId: item.id, ...info });
    }
    return info.errorCode;
  }
}

/**
 * Brings every item's stored transactions up to date. Items synced within the last 5 minutes
 * are skipped unless `force`. Failures are per item: other items still sync, and stored
 * transactions for a failing item remain visible.
 */
export async function syncAllItems(opts: { force?: boolean } = {}): Promise<ItemSyncState[]> {
  const now = Date.now();
  const items = listItems();
  const errors = new Map<number, string>();

  await Promise.all(
    items
      .filter((item) => opts.force || isStale(item, now))
      .map(async (item) => {
        let run = inFlight.get(item.id);
        if (!run) {
          run = syncItem(item).finally(() => inFlight.delete(item.id));
          inFlight.set(item.id, run);
        }
        const error = await run;
        if (error) errors.set(item.id, error);
      }),
  );

  // Re-read so status/syncedAt reflect what was just written.
  return listItems().map((item) => ({
    itemId: item.id,
    institutionName: item.institutionName ?? "Unknown institution",
    status: item.txStatus,
    syncedAt: item.txSyncedAt,
    error: errors.get(item.id),
  }));
}
