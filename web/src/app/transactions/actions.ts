"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/session";
import { syncAllItems } from "@/server/transactions-sync";

/** "Refresh now": sync every item regardless of the 5-minute throttle. */
export async function refreshTransactions(): Promise<void> {
  await requireSession();
  await syncAllItems({ force: true });
  revalidatePath("/transactions");
}
