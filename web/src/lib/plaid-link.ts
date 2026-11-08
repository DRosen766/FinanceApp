// Loads Plaid Link's script at most once per page, on demand. React StrictMode mounts effects
// twice in dev, and react-plaid-link removed its still-loading <script> on the first unmount
// and added another on remount, so link-initialize.js ran twice. A module-level promise that
// never removes a loading tag can't do that.

export const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export type PlaidLinkMetadata = { institution: { name: string; institution_id: string } | null };

export type PlaidHandler = {
  open(): void;
  exit(options?: { force?: boolean }): void;
  destroy(): void;
};

export type PlaidLinkConfig = {
  token: string;
  onSuccess(publicToken: string, metadata: PlaidLinkMetadata): void;
  onExit(error: unknown, metadata: unknown): void;
};

export type PlaidGlobal = { create(config: PlaidLinkConfig): PlaidHandler };

type Env = {
  document: Pick<Document, "querySelector" | "createElement" | "head">;
  window: { Plaid?: PlaidGlobal };
};

let pending: Promise<PlaidGlobal> | null = null;

/** Resolve with `window.Plaid`, adding the script tag only if no tag exists yet. */
export function loadPlaidLink(env: Env = { document, window: window as Env["window"] }): Promise<PlaidGlobal> {
  if (env.window.Plaid) return Promise.resolve(env.window.Plaid);
  if (pending) return pending;
  pending = new Promise<PlaidGlobal>((resolve, reject) => {
    const existing = env.document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SRC}"]`);
    const el = existing ?? env.document.createElement("script");
    el.addEventListener("load", () => {
      if (env.window.Plaid) resolve(env.window.Plaid);
      else {
        pending = null;
        reject(new Error("Plaid Link loaded without initializing"));
      }
    });
    el.addEventListener("error", () => {
      // A failed tag is dead; drop it so a retry adds a fresh one.
      pending = null;
      el.remove();
      reject(new Error("Couldn't load Plaid Link"));
    });
    if (!existing) {
      el.src = PLAID_LINK_SRC;
      el.async = true;
      env.document.head.appendChild(el);
    }
  });
  return pending;
}

/** Test hook: forget the cached load. */
export function resetPlaidLinkLoader(): void {
  pending = null;
}
