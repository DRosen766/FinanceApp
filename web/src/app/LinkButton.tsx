"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";

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

export function LinkButton() {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      try {
        await postJson("/api/plaid/exchange", {
          publicToken,
          institutionName: metadata.institution?.name ?? null,
        });
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLinkToken(null);
        setBusy(false);
      }
    },
    [router],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      setBusy(false);
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { linkToken } = await postJson("/api/plaid/link-token");
      setLinkToken(linkToken);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <button onClick={start} disabled={busy}>
        {busy ? "Opening Plaid…" : "Link account"}
      </button>
      {error && (
        <p role="alert" className="error">
          Linking failed: {error}
        </p>
      )}
    </div>
  );
}
