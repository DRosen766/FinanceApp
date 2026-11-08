"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { loadPlaidLink, type PlaidHandler } from "@/lib/plaid-link";

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * Without `itemId`: links a new institution (public_token → /api/plaid/exchange).
 * With `itemId`: Plaid Link update mode for that Item (adds consent/accounts). The access
 * token is unchanged, so there is nothing to exchange; just re-render.
 *
 * Plaid's script loads on the first click (once per page, see lib/plaid-link.ts), not on
 * every page view.
 */
export function LinkButton({ itemId, label = "Link account" }: { itemId?: number; label?: string }) {
  const router = useRouter();
  const handler = useRef<PlaidHandler | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tear down an open Link iframe if the button unmounts (e.g. navigation).
  useEffect(
    () => () => {
      handler.current?.destroy();
      handler.current = null;
    },
    [],
  );

  const finish = () => {
    handler.current?.destroy();
    handler.current = null;
    setBusy(false);
  };

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const [{ linkToken }, Plaid] = await Promise.all([
        postJson("/api/plaid/link-token", itemId === undefined ? undefined : { itemId }),
        loadPlaidLink(),
      ]);
      handler.current?.destroy();
      handler.current = Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          try {
            if (itemId === undefined) {
              await postJson("/api/plaid/exchange", {
                publicToken,
                institutionName: metadata.institution?.name ?? null,
              });
            }
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            finish();
          }
        },
        onExit: finish,
      });
      handler.current.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <button onClick={start} disabled={busy}>
        {busy ? "Opening Plaid…" : label}
      </button>
      {error && (
        <p role="alert" className="error">
          Linking failed: {error}
        </p>
      )}
    </div>
  );
}
