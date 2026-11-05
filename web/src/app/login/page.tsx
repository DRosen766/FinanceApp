import { connection } from "next/server";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  // Render per request so Next.js can attach the CSP nonce from proxy.ts to its scripts.
  await connection();
  return (
    <main className="narrow">
      <h1>FinanceApp</h1>
      <LoginForm />
    </main>
  );
}
