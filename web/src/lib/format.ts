export function money(amount: number | null, currency: string | null = "USD") {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(
    amount,
  );
}

export function signedMoney(amount: number | null, currency: string | null = "USD") {
  if (amount === null) return "—";
  return (amount > 0 ? "+" : "") + money(amount, currency);
}

export function percent(fraction: number | null) {
  if (fraction === null) return "—";
  return (fraction > 0 ? "+" : "") + (fraction * 100).toFixed(2) + "%";
}

export function quantity(q: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(q);
}

/** CSS class for a gain/loss value. */
export function signClass(n: number | null) {
  if (n === null || n === 0) return "";
  return n > 0 ? "gain" : "loss";
}
