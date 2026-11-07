"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { changedBudgets, parseBudgetForm, parseMonth } from "@/lib/budgets";
import { listBudgetEntries, setBudgetsFrom } from "@/server/db";
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
