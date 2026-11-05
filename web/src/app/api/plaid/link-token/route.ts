import { NextResponse } from "next/server";
import { createLinkToken, describePlaidError } from "@/server/plaid";
import { guardApiRequest } from "@/server/request-guard";

export async function POST(req: Request) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  try {
    return NextResponse.json({ linkToken: await createLinkToken() });
  } catch (err) {
    const info = describePlaidError(err);
    console.error("plaid link_token_create failed", info);
    return NextResponse.json({ error: info.errorCode }, { status: 502 });
  }
}
