import { unsealData } from "iron-session";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionOptions, type SessionData } from "@/lib/session-config";

const PUBLIC_PATHS = new Set(["/login"]);

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonced Next.js bundle load Plaid Link's script; the explicit
    // URL is the fallback for browsers without strict-dynamic support.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://cdn.plaid.com/link/v2/stable/link-initialize.js${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' https://*.plaid.com${isDev ? " ws:" : ""}`,
    "frame-src https://cdn.plaid.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function isLoggedIn(req: NextRequest): Promise<boolean> {
  const sealed = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sealed) return false;
  try {
    const { password, ttl } = sessionOptions();
    const data = await unsealData<SessionData>(sealed, { password, ttl });
    return data.loggedIn === true;
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Optimistic auth gate. Pages and API routes re-check the session themselves.
  if (!PUBLIC_PATHS.has(pathname) && !(await isLoggedIn(req))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
