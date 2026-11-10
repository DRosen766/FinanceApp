"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { groceryCharges, matchCharges, MAX_IMPORT_CHARS, parseAmazonTransactions } from "@/lib/amazon";
import { AUTO, changedBudgets, parseBudgetForm, parseCategoryChoice, parseMonth } from "@/lib/budgets";
import {
  deleteCategoryOverride,
  listAccounts,
  listCategoryOverrides,
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
  // Never replace a category the owner picked by hand.
  const existing = listCategoryOverrides();
  const written = setCategoryOverrides(
    new Map(
      [...matched]
        .filter((id) => existing.get(id)?.source !== "manual")
        .map((id) => [id, { category: "groceries", source: "amazon" as const }]),
    ),
  );
  revalidatePath("/budgets");
  const counts = [charges.length, grocery.orders, grocery.charges.length, written].join("-");
  redirect(`/budgets?month=${month}&amz=${counts}#amazon`);
}

/**
 * Set one transaction's budget category by hand, or clear it (AUTO) to go back to the automatic
 * one. Invalid input changes nothing. The id is an internal row id; unknown ids are no-ops.
 */
export async function setTransactionCategory(form: FormData): Promise<void> {
  await requireSession();
  const choice = parseCategoryChoice(form);
  if (!choice) return;
  if (choice.category === AUTO) deleteCategoryOverride(choice.id);
  else setCategoryOverrides(new Map([[choice.id, { category: choice.category, source: "manual" as const }]]));
  revalidatePath("/budgets");
}
