import Link from "next/link";
import { money, signedMoney } from "@/lib/format";
import {
  addMonths,
  assignmentLabel,
  AUTO,
  BUDGET_FIELD_PREFIX,
  categorize,
  isAssignment,
  isCategoryId,
  monthLabel,
  monthOf,
  parseMonth,
  summarizeBudget,
  trackingStartMonth,
  type CategoryLine,
} from "@/lib/budgets";
import { prettyCategory, rowKey, toCashRow, type TxRow } from "@/lib/transactions";
import {
  listAccounts,
  listBudgetEntries,
  listCategoryOverrides,
  listTransactions,
} from "@/server/db";
import { requireSession } from "@/server/session";
import { syncAllItems } from "@/server/transactions-sync";
import { Nav } from "../Nav";
import { importAmazonOrders, saveBudgets } from "./actions";
import { CategorySelect } from "./CategorySelect";

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Budget progress: a bar with the share used. Over budget also says so in text, not color alone. */
function Progress({ line }: { line: CategoryLine }) {
  if (!line.budgeted || line.budgeted <= 0) return null;
  const used = line.actual / line.budgeted;
  const over = line.group === "spending" && used > 1;
  return (
    <div className={`bar${over ? " over" : ""}`} aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(1, used)) * 100}%` }} />
    </div>
  );
}

function Remaining({ line }: { line: CategoryLine }) {
  if (line.remaining === null) return <span className="muted">—</span>;
  if (line.group === "spending" && line.remaining < 0) {
    return <span className="loss">{money(-line.remaining)} over</span>;
  }
  return <>{money(line.remaining)}</>;
}

function Carryover({ line }: { line: CategoryLine }) {
  if (line.carryover === null) return <span className="muted">—</span>;
  return <span className={line.carryover < 0 ? "loss" : undefined}>{signedMoney(line.carryover)}</span>;
}

function CategoryRow({ line, invalid }: { line: CategoryLine; invalid: boolean }) {
  return (
    <tr>
      <td>
        <a href={`#cat-${line.id}`}>{line.name}</a>
        <Progress line={line} />
      </td>
      <td className="num">
        <input
          className={`amount${invalid ? " invalid" : ""}`}
          name={BUDGET_FIELD_PREFIX + line.id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          pattern="\$?[0-9,]*(\.[0-9]{1,2})?"
          defaultValue={line.budgeted === null ? "" : String(line.budgeted)}
          aria-label={`${line.name} monthly budget`}
          aria-invalid={invalid || undefined}
        />
      </td>
      <td className="num nowrap">
        <Carryover line={line} />
      </td>
      <td className="num nowrap">{money(line.actual)}</td>
      <td className="num nowrap">
        <Remaining line={line} />
      </td>
      <td className="num nowrap muted">{line.avg3 === null ? "—" : money(line.avg3)}</td>
    </tr>
  );
}

/** The row's category without a manual choice (an Amazon match still counts as automatic). */
function automatic(t: TxRow): string {
  const auto = t.budgetCategorySource === "manual" ? { ...t, budgetCategory: undefined } : t;
  const a = categorize(auto);
  if (a === null) return "Not budgeted";
  return t.budgetCategorySource === "amazon" ? `${assignmentLabel(a)} (Amazon order)` : assignmentLabel(a);
}

/** Excluded categories: actual spending only; no budget field, carryover or remaining. */
function ExcludedRow({ line }: { line: CategoryLine }) {
  return (
    <tr>
      <td>
        <a href={`#cat-${line.id}`}>{line.name}</a>
      </td>
      <td className="num muted">—</td>
      <td className="num muted">—</td>
      <td className="num nowrap">{money(line.actual)}</td>
      <td className="num muted">—</td>
      <td className="num nowrap muted">{line.avg3 === null ? "—" : money(line.avg3)}</td>
    </tr>
  );
}

function TxTable({ rows, accountName }: { rows: TxRow[]; accountName: (id: number) => string }) {
  return (
    <div className="table-scroll">
      <table>
        <tbody>
          {rows.map((t) => (
            <tr key={rowKey(t)}>
              <td className="nowrap muted">{formatDate(t.date)}</td>
              <td>
                {t.merchantName ?? t.name}
                {t.pending && <span className="badge">Pending</span>}
                <div className="muted small">
                  {accountName(t.accountId)} ·{" "}
                  {t.budgetCategorySource === "amazon"
                    ? "Amazon grocery order"
                    : prettyCategory(t.categoryDetailed ?? t.category)}
                  {t.budgetCategorySource === "manual" && " · set by you"}
                </div>
              </td>
              <td className="nowrap">
                <CategorySelect
                  id={t.id}
                  value={
                    t.budgetCategorySource === "manual" && t.budgetCategory && isAssignment(t.budgetCategory)
                      ? t.budgetCategory
                      : AUTO
                  }
                  autoLabel={automatic(t)}
                  label={`${t.merchantName ?? t.name}, ${formatDate(t.date)}`}
                  disabledReason={
                    t.pending ? "Pending: you can change the category once it posts (the bank replaces pending rows)." : undefined
                  }
                />
              </td>
              {/* Same convention as the Transactions page: money out −, money in +. */}
              <td className={`num nowrap ${t.amount < 0 ? "gain" : ""}`}>{signedMoney(-t.amount, t.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "parsed-orders-charges-matched", all integers; anything else is ignored. */
function AmazonResult({ result }: { result: string }) {
  if (result === "invalid") {
    return <p className="error">Nothing imported: paste the text of the Amazon Transactions page.</p>;
  }
  const m = /^(\d{1,5})-(\d{1,5})-(\d{1,5})-(\d{1,5})$/.exec(result);
  if (!m) return null;
  const [parsed, orders, charges, matched] = m.slice(1).map(Number);
  if (parsed === 0) {
    return <p className="error">No Amazon charges found in that text. Copy the whole Transactions page.</p>;
  }
  return (
    <p className="muted">
      Read {parsed} Amazon charges: {orders} grocery {orders === 1 ? "order" : "orders"} (with a delivery
      tip), {charges} grocery {charges === 1 ? "charge" : "charges"}, {matched} matched to your bank
      transactions and marked Groceries.
      {charges > matched &&
        " Unmatched ones are on an unlinked card, still pending, or older than your synced history."}
    </p>
  );
}

function AmazonImport({ month, result }: { month: string; result?: string }) {
  return (
    <section className="card" id="amazon">
      <details open={result !== undefined}>
        <summary>
          <strong>Import Amazon grocery orders</strong>
        </summary>
        <p className="muted small">
          Your bank shows every Amazon order the same way. On amazon.com go to Your Account → Your
          Payments → Transactions, select the whole list, copy it, and paste it here. Orders that took a
          delivery tip (Whole Foods / Amazon Fresh) are matched to your bank transactions by card,
          amount and date, and counted as Groceries. The pasted text isn&apos;t saved.
        </p>
        {result !== undefined && <AmazonResult result={result} />}
        <form action={importAmazonOrders} className="stack">
          <input type="hidden" name="month" value={month} />
          <textarea
            name="amazon"
            rows={6}
            required
            maxLength={500000}
            spellCheck={false}
            autoComplete="off"
            placeholder={"Nov 01, 2026·Amazon Tips\nVisa••••1234\nOrder #…\n-$5.00\nCharged"}
            aria-label="Amazon transactions page text"
          />
          <div>
            <button type="submit">Import</button>
          </div>
        </form>
      </details>
    </section>
  );
}

export default async function BudgetsPage({ searchParams }: PageProps<"/budgets">) {
  await requireSession();
  const today = new Date();
  const params = await searchParams;
  const month = parseMonth(params.month, today);
  const invalid = new Set(
    (typeof params.invalid === "string" ? params.invalid.split(",") : []).filter(isCategoryId),
  );
  await syncAllItems();

  const stored = listTransactions();
  const overrides = listCategoryOverrides();
  const rows = stored.map((t): TxRow => {
    const o = overrides.get(t.id);
    return o ? { ...toCashRow(t), budgetCategory: o.category, budgetCategorySource: o.source } : toCashRow(t);
  });
  const historyStart = stored.length ? stored.reduce((m, t) => (t.date < m ? t.date : m), stored[0].date) : null;
  const accounts = new Map(listAccounts().map((a) => [a.id, a]));
  // Earliest stored date per linked item: carryover starts once every item has history.
  const firstByItem = new Map<number, string>();
  for (const t of stored) {
    const item = accounts.get(t.accountId)?.itemId;
    if (item === undefined) continue;
    const cur = firstByItem.get(item);
    if (!cur || t.date < cur) firstByItem.set(item, t.date);
  }
  const summary = summarizeBudget(
    rows,
    month,
    listBudgetEntries(),
    today,
    historyStart,
    trackingStartMonth([...firstByItem.values()]),
  );
  const accountName = (id: number) => {
    const a = accounts.get(id);
    return a ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : "Unknown account";
  };

  const basics = summary.lines.filter((l) => l.group === "basics");
  const spending = summary.lines.filter((l) => l.group === "spending");
  const excluded = summary.lines.filter((l) => l.group === "excluded");
  const nextMonth = addMonths(month, 1);
  const canGoNext = nextMonth <= addMonths(monthOf(today), 1);
  const perDay =
    summary.daysLeft && summary.remaining > 0 ? summary.remaining / summary.daysLeft : null;

  return (
    <main>
      <Nav current="budgets" />
      <header className="row">
        <h1>{monthLabel(month)} Budget</h1>
        <div className="row month-nav">
          <Link href={`/budgets?month=${addMonths(month, -1)}`}>← {monthLabel(addMonths(month, -1))}</Link>
          {canGoNext && <Link href={`/budgets?month=${nextMonth}`}>{monthLabel(nextMonth)} →</Link>}
        </div>
      </header>

      {typeof params.saved === "string" && (
        <p className="muted">
          {params.saved === "0"
            ? "No budget changes to save."
            : `Saved. Changes apply from ${monthLabel(month)} onward; earlier months keep their budgets.`}
        </p>
      )}
      {invalid.size > 0 && (
        <p className="error">
          Not saved: enter a positive amount with at most 2 decimals (or leave blank) for the
          highlighted categories.
        </p>
      )}

      <section className="card">
        <p className="totals">
          <span className="muted">Left to spend</span>{" "}
          <strong className={summary.remaining < 0 ? "loss" : undefined}>{money(summary.remaining)}</strong>{" "}
          <span className="muted">
            of {money(summary.spendingBudget + summary.carryover)}
            {summary.carryover !== 0 && (
              <>
                {" "}
                ({money(summary.spendingBudget)} budget {summary.carryover > 0 ? "+" : "−"}{" "}
                {money(Math.abs(summary.carryover))} carryover)
              </>
            )}
          </span>
        </p>
        {perDay !== null && (
          <p className="muted small">
            That&apos;s {money(perDay)}/day for the next {summary.daysLeft}{" "}
            {summary.daysLeft === 1 ? "day" : "days"} of the month.
          </p>
        )}
        <div className="stats">
          <div>
            <div className="muted small">Spending budget</div>
            {money(summary.spendingBudget)}
          </div>
          <div>
            <div className="muted small">Carryover</div>
            <span className={summary.carryover < 0 ? "loss" : undefined}>{signedMoney(summary.carryover)}</span>
          </div>
          <div>
            <div className="muted small">Current spend</div>
            {money(summary.currentSpend)}
          </div>
          <div>
            <div className="muted small">Remaining</div>
            <span className={summary.remaining < 0 ? "loss" : undefined}>{money(summary.remaining)}</span>
          </div>
          <div>
            <div className="muted small">Left for savings (budgeted)</div>
            <span className={summary.leftForSavings < 0 ? "loss" : undefined}>
              {money(summary.leftForSavings)}
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <form action={saveBudgets}>
          <input type="hidden" name="month" value={month} />
          <div className="table-scroll">
            <table className="budgets">
              <thead>
                <tr>
                  <th>Budget basics</th>
                  <th className="num">Budgeted / mo</th>
                  <th className="num" title="Running tally of unspent (+) or overspent (−) budget from earlier months">
                    Carryover
                  </th>
                  <th className="num">Actual</th>
                  <th className="num">Remaining</th>
                  <th className="num nowrap" title="Average of up to 3 full months before this one">
                    3-mo avg
                  </th>
                </tr>
              </thead>
              <tbody>
                {basics.map((l) => (
                  <CategoryRow key={l.id} line={l} invalid={invalid.has(l.id)} />
                ))}
              </tbody>
              <thead>
                <tr>
                  <th colSpan={6}>Budget categories</th>
                </tr>
              </thead>
              <tbody>
                {spending.map((l) => (
                  <CategoryRow key={l.id} line={l} invalid={invalid.has(l.id)} />
                ))}
                <tr className="total-row">
                  <td>
                    <strong>Spending budget</strong>
                  </td>
                  <td className="num nowrap">{money(summary.spendingBudget)}</td>
                  <td className={`num nowrap ${summary.carryover < 0 ? "loss" : ""}`}>{signedMoney(summary.carryover)}</td>
                  <td className="num nowrap">{money(summary.currentSpend)}</td>
                  <td className={`num nowrap ${summary.remaining < 0 ? "loss" : ""}`}>
                    {summary.remaining < 0 ? `${money(-summary.remaining)} over` : money(summary.remaining)}
                  </td>
                  <td />
                </tr>
              </tbody>
              {excluded.length > 0 && (
                <>
                  <thead>
                    <tr>
                      <th colSpan={6} title="No budget, and not counted in current spend or what's left to spend">
                        Excluded from budget
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {excluded.map((l) => (
                      <ExcludedRow key={l.id} line={l} />
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
          <div className="row form-actions">
            <span className="muted small">
              Changes apply from {monthLabel(month)} onward. Leave blank for no budget.
            </span>
            <button type="submit">Save budgets</button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Transactions by category</h2>
        {summary.lines.map((l) => (
          <details key={l.id} id={`cat-${l.id}`} className="category">
            <summary>
              <span>{l.name}</span>
              <span className="muted small">
                {l.rows.length} {l.rows.length === 1 ? "transaction" : "transactions"} · {money(l.actual)}{" "}
                {l.id === "earnings" ? "received" : "spent"}
                {l.group === "excluded" && " · excluded from budget"}
              </span>
            </summary>
            {l.rows.length ? (
              <TxTable rows={l.rows} accountName={accountName} />
            ) : (
              <p className="muted small">Nothing this month.</p>
            )}
          </details>
        ))}
        <details className="category">
          <summary>
            <span>Not budgeted: transfers and card payments</span>
            <span className="muted small">
              {summary.transfers.length} {summary.transfers.length === 1 ? "transaction" : "transactions"}
            </span>
          </summary>
          {summary.transfers.length ? (
            <TxTable rows={summary.transfers} accountName={accountName} />
          ) : (
            <p className="muted small">Nothing this month.</p>
          )}
        </details>
      </section>

      <AmazonImport month={month} result={typeof params.amz === "string" ? params.amz : undefined} />

      <p className="footnote muted">
        {summary.trackingStart
          ? `Carryover is a running tally since ${monthLabel(summary.trackingStart)}, the first full month with history from every linked account: each month's unspent budget rolls forward, and overspending rolls forward as a deficit. `
          : "Carryover starts once transactions have synced. "}
        Excluded categories (such as Education) are tracked here but have no budget and don&apos;t
        count toward current spend or what&apos;s left to spend. Categories come from Plaid&apos;s
        category on each transaction; change any one with its
        dropdown, and your choice sticks through syncs and Amazon imports. Card purchases count as
        spending, so credit card payments and transfers between your own accounts are not budgeted.
        Refunds reduce their category&apos;s spending. Pending transactions are included. Activity
        inside investment accounts (buys, sells, dividends) is not part of budgets.
      </p>
    </main>
  );
}
