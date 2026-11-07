"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseBudgetForm, parseMonth } from "@/lib/budgets";
import { setBudgetAmounts } from "@/server/db";
import { requireSession } from "@/server/session";

/** Save every category's monthly budget. Next checks the Origin of server action posts. */
export async function saveBudgets(form: FormData): Promise<void> {
  await requireSession();
  const month = parseMonth(form.get("month"), new Date());
  const parsed = parseBudgetForm(form);
  if (!parsed.ok) {
    // Only category ids (from our own fixed list) go in the URL, never amounts.
    redirect(`/budgets?month=${month}&invalid=${parsed.invalid.join(",")}`);
  }
  setBudgetAmounts(parsed.amounts);
  revalidatePath("/budgets");
  redirect(`/budgets?month=${month}&saved=1`);
}
