import type { SessionOptions } from "iron-session";

// Shared by proxy.ts and server code, so it can't import "server-only". It holds no secret
// values at module scope; SESSION_SECRET is read at call time and is never inlined into
// client bundles (it has no NEXT_PUBLIC_ prefix).

export type SessionData = { loggedIn?: boolean };

export const SESSION_COOKIE = "fa_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return {
    cookieName: SESSION_COOKIE,
    password,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  };
}
