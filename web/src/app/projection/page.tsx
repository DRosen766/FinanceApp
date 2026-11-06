import Link from "next/link";
import { money, signedMoney } from "@/lib/format";
import {
  buildLines,
  HORIZONS,
  monthlyFlows,
  parseProjectionParams,
  presetWindow,
  project,
  projectionQuery,
  resolveWindow,
  totalLine,
  WINDOW_LABELS,
  WINDOWS,
  windowDays,
  type ProjAccount,
  type ProjectionParams,
  type ProjLine,
} from "@/lib/projection";
import { toCashRow, toInvestmentRow, type TxRow } from "@/lib/transactions";
import {
  accountIdsByPlaidId,
  listAccounts,
  listInvestmentTransactions,
  listItems,
  listTransactions,
} from "@/server/db";
import { describePlaidError, getAccounts } from "@/server/plaid";
import { requireSession } from "@/server/session";
import { syncAllItems } from "@/server/transactions-sync";
import { Nav } from "../Nav";
import { ProjectionChart, type ChartSeries } from "./ProjectionChart";

const MILESTONES = [3, 6, 12];

type Excluded = { institution: string; reason: string };

/** Live balances for every account, joined to internal ids server-side. */
async function loadAccounts(): Promise<{ accounts: ProjAccount[]; excluded: Excluded[] }> {
  const idByPlaid = accountIdsByPlaidId();
  const excluded: Excluded[] = [];
  const perItem = await Promise.all(
    listItems().map(async (item) => {
      const institution = item.institutionName ?? "Unknown institution";
      try {
        const live = await getAccounts(item.accessToken);
        return live.flatMap((a, i): ProjAccount[] => {
          if (a.balances.current === null) {
            excluded.push({ institution, reason: `${a.name}: no current balance reported` });
            return [];
          }
          const accountId = idByPlaid.get(a.id) ?? null;
          return [
            {
              key: accountId !== null ? String(accountId) : `x${item.id}-${i}`,
              accountId,
              itemId: item.id,
              institution,
              name: a.name,
              mask: a.mask,
              type: a.type,
              subtype: a.subtype,
              balance: a.balances.current,
              currency: a.balances.currency,
            },
          ];
        });
      } catch (err) {
        const info = describePlaidError(err);
        console.error("plaid accounts_get failed", info);
        excluded.push({ institution, reason: `balances unavailable (${info.errorCode})` });
        return [];
      }
    }),
  );
  return { accounts: perItem.flat(), excluded };
}

/** Earliest stored transaction date per account's link: where its history begins. */
function historyStarts(rows: TxRow[]): Map<number, string> {
  const itemOf = new Map(listAccounts().map((a) => [a.id, a.itemId]));
  const firstByItem = new Map<number, string>();
  for (const r of rows) {
    const item = itemOf.get(r.accountId);
    if (item === undefined) continue;
    const cur = firstByItem.get(item);
    if (!cur || r.date < cur) firstByItem.set(item, r.date);
  }
  const out = new Map<number, string>();
  for (const [accountId, item] of itemOf) {
    const first = firstByItem.get(item);
    if (first) out.set(accountId, first);
  }
  return out;
}

function formatDay(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Picker({ lines, params, today }: { lines: ProjLine[]; params: ProjectionParams; today: Date }) {
  // Pre-fill the date inputs with the current window so switching to Custom starts from it.
  const current = resolveWindow(params, today);
  const todayIso = presetWindow(1, today).to;
  return (
    <form method="get" action="/projection" className="filters">
      <label className="grow">
        Account
        <select name="account" defaultValue={params.account}>
          <option value="total">Total only</option>
          {lines.map((l) => (
            <option key={l.key} value={l.key}>
              {l.institution ? `${l.institution} · ` : ""}
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Horizon
        <select name="h" defaultValue={params.h}>
          {HORIZONS.map((y) => (
            <option key={y} value={y}>
              {y} {y === "1" ? "year" : "years"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Average over
        <select name="w" defaultValue={params.w}>
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              {WINDOW_LABELS[w]}
            </option>
          ))}
        </select>
      </label>
      <label title="Used when Average over is Custom range">
        From (custom)
        <input type="date" name="from" defaultValue={current.from} max={todayIso} />
      </label>
      <label title="Used when Average over is Custom range">
        To (custom)
        <input type="date" name="to" defaultValue={current.to} max={todayIso} />
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}

export default async function ProjectionPage({ searchParams }: PageProps<"/projection">) {
  await requireSession();
  const today = new Date();
  const params = parseProjectionParams(await searchParams, today);
  const avgWindow = resolveWindow(params, today);
  await syncAllItems();

  const months = Number(params.h) * 12;
  const { accounts, excluded } = await loadAccounts();
  const rows: TxRow[] = [
    ...listTransactions().map(toCashRow),
    ...listInvestmentTransactions().map(toInvestmentRow),
  ];
  const accountIds = accounts.flatMap((a) => (a.accountId !== null ? [a.accountId] : []));
  const flows = monthlyFlows(rows, avgWindow, historyStarts(rows), accountIds);
  const lines = buildLines(accounts, flows);
  const total = totalLine(lines);
  const selected = lines.find((l) => l.key === params.account);

  // Color follows the entity: the selected account is always slot 1, Total always slot 2.
  const series: ChartSeries[] = [
    ...(selected ? [{ key: selected.key, label: selected.label, values: project(selected.value, selected.flow.net, months), slot: 1 as const }] : []),
    { key: "total", label: "Total", values: project(total.value, total.flow.net, months), slot: 2 },
  ];
  const columns = [...MILESTONES.filter((m) => m < months), months];

  const row = (l: ProjLine, isTotal = false) => {
    const points = project(l.value, l.flow.net, months);
    return (
      <tr key={l.key} className={isTotal ? "total-row" : undefined}>
        <td>
          {isTotal ? (
            <strong>Total</strong>
          ) : (
            <>
              <Link href={`/projection${projectionQuery(params, { account: l.key })}`}>{l.label}</Link>
              {l.flow.limited && (
                <span className="badge" title={`Average based on ${l.flow.days} days of history`}>
                  Limited history
                </span>
              )}
              <div className="muted small">{l.institution}</div>
            </>
          )}
        </td>
        <td className="num nowrap">{money(l.value, l.currency)}</td>
        <td className="num nowrap gain">{money(l.flow.in, l.currency)}</td>
        <td className="num nowrap">{money(l.flow.out, l.currency)}</td>
        <td className={`num nowrap ${l.flow.net > 0 ? "gain" : l.flow.net < 0 ? "loss" : ""}`}>
          {signedMoney(l.flow.net, l.currency)}
        </td>
        {columns.map((m) => (
          <td key={m} className="num nowrap">
            {money(points[m], l.currency)}
          </td>
        ))}
      </tr>
    );
  };

  return (
    <main>
      <Nav current="projection" />
      <header className="row">
        <h1>Projection</h1>
      </header>

      {params.invalidRange && (
        <p className="error">
          That custom range isn&apos;t valid (it needs a start on or before the end, and no future
          dates). Showing the last 3 months instead.
        </p>
      )}

      {excluded.length > 0 && (
        <div className="stack">
          {excluded.map((e, i) => (
            <p key={i} className="error">
              {e.institution}: {e.reason}. Not included in the projection.
            </p>
          ))}
        </div>
      )}

      {lines.length === 0 ? (
        <p>No accounts linked yet.</p>
      ) : (
        <>
          <section className="card">
            <Picker lines={lines} params={{ ...params, account: selected ? selected.key : "total" }} today={today} />
            <p className="muted small">
              Averaging {formatDay(avgWindow.from)} – {formatDay(avgWindow.to)} ({windowDays(avgWindow)} days)
            </p>
            <p className="totals">
              <span className="muted">Total today</span> {money(total.value)}
              {" · "}
              <span className={total.flow.net >= 0 ? "gain" : "loss"}>
                {signedMoney(total.flow.net)} / month
              </span>
              {" · "}
              <span className="muted">in {months} months</span> {money(total.value + total.flow.net * months)}
            </p>
            <ProjectionChart series={series} months={months} today={today} />
          </section>

          <section className="card">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Today</th>
                    <th className="num">In / mo</th>
                    <th className="num">Out / mo</th>
                    <th className="num">Net / mo</th>
                    {columns.map((m) => (
                      <th key={m} className="num nowrap">
                        {m % 12 === 0 ? `${m / 12} yr` : `${m} mo`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => row(l))}
                  {row(total, true)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <p className="footnote muted">
        Monthly averages use posted deposits, withdrawals, spending and fees in the chosen range. Market
        returns, dividends, interest, capital gains, buys and sells are excluded, so investment accounts
        only change by what you put in or take out. Credit cards and loans aren&apos;t projected on their
        own: their balances are paid from checking, so they show up as payments in checking&apos;s money
        out. If those payments include paying down an older balance, the projection keeps subtracting
        them every month. Transfers between your own accounts cancel out in the total.
      </p>
    </main>
  );
}
