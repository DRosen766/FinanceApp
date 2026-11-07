import Link from "next/link";
import { logout } from "./login/actions";

const LINKS = [
  { key: "accounts", href: "/", label: "Accounts" },
  { key: "positions", href: "/positions", label: "Positions" },
  { key: "transactions", href: "/transactions", label: "Transactions" },
  { key: "budgets", href: "/budgets", label: "Budgets" },
  { key: "projection", href: "/projection", label: "Projection" },
] as const;

export function Nav({ current }: { current: (typeof LINKS)[number]["key"] }) {
  return (
    <nav className="row nav">
      <div className="row">
        {LINKS.map((l) => (
          <Link key={l.key} href={l.href} aria-current={current === l.key ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </div>
      <form action={logout}>
        <button type="submit" className="secondary">
          Sign out
        </button>
      </form>
    </nav>
  );
}
