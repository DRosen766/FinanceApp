"use server";

import { verify } from "@node-rs/argon2";
import { redirect } from "next/navigation";
import { env } from "@/server/env";
import { loginLockedFor, recordLoginFailure, recordLoginSuccess } from "@/server/rate-limit";
import { getSession } from "@/server/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const locked = loginLockedFor();
  if (locked > 0) {
    return { error: `Too many attempts. Try again in ${Math.ceil(locked / 60000)} min.` };
  }

  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) {
    return { error: "Invalid password." };
  }

  const hash = Buffer.from(env().DASHBOARD_PASSWORD_HASH, "base64").toString("utf8");
  let ok = false;
  try {
    ok = await verify(hash, password);
  } catch {
    ok = false;
  }

  if (!ok) {
    recordLoginFailure();
    return { error: "Invalid password." };
  }

  recordLoginSuccess();
  const session = await getSession();
  session.loggedIn = true;
  await session.save();
  redirect("/");
}

export async function logout(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect("/login");
}
