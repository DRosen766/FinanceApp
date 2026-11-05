import "server-only";
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid";
import { env } from "./env";

/*
 * READ-ONLY ALLOWLIST. This module is the only place the Plaid client exists, and it is
 * never exported. Each exported function wraps exactly one read-only (or Link-setup) endpoint.
 * Never add endpoints that move money or mutate Items (transfer, payment_initiation,
 * item/remove, processor tokens, ...). plaid.test.ts enforces the export list.
 */

let client: PlaidApi | undefined;

function plaid(): PlaidApi {
  if (!client) {
    const e = env();
    client = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[e.PLAID_ENV],
        baseOptions: {
          headers: { "PLAID-CLIENT-ID": e.PLAID_CLIENT_ID, "PLAID-SECRET": e.PLAID_SECRET },
        },
      }),
    );
  }
  return client;
}

// Single-user app: one stable, non-identifying user id.
const CLIENT_USER_ID = "financeapp-owner";

/**
 * New link: Transactions, plus Investments where the institution supports it.
 * Update mode (accessToken given): re-opens Link for an existing Item to grant Investments
 * consent and let the user add accounts; the access token itself does not change.
 */
export async function createLinkToken(opts: { accessToken?: string } = {}): Promise<string> {
  const base = {
    user: { client_user_id: CLIENT_USER_ID },
    client_name: "FinanceApp",
    country_codes: [CountryCode.Us],
    language: "en",
  };
  const res = await plaid().linkTokenCreate(
    opts.accessToken
      ? {
          ...base,
          access_token: opts.accessToken,
          additional_consented_products: [Products.Investments],
          update: { account_selection_enabled: true },
        }
      : {
          ...base,
          products: [Products.Transactions],
          optional_products: [Products.Investments],
          // Max history; only applies when an Item is created (existing Items keep theirs).
          transactions: { days_requested: 730 },
        },
  );
  return res.data.link_token;
}

export async function exchangePublicToken(
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const res = await plaid().itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: res.data.access_token, itemId: res.data.item_id };
}

export type Account = {
  id: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    available: number | null;
    current: number | null;
    limit: number | null;
    currency: string | null;
  };
};

/** Uses /accounts/get (cached balances), not the per-call-billed /accounts/balance/get. */
export async function getAccounts(accessToken: string): Promise<Account[]> {
  const res = await plaid().accountsGet({ access_token: accessToken });
  return res.data.accounts.map((a) => ({
    id: a.account_id,
    name: a.name,
    officialName: a.official_name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype ?? null,
    balances: {
      available: a.balances.available,
      current: a.balances.current,
      limit: a.balances.limit,
      currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code,
    },
  }));
}

export type InvestmentAccount = {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
  balance: number | null;
};

export type Holding = {
  accountId: string;
  ticker: string | null;
  name: string;
  securityType: string | null;
  isCash: boolean;
  quantity: number;
  price: number;
  priceAsOf: string | null;
  value: number;
  costBasis: number | null;
  currency: string | null;
};

/** Wraps /investments/holdings/get (read-only). Returns a narrowed, joined shape. */
export async function getHoldings(
  accessToken: string,
): Promise<{ accounts: InvestmentAccount[]; holdings: Holding[] }> {
  const res = await plaid().investmentsHoldingsGet({ access_token: accessToken });
  const securities = new Map(res.data.securities.map((s) => [s.security_id, s]));
  const holdingAccountIds = new Set(res.data.holdings.map((h) => h.account_id));
  return {
    accounts: res.data.accounts
      .filter((a) => a.type === "investment" || holdingAccountIds.has(a.account_id))
      .map((a) => ({
        id: a.account_id,
        name: a.name,
        mask: a.mask,
        subtype: a.subtype ?? null,
        balance: a.balances.current,
      })),
    holdings: res.data.holdings.map((h) => {
      const s = securities.get(h.security_id);
      return {
        accountId: h.account_id,
        ticker: s?.ticker_symbol ?? null,
        name: s?.name ?? "Unknown security",
        securityType: s?.type ?? null,
        isCash: s?.is_cash_equivalent === true,
        quantity: h.quantity,
        price: h.institution_price,
        priceAsOf: h.institution_price_as_of ?? null,
        value: h.institution_value,
        costBasis: h.cost_basis,
        currency: h.iso_currency_code ?? h.unofficial_currency_code,
      };
    }),
  };
}

export type SyncedAccount = {
  plaidAccountId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
};

export type SyncedTransaction = {
  plaidTransactionId: string;
  plaidAccountId: string;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  /** Plaid convention: positive = money out of the account, negative = money in. */
  amount: number;
  currency: string | null;
  pending: boolean;
  category: string | null;
  categoryDetailed: string | null;
  paymentChannel: string | null;
};

export type TransactionSyncResult = {
  added: SyncedTransaction[];
  modified: SyncedTransaction[];
  removed: string[];
  accounts: SyncedAccount[];
  nextCursor: string;
  status: string;
};

const SYNC_PAGE_SIZE = 500;
const SYNC_MAX_RESTARTS = 3;

type PlaidTransaction = Awaited<ReturnType<PlaidApi["transactionsSync"]>>["data"]["added"][number];

// Narrowing is deliberate: location, payment_meta, original_description, counterparties and
// account_owner are dropped so they are never stored or rendered.
function narrowTransaction(t: PlaidTransaction): SyncedTransaction {
  return {
    plaidTransactionId: t.transaction_id,
    plaidAccountId: t.account_id,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    name: t.name,
    merchantName: t.merchant_name ?? null,
    amount: t.amount,
    currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
    pending: t.pending,
    category: t.personal_finance_category?.primary ?? null,
    categoryDetailed: t.personal_finance_category?.detailed ?? null,
    paymentChannel: t.payment_channel ?? null,
  };
}

/**
 * Wraps /transactions/sync (read-only). Pages until has_more is false. Per Plaid's docs, if
 * TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION occurs, the whole loop restarts from the
 * cursor it began with (not from the page that failed).
 */
export async function syncTransactions(
  accessToken: string,
  cursor: string | null,
): Promise<TransactionSyncResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out: TransactionSyncResult = {
        added: [],
        modified: [],
        removed: [],
        accounts: [],
        nextCursor: cursor ?? "",
        status: "",
      };
      let pageCursor = cursor ?? undefined;
      for (;;) {
        const res = await plaid().transactionsSync({
          access_token: accessToken,
          cursor: pageCursor,
          count: SYNC_PAGE_SIZE,
        });
        const d = res.data;
        out.added.push(...d.added.map(narrowTransaction));
        out.modified.push(...d.modified.map(narrowTransaction));
        out.removed.push(...d.removed.map((r) => r.transaction_id));
        out.accounts = d.accounts.map((a) => ({
          plaidAccountId: a.account_id,
          name: a.name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype ?? null,
        }));
        out.nextCursor = d.next_cursor;
        out.status = d.transactions_update_status;
        if (!d.has_more) return out;
        pageCursor = d.next_cursor;
      }
    } catch (err) {
      const mutated =
        describePlaidError(err).errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
      if (!mutated || attempt >= SYNC_MAX_RESTARTS) throw err;
    }
  }
}

/**
 * Loggable summary of a Plaid/axios error. Never log the raw error: axios errors carry the
 * request config, which includes the PLAID-SECRET header and the access_token in the body.
 */
export function describePlaidError(err: unknown): { errorCode: string; requestId?: string } {
  const data = (err as { response?: { data?: { error_code?: string; request_id?: string } } })
    ?.response?.data;
  return { errorCode: data?.error_code ?? "UNKNOWN_ERROR", requestId: data?.request_id };
}
