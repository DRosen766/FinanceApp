import Link from "next/link";
import { money, signedMoney } from "@/lib/format";
import {
  applyFilters,
  paginate,
  parseFilters,
  prettyCategory,
  summarize,
  toQuery,
  type Filters,
} from "@/lib/transactions";
import { listAccounts, listTransactions, type StoredAccount } from "@/server/db";
import { requireSession } from "@/server/session";
import { syncAllItems, type ItemSyncState } from "@/server/transactions-sync";
import { Nav } from "../Nav";
import { refreshTransactions } from "./actions";

const INCOMPLETE_STATUSES = new Set([
  "NOT_READY",
  "INITIAL_UPDATE_COMPLETE",
  "TRANSACTIONS_UPDATE_STATUS_UNKNOWN",
]);

function formatDate(isoDate: string) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function accountLabel(a: StoredAccount | undefined) {
  if (!a) return "—";
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

function StatusNotes({ states }: { states: ItemSyncState[] }) {
  const notes = states.flatMap((s) => {
    if (s.error) return [{ key: s.itemId, cls: "error", text: `${s.institutionName}: sync failed (${s.error}). Showing stored transactions.` }];
    if (s.status && INCOMPLETE_STATUSES.has(s.status))
      return [{ key: s.itemId, cls: "muted", text: `Plaid is still fetching history for ${s.institutionName}.` }];
    return [];
  });
  if (notes.length === 0) return null;
  return (
    <div className="stack">
      {notes.map((n) => (
        <p key={n.key} className={n.cls}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

function FilterBar({ filters, accounts }: { filters: Filters; accounts: StoredAccount[] }) {
  return (
    <form method="get" action="/transactions" className="filters">
      <label>
        Account
        <select name="account" defaultValue={filters.account ?? ""}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.institutionName ? `${a.institutionName} · ` : ""}
              {accountLabel(a)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Range
        <select name="range" defaultValue={filters.range}>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last 12 months</option>
          <option value="all">All</option>
        </select>
      </label>
      <label>
        Type
        <select name="flow" defaultValue={filters.flow}>
          <option value="all">All</option>
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
      </label>
      <label className="grow">
        Search
        <input type="search" name="q" defaultValue={filters.q} maxLength={100} placeholder="Merchant or description" />
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}

export default async function TransactionsPage({ searchParams }: PageProps<"/transactions">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const states = await syncAllItems();

  // Cash accounts only in v1; investment activity isn't synced by /transactions/sync.
  const accounts = listAccounts().filter((a) => a.type !== "investment");
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const filtered = applyFilters(listTransactions(), filters);
  const summary = summarize(filtered);
  const { rows, page, pages } = paginate(filtered, filters.page);

  return (
    <main>
      <Nav current="transactions" />
      <header className="row">
        <h1>Transactions</h1>
        <form action={refreshTransactions}>
          <button type="submit" className="secondary">
            Refresh now
          </button>
        </form>
      </header>

      <StatusNotes states={states} />
      {states.length === 0 && <p>No accounts linked yet.</p>}

      <section className="card">
        <FilterBar filters={filters} accounts={accounts} />
        <p className="totals">
          <span className="muted">{summary.count.toLocaleString("en-US")} transactions</span>
          {" · "}
          <span className="gain">In {money(summary.moneyIn)}</span>
          {" · "}
          <span>Out {money(summary.moneyOut)}</span>
        </p>

        {rows.length === 0 ? (
          <p className="muted">No transactions match these filters.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Account</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap">{formatDate(t.date)}</td>
                    <td>
                      {t.merchantName ?? t.name}
                      {t.pending && <span className="badge">Pending</span>}
                    </td>
                    <td>{prettyCategory(t.category)}</td>
                    <td className="muted">{accountLabel(accountsById.get(t.accountId))}</td>
                    {/* Plaid: positive = money out. Display money in as +green, money out as −. */}
                    <td className={`num nowrap ${t.amount < 0 ? "gain" : ""}`}>
                      {signedMoney(-t.amount, t.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav className="row pager">
            {page > 1 ? (
              <Link href={`/transactions${toQuery(filters, { page: page - 1 })}`}>← Newer</Link>
            ) : (
              <span />
            )}
            <span className="muted">
              Page {page} of {pages}
            </span>
            {page < pages ? (
              <Link href={`/transactions${toQuery(filters, { page: page + 1 })}`}>Older →</Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>
    </main>
  );
}
