import { NextResponse } from "next/server";
import { z } from "zod";
import { getItem } from "@/server/db";
import { createLinkToken, describePlaidError } from "@/server/plaid";
import { guardApiRequest } from "@/server/request-guard";

// Empty body = new link. { itemId } = update mode for an existing Item (internal row id).
const bodySchema = z.object({ itemId: z.number().int().positive().optional() }).strict();

export async function POST(req: Request) {
  const denied = await guardApiRequest(req);
  if (denied) return denied;

  const text = await req.text();
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let accessToken: string | undefined;
  if (parsed.data.itemId !== undefined) {
    const item = getItem(parsed.data.itemId);
    if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
    accessToken = item.accessToken;
  }

  try {
    return NextResponse.json({ linkToken: await createLinkToken({ accessToken }) });
  } catch (err) {
    const info = describePlaidError(err);
    console.error("plaid link_token_create failed", info);
    return NextResponse.json({ error: info.errorCode }, { status: 502 });
  }
}
