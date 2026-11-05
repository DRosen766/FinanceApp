import { listItems } from "@/server/db";
import { describePlaidError, getAccounts, type Account } from "@/server/plaid";
import { requireSession } from "@/server/session";
import { logout } from "./login/actions";
import { LinkButton } from "./LinkButton";

type InstitutionView = {
  key: string;
  name: string;
  accounts: Account[];
  error?: string;
};

async function loadInstitutions(): Promise<InstitutionView[]> {
  // Access tokens are decrypted and used here, server-side only; only Account data is rendered.
  return Promise.all(
    listItems().map(async (item, i): Promise<InstitutionView> => {
      const base = { key: String(i), name: item.institutionName ?? "Unknown institution" };
      try {
        return { ...base, accounts: await getAccounts(item.accessToken) };
      } catch (err) {
        const info = describePlaidError(err);
        console.error("plaid accounts_get failed", info);
        return { ...base, accounts: [], error: info.errorCode };
      }
    }),
  );
}

function money(amount: number | null, currency: string | null) {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(
    amount,
  );
}

export default async function DashboardPage() {
  await requireSession();
  const institutions = await loadInstitutions();

  return (
    <main>
      <header className="row">
        <h1>Accounts</h1>
        <div className="row">
          <LinkButton />
          <form action={logout}>
            <button type="submit" className="secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {institutions.length === 0 && <p>No accounts linked yet.</p>}

      {institutions.map((inst) => (
        <section key={inst.key} className="card">
          <h2>{inst.name}</h2>
          {inst.error ? (
            <p className="error">Could not load accounts ({inst.error}).</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="num">Current</th>
                  <th className="num">Available</th>
                </tr>
              </thead>
              <tbody>
                {inst.accounts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.name}
                      {a.mask && <span className="muted"> ••{a.mask}</span>}
                    </td>
                    <td>{a.subtype ?? a.type}</td>
                    <td className="num">{money(a.balances.current, a.balances.currency)}</td>
                    <td className="num">{money(a.balances.available, a.balances.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}
