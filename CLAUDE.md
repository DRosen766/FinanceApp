# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

FinanceApp is a personal finance tracker that pulls data from the owner's bank accounts via the **Plaid API**. It is planned as several components sharing one backend data source:

1. **MCP server**: gives the owner's AI agents **read-only** access to financial data (accounts, balances, transactions).
2. **Web dashboard**: runs locally first, then moves to a remote deployment.
3. **iOS app**: later.

Current state: `web/` holds a local proof-of-concept dashboard (Next.js 16, App Router, TypeScript) that links accounts through Plaid Link and shows accounts and balances. `mcp/` and `ios/` don't exist yet.

## Commands (run from `web/`, Node 22 or later)

```bash
npm install
cp .env.example .env.local      # then fill in values; generation commands are inside
npm run hash-password           # prints DASHBOARD_PASSWORD_HASH (base64 argon2id)
npm run dev                     # http://127.0.0.1:3000 (bound to loopback only)
npm run lint && npm run typecheck && npm test && npm run build
npx vitest run src/server/crypto.test.ts        # single test file
npx vitest run -t "AAD mismatch"                # single test by name
```

Next.js 16 differs from older versions: middleware is now `src/proxy.ts`, for example. Read the docs in `web/node_modules/next/dist/docs/` before using a Next API you aren't sure of (see `web/AGENTS.md`).

## Architecture (`web/`)

- **`src/server/`** holds everything that touches secrets, and every file starts with `import "server-only"`. Client Components must never import from it.
  - `plaid.ts` is the **only** place the Plaid client exists, and it is never exported. Each exported function wraps one allowed endpoint. `plaid.test.ts` asserts the exact export list, so adding an endpoint deliberately fails that test and forces a security review. Log Plaid failures only through `describePlaidError()`, because raw axios errors contain the `PLAID-SECRET` header and the access token.
  - `db.ts` is the SQLite store (`web/data/finance.db`, gitignored, file mode 0600). The `items` table holds AES-256-GCM-encrypted access tokens from `crypto.ts`. The Plaid `item_id` is used as additional authenticated data (AAD), so a token's ciphertext only decrypts on its own row. Account data is fetched live, never stored. The future MCP server will read this same store.
  - `env.ts` validates environment variables lazily with zod. Error messages name the variable, never its value.
- **Auth uses two layers:**
  - `src/proxy.ts` makes an optimistic check: it unseals the iron-session cookie and redirects to `/login`, or returns 401 for `/api/*`.
  - Pages call `requireSession()`, and API routes call `guardApiRequest()`, which also enforces a same-origin `Origin` and `Sec-Fetch-Site` check (CSRF).
  - Login is a server action (`app/login/actions.ts`) that checks the password with argon2 and an in-memory throttle.
- **CSP:** `proxy.ts` sets a CSP with a fresh nonce on every request, allowing `cdn.plaid.com` for Link. Pages must render per request for the nonce to reach Next's scripts, so a page that would otherwise be static calls `await connection()`. Static security headers and `Cache-Control: no-store` live in `next.config.ts`. Cache Components is deliberately left off.
- **Link flow:**
  1. `LinkButton` calls `POST /api/plaid/link-token` and opens Plaid Link.
  2. Link returns a `public_token`, which goes to `POST /api/plaid/exchange`.
  3. The server exchanges it and stores the encrypted access token, then returns `{ok:true}`.
  4. The dashboard (`app/page.tsx`, a server component) decrypts the tokens and calls `/accounts/get`.

## Git workflow (required)

- **Never commit or push directly to `main`.** Every change goes through a PR.
- For each new feature, create a **git worktree as a sibling of the main checkout** (`/Users/dannyrosen/FinanceApp_parent/FinanceApp`), and **pull the latest `main` first**:
  ```bash
  cd /Users/dannyrosen/FinanceApp_parent/FinanceApp
  git checkout main && git pull --ff-only origin main
  git worktree add ../FinanceApp-<feature> -b <feature-branch> main
  cd ../FinanceApp-<feature>
  ```
- Open the PR with `gh pr create --base main --reviewer DRosen766`.
- After merge, clean up with `git worktree remove ../FinanceApp-<feature>` and delete the branch.

## Security (top priority)

Security takes precedence over convenience, speed, and features. When a design choice trades security for something else, choose the secure option, or stop and ask.

Invariants every component must preserve:

- **The MCP server is strictly read-only.** It must never expose Plaid endpoints that move money or change state, such as Transfer, Payment Initiation, or item removal or updates. Enforce this in code with an allowlist of Plaid calls. A tool description saying "read-only" does not count.
- **Plaid `access_token`s stay on the backend.** Never return them to the MCP clients, the dashboard frontend, the iOS app, or logs. Encrypt them at rest.
- **Minimize what leaves the backend.** Don't return full account or routing numbers or raw Plaid payloads through the MCP server or UI unless a feature explicitly requires it.
- **Authenticate every surface.** The MCP server and the dashboard need authentication even when they run on localhost. Remote deployment must not weaken that.
- **Use the Plaid Sandbox environment for development and tests.** Never put real financial data in fixtures, test snapshots, or commits.
