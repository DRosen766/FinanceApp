import { NextResponse } from "next/server";
import { z } from "zod";
import { saveItem } from "@/server/db";
import { describePlaidError, exchangePublicToken } from "@/server/plaid";
import { guardApiRequest } from "@/server/request-guard";

const bodySchema = z.object({
  publicToken: z.string().startsWith("public-").max(256),
  institutionName: z.string().trim().max(120).nullable().optional(),
});

export async function POST(req: Request) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const { accessToken, itemId } = await exchangePublicToken(parsed.data.publicToken);
    saveItem(itemId, accessToken, parsed.data.institutionName ?? null);
    // Never echo the access token or item id back to the browser.
    return NextResponse.json({ ok: true });
  } catch (err) {
    const info = describePlaidError(err);
    console.error("plaid item_public_token_exchange failed", info);
    return NextResponse.json({ error: info.errorCode }, { status: 502 });
  }
}
