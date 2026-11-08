"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { groceryCharges, matchCharges, MAX_IMPORT_CHARS, parseAmazonTransactions } from "@/lib/amazon";
import { changedBudgets, parseBudgetForm, parseMonth } from "@/lib/budgets";
import {
  listAccounts,
  listBudgetEntries,
  listTransactions,
  setBudgetsFrom,
  setCategoryOverrides,
} from "@/server/db";
import { requireSession } from "@/server/session";

/**
 * Save the budgets shown for a month. Changed amounts apply from that month onward; earlier
 * months keep theirs, so past carryover doesn't move. Next checks server action Origins.
 */
export async function saveBudgets(form: FormData): Promise<void> {
  await requireSession();
  const month = parseMonth(form.get("month"), new Date());
  const parsed = parseBudgetForm(form);
  if (!parsed.ok) {
    // Only category ids (from our own fixed list) go in the URL, never amounts.
    redirect(`/budgets?month=${month}&invalid=${parsed.invalid.join(",")}`);
  }
  const changes = changedBudgets(listBudgetEntries(), month, parsed.amounts);
  if (changes.size) setBudgetsFrom(month, changes);
  revalidatePath("/budgets");
  redirect(`/budgets?month=${month}&saved=${changes.size}`);
}

/**
 * Import pasted Amazon payments-page text: charges of orders that took a delivery tip are
 * matched to bank transactions and marked Groceries. The text itself is not stored or logged;
 * only counts go back in the URL.
 */
export async function importAmazonOrders(form: FormData): Promise<void> {
  await requireSession();
  const month = parseMonth(form.get("month"), new Date());
  const text = form.get("amazon");
  if (typeof text !== "string" || !text.trim() || text.length > MAX_IMPORT_CHARS) {
    redirect(`/budgets?month=${month}&amz=invalid#amazon`);
  }
  const charges = parseAmazonTransactions(text);
  const grocery = groceryCharges(charges);
  const mask = new Map(listAccounts().map((a) => [a.id, a.mask]));
  const matched = matchCharges(
    grocery.charges,
    listTransactions().map((t) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      pending: t.pending,
      name: t.name,
      merchantName: t.merchantName,
      mask: mask.get(t.accountId) ?? null,
    })),
  );
  const written = setCategoryOverrides(
    new Map([...matched].map((id) => [id, { category: "groceries", source: "amazon" as const }])),
  );
  revalidatePath("/budgets");
  const counts = [charges.length, grocery.orders, grocery.charges.length, written].join("-");
  redirect(`/budgets?month=${month}&amz=${counts}#amazon`);
}
