"use client";

import { useTransition } from "react";
import { ASSIGNMENT_OPTIONS, AUTO, type Assignment } from "@/lib/budgets";
import { setTransactionCategory } from "./actions";

/**
 * Per-transaction category picker. Saves on change through a server action (session-checked,
 * input re-validated on the server); the page re-renders with the new totals.
 */
export function CategorySelect({
  id,
  value,
  autoLabel,
  label,
  disabledReason,
}: {
  /** Internal transaction row id. */
  id: number;
  /** The manual choice, or AUTO when there is none. */
  value: Assignment | typeof AUTO;
  /** Name of the category the transaction gets automatically. */
  autoLabel: string;
  /** Accessible name, e.g. the merchant and date. */
  label: string;
  disabledReason?: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <select
      className="category-select"
      // Remount when the saved value changes so the control reflects the server's state.
      key={value}
      defaultValue={value}
      disabled={pending || disabledReason !== undefined}
      title={disabledReason}
      aria-label={`Category for ${label}`}
      aria-busy={pending || undefined}
      onChange={(e) => {
        const form = new FormData();
        form.set("id", String(id));
        form.set("category", e.currentTarget.value);
        startTransition(() => setTransactionCategory(form));
      }}
    >
      <option value={AUTO}>Automatic: {autoLabel}</option>
      {ASSIGNMENT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
