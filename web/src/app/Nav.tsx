import Link from "next/link";
import { logout } from "./login/actions";

export function Nav({ current }: { current: "accounts" | "positions" }) {
  return (
    <nav className="row nav">
      <div className="row">
        <Link href="/" aria-current={current === "accounts" ? "page" : undefined}>
          Accounts
        </Link>
        <Link href="/positions" aria-current={current === "positions" ? "page" : undefined}>
          Positions
        </Link>
      </div>
      <form action={logout}>
        <button type="submit" className="secondary">
          Sign out
        </button>
      </form>
    </nav>
  );
}
