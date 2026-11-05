import "server-only";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionOptions, type SessionData } from "@/lib/session-config";

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getSession()).loggedIn === true;
}

/** For pages and server actions. Defense in depth on top of proxy.ts. */
export async function requireSession(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}
