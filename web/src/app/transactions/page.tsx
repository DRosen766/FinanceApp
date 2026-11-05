import Link from "next/link";
import { money, quantity, signedMoney } from "@/lib/format";
import {
  applyFilters,
  paginate,
  parseFilters,
  prettyCategory,
  rowKey,
  summarize,
  toCashRow,
  toInvestmentRow,
  toQuery,
  type Filters,
  type TxRow,
} from "@/lib/transactions";
import {
  listAccounts,
  listInvestmentTransactions,
  listTransactions,
  type StoredAccount,
} from "@/server/db";
import { requireSession } from "@/server/session";
import { syncAllItems, type ItemSyncState } from "@/server/transactions-sync";
import { LinkButton } from "../LinkButton";
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

type Note = { key: string; cls: string; text: string; consentItemId?: number };

function StatusNotes({ states }: { states: ItemSyncState[] }) {
  const notes = states.flatMap((s): Note[] => {
    const out: Note[] = [];
    if (s.error)
      out.push({ key: `c${s.itemId}`, cls: "error", text: `${s.institutionName}: sync failed (${s.error}). Showing stored transactions.` });
    else if (s.status && INCOMPLETE_STATUSES.has(s.status))
      out.push({ key: `c${s.itemId}`, cls: "muted", text: `Plaid is still fetching history for ${s.institutionName}.` });

    if (s.investmentError === "ADDITIONAL_CONSENT_REQUIRED")
      out.push({
        key: `i${s.itemId}`,
        cls: "muted",
        text: `${s.institutionName}: investment activity needs permission. After enabling it, use Refresh now.`,
        consentItemId: s.itemId,
      });
    else if (s.investmentError === "PRODUCT_NOT_READY")
      out.push({ key: `i${s.itemId}`, cls: "muted", text: `Plaid is still loading investment activity for ${s.institutionName}.` });
    else if (s.investmentError)
      out.push({
        key: `i${s.itemId}`,
        cls: "error",
        text: `${s.institutionName}: investment activity sync failed (${s.investmentError}). Showing stored activity.`,
      });
    return out;
  });
  if (notes.length === 0) return null;
  return (
    <div className="stack">
      {notes.map((n) => (
        <div key={n.key} className="row">
          <p className={n.cls}>{n.text}</p>
          {n.consentItemId !== undefined && <LinkButton itemId={n.consentItemId} label="Enable investments" />}
        </div>
      ))}
    </div>
  );
}

function Description({ t }: { t: TxRow }) {
  return (
    <>
      {t.merchantName ?? t.name}
      {t.pending && <span className="badge">Pending</span>}
      {t.ticker && <span className="badge">{t.ticker}</span>}
      {t.kind === "investment" && t.quantity ? (
        <div className="muted small">
          {quantity(Math.abs(t.quantity))} @ {money(t.price ?? null, t.currency)}
          {t.fees ? ` · fees ${money(t.fees, t.currency)}` : ""}
        </div>
      ) : null}
    </>
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
        Kind
        <select name="kind" defaultValue={filters.kind}>
          <option value="all">All</option>
          <option value="cash">Banking &amp; cards</option>
          <option value="investment">Investments</option>
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
        <input type="search" name="q" defaultValue={filters.q} maxLength={100} placeholder="Merchant, description or ticker" />
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}

export default async function TransactionsPage({ searchParams }: PageProps<"/transactions">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const states = await syncAllItems();

  const accounts = listAccounts();
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const all = [...listTransactions().map(toCashRow), ...listInvestmentTransactions().map(toInvestmentRow)];
  const filtered = applyFilters(all, filters);
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
                  <tr key={rowKey(t)}>
                    <td className="nowrap">{formatDate(t.date)}</td>
                    <td>
                      <Description t={t} />
                    </td>
                    <td>{prettyCategory(t.category)}</td>
                    <td className="muted">{accountLabel(accountsById.get(t.accountId))}</td>
                    {/* Plaid: positive = money out. Display money in as +green, money out as −. */}
                    <td
                      className={`num nowrap ${!t.countsAsCash ? "muted" : t.amount < 0 ? "gain" : ""}`}
                      title={t.countsAsCash ? undefined : "Not counted in In/Out"}
                    >
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
      <p className="footnote muted">
        Buys, sells and in-kind transfers are shown with greyed amounts and aren&apos;t counted in In/Out
        or the money in/out filter: they move value inside a brokerage account, not into or out of it.
      </p>
    </main>
  );
}
