import { money, percent, quantity, signClass, signedMoney } from "@/lib/format";
import { grandTotal, summarize, type AccountSummary, type Totals } from "@/lib/positions";
import { listItems } from "@/server/db";
import { describePlaidError, getHoldings } from "@/server/plaid";
import { requireSession } from "@/server/session";
import { LinkButton } from "../LinkButton";
import { Nav } from "../Nav";

// Plaid error codes meaning "this Item hasn't granted Investments / shared investment accounts".
// Both are fixed by re-opening Link in update mode for that Item.
const NEEDS_CONSENT = new Set(["ADDITIONAL_CONSENT_REQUIRED", "NO_INVESTMENT_ACCOUNTS"]);
// The institution doesn't offer Investments at all (e.g. a bank-only connection). Not an error:
// the connection just has nothing to show here.
const NOT_APPLICABLE = new Set(["PRODUCTS_NOT_SUPPORTED"]);

type InstitutionPositions = {
  itemId: number;
  name: string;
  summaries: AccountSummary[];
  error?: string;
};

async function loadPositions(): Promise<InstitutionPositions[]> {
  // Tokens are decrypted and used server-side only; only the internal row id and
  // narrowed holdings data reach the rendered page.
  return Promise.all(
    listItems().map(async (item): Promise<InstitutionPositions> => {
      const base = { itemId: item.id, name: item.institutionName ?? "Unknown institution" };
      try {
        const { accounts, holdings } = await getHoldings(item.accessToken);
        return { ...base, summaries: summarize(accounts, holdings) };
      } catch (err) {
        const info = describePlaidError(err);
        console.error("plaid investments_holdings_get failed", info);
        return { ...base, summaries: [], error: info.errorCode };
      }
    }),
  );
}

function TotalsLine({ totals, label }: { totals: Totals; label: string }) {
  return (
    <p className="totals">
      <span className="muted">{label}</span> <strong>{money(totals.value)}</strong>
      <span className={signClass(totals.gain)}>
        {" "}
        {signedMoney(totals.gain)} ({percent(totals.gainPct)})
      </span>
      {totals.partial && <span className="muted"> · gain excludes amounts without cost basis</span>}
    </p>
  );
}

function BalanceOnly({ summary, institution }: { summary: AccountSummary; institution: string }) {
  if (!summary.balanceOnly) return <p className="muted">No holdings.</p>;
  return (
    <p className="totals">
      <span className="muted">Balance</span> <strong>{money(summary.totals.value)}</strong>
      <span className="muted"> · {institution} doesn&apos;t report holdings for this account</span>
    </p>
  );
}

function InstitutionError({ inst }: { inst: InstitutionPositions }) {
  if (inst.error && NEEDS_CONSENT.has(inst.error)) {
    return (
      <div className="stack">
        <p className="muted">
          Positions aren&apos;t enabled for this connection yet. Grant Investments access and
          select your investment accounts.
        </p>
        <div>
          <LinkButton itemId={inst.itemId} label="Enable positions" />
        </div>
      </div>
    );
  }
  if (inst.error === "PRODUCT_NOT_READY") {
    return <p className="muted">Plaid is still loading holdings. Refresh in a minute.</p>;
  }
  return <p className="error">Could not load positions ({inst.error}).</p>;
}

export default async function PositionsPage() {
  await requireSession();
  const loaded = await loadPositions();
  const institutions = loaded.filter((i) => !(i.error && NOT_APPLICABLE.has(i.error)));
  const notApplicable = loaded.filter((i) => i.error && NOT_APPLICABLE.has(i.error));
  const all = institutions.flatMap((i) => i.summaries);
  const hasValue = all.some((s) => s.rows.length > 0 || s.balanceOnly);

  return (
    <main>
      <Nav current="positions" />
      <header className="row">
        <h1>Positions</h1>
      </header>

      {hasValue && <TotalsLine totals={grandTotal(all)} label="Total" />}
      {loaded.length === 0 && <p>No accounts linked yet.</p>}
      {loaded.length > 0 && institutions.length === 0 && <p>No investment accounts linked.</p>}

      {institutions.map((inst) => (
        <section key={inst.itemId} className="card">
          <h2>{inst.name}</h2>
          {inst.error ? (
            <InstitutionError inst={inst} />
          ) : inst.summaries.length === 0 ? (
            <p className="muted">No investment accounts on this connection.</p>
          ) : (
            inst.summaries.map(({ account, rows, totals, balanceOnly, unitemized }) => (
              <div key={account.id} className="account">
                <h3>
                  {account.name}
                  {account.mask && <span className="muted"> ••{account.mask}</span>}
                  {account.subtype && <span className="muted"> · {account.subtype}</span>}
                </h3>
                {rows.length === 0 ? (
                  <BalanceOnly
                    summary={{ account, rows, totals, balanceOnly, unitemized }}
                    institution={inst.name}
                  />
                ) : (
                  <>
                    <TotalsLine totals={totals} label="Account value" />
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Symbol</th>
                            <th>Name</th>
                            <th className="num">Quantity</th>
                            <th className="num">Price</th>
                            <th className="num">Value</th>
                            <th className="num">Cost basis</th>
                            <th className="num">Gain</th>
                            <th className="num">Gain %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={`${r.ticker ?? r.name}-${i}`}>
                              <td>
                                <strong>{r.ticker ?? "—"}</strong>
                              </td>
                              <td>{r.name}</td>
                              <td className="num">{quantity(r.quantity)}</td>
                              <td className="num">{money(r.price, r.currency)}</td>
                              <td className="num">{money(r.value, r.currency)}</td>
                              <td className="num">{money(r.costBasis, r.currency)}</td>
                              <td className={`num ${signClass(r.gain)}`}>
                                {signedMoney(r.gain, r.currency)}
                              </td>
                              <td className={`num ${signClass(r.gainPct)}`}>{percent(r.gainPct)}</td>
                            </tr>
                          ))}
                          {unitemized > 0 && (
                            <tr className="muted">
                              <td>—</td>
                              <td>Cash &amp; other (not itemized by {inst.name})</td>
                              <td className="num">—</td>
                              <td className="num">—</td>
                              <td className="num">{money(unitemized)}</td>
                              <td className="num">—</td>
                              <td className="num">—</td>
                              <td className="num">—</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </section>
      ))}

      {notApplicable.length > 0 && (
        <p className="muted footnote">
          Not shown (no investment accounts): {notApplicable.map((i) => i.name).join(", ")}
        </p>
      )}
    </main>
  );
}
