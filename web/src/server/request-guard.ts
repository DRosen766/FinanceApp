import "server-only";
import { NextResponse } from "next/server";
import { isAuthenticated } from "./session";

/**
 * Same-origin check for state-changing API routes (CSRF defense alongside the SameSite=strict
 * session cookie). Requires an Origin header that matches the request's own host.
 */
export function isSameOrigin(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  return origin === `${new URL(req.url).protocol}//${host}`;
}

/** Returns an error response if the request must be rejected, otherwise null. */
export async function guardApiRequest(req: Request): Promise<NextResponse | null> {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
