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

export async function createLinkToken(): Promise<string> {
  const res = await plaid().linkTokenCreate({
    user: { client_user_id: CLIENT_USER_ID },
    client_name: "FinanceApp",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  });
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

/**
 * Loggable summary of a Plaid/axios error. Never log the raw error: axios errors carry the
 * request config, which includes the PLAID-SECRET header and the access_token in the body.
 */
export function describePlaidError(err: unknown): { errorCode: string; requestId?: string } {
  const data = (err as { response?: { data?: { error_code?: string; request_id?: string } } })
    ?.response?.data;
  return { errorCode: data?.error_code ?? "UNKNOWN_ERROR", requestId: data?.request_id };
}
