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
    - Allowed endpoints today: `/link/token/create`, `/item/public_token/exchange`, `/accounts/get`, `/investments/holdings/get`, `/investments/transactions/get` and `/transactions/sync`.
    - Narrow Plaid responses down to the fields the app uses. `syncTransactions` deliberately drops `location`, `payment_meta`, `original_description`, `counterparties` and `account_owner`. `getInvestmentTransactions` keeps only the ticker and name of each security and drops `cancel_transaction_id` and `transaction_datetime`.
  - `db.ts` is the SQLite store (`web/data/finance.db`, gitignored, file mode 0600). It's the store the future MCP server will read. Everything sensitive is AES-256-GCM-encrypted with `crypto.ts`, with an additional authenticated data (AAD) value per row:

    | Table | Encrypted column (AAD) | Readable columns |
    |---|---|---|
    | `items` | `access_token_enc` (`plaid_item_id`) | ids, `institution_name`, `tx_cursor`/`tx_status`/`tx_synced_at`, `inv_synced_at`/`inv_backfilled_at`/`inv_status` |
    | `accounts` | `data_enc`: name, mask, type, subtype (`acct:<plaid_account_id>`) | ids |
    | `transactions` | `data_enc`: name, merchant, amount, category… (`tx:<plaid_transaction_id>`) | ids, `date`, `pending` |
    | `investment_transactions` | `data_enc`: name, type, ticker, quantity, price, amount, fees (`itx:<plaid id>`) | ids, `date` |

    - Balances and holdings are fetched live and never stored. Cash and investment transactions are stored.
    - **Migrations:** the `MIGRATIONS` array, keyed on `PRAGMA user_version`. It's append-only: every schema change is a new step, and a shipped step is never edited. Each step runs in a transaction together with the version bump.
    - `applyTransactionSync()` writes accounts, added, modified and removed transactions, and the new cursor in **one** transaction, so the cursor can never get out of step with the stored data.
    - The browser only ever sees internal row `id`s (items, accounts, transactions), never Plaid ids or tokens.
    - The default DB path is built from runtime values (`defaultDbPath()`) so Turbopack's file tracing can't pull the live database into the build output. Don't turn it back into a literal `path.join(process.cwd(), "data", ...)`.
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
  - New links request `products: [transactions]` with `optional_products: [investments]`.
  - **Update mode:** `<LinkButton itemId={id}>` sends `{itemId}` to `/api/plaid/link-token`. The server creates an update-mode token with `additional_consented_products: [investments]` and account selection turned on, which adds permission to an existing link. The access token doesn't change, so update mode skips `/exchange`.
- **Positions** (`app/positions/page.tsx`) calls `/investments/holdings/get` for each item, and `src/lib/positions.ts` does the gain and total math as pure functions. Error codes `ADDITIONAL_CONSENT_REQUIRED` and `NO_INVESTMENT_ACCOUNTS` render an "Enable positions" button that opens update mode.
- **Transactions** (`app/transactions/page.tsx`):
  - `server/transactions-sync.ts` → `syncAllItems()` runs on page load. It skips items synced within the last 5 minutes and shares one in-flight sync per item. "Refresh now" (a server action) forces a sync.
  - `syncTransactions()` pages until `has_more` is false. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` it restarts from the **original** cursor, as Plaid requires.
  - Don't call `/transactions/refresh`, which is billed separately.
  - Filters arrive as `GET` query params, parsed with zod in `src/lib/transactions.ts`; bad values fall back to defaults field by field. Filtering happens in memory after decrypting.
  - Plaid's sign convention: a positive `amount` is money **out**.
  - New links request `transactions.days_requested: 730`. Existing links keep the history they were created with.
  - **Investment activity** comes from `/investments/transactions/get`, which has no cursor and no "removed" list:
    - The first fetch backfills 730 days; later fetches cover the last 30. `applyInvestmentSync()` deletes the item's stored rows inside the fetched window and inserts what Plaid returned, in one transaction. That is how cancelled or corrected rows disappear.
    - Cash and investment syncs run independently per item, so one failing never blocks the other. Each has its own 5-minute throttle.
    - Every investments failure is stored in `items.inv_status`, which also stamps `inv_synced_at`, so failures are retried at most every 5 minutes and stay visible meanwhile. `PRODUCTS_NOT_SUPPORTED` and `NO_INVESTMENT_ACCOUNTS` are quiet: not shown, and not retried until a forced refresh.
  - **Totals:** In/Out and the money in/out filter count only rows where `countsAsCash` is true: every cash transaction, plus investment rows of type `cash` (contributions, withdrawals, dividends, interest) or `fee`. Buys, sells, cancels and in-kind transfers are listed but not counted.
  - Cash and investment row ids come from different tables, so React keys and sort tie-breaks use `kind` as well as `id` (`rowKey()`).

## Testing gotchas

- `beforeEach(() => mock.mockReset())` *returns* the mock, and Vitest runs a function returned from `beforeEach` as a cleanup hook, which calls your mock after every test. Always use braces: `beforeEach(() => { ... })`.
- `server-only` is aliased to an empty module in `vitest.config.mts`. To test `db.ts`, set `DATABASE_PATH` to a temporary file and call `vi.resetModules()` before importing it (see `db.test.ts`).
- To mock the Plaid client, `vi.mock("plaid")` with a `PlaidApi` **class** whose constructor returns the fake (see `plaid.test.ts`). `vi.fn(() => fake)` can't be called with `new`.

## Worktree dev setup

A new worktree has no `.env.local` or database. Symlink the main checkout's copies rather than copying the secrets:
```bash
cd ../FinanceApp-<feature>/web && npm ci
ln -s ../../FinanceApp/web/.env.local .env.local && ln -s ../../FinanceApp/web/data data
```
`web/.gitignore` uses `/data` with no trailing slash, so the symlink is ignored too.

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
