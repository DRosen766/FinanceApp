import { describe, expect, it } from "vitest";
import * as plaid from "./plaid";

describe("plaid read-only allowlist", () => {
  it("exports only the approved functions (and never the raw client)", () => {
    // Adding to this list is a security review event: only read-only endpoints are allowed.
    expect(Object.keys(plaid).sort()).toEqual(
      ["createLinkToken", "describePlaidError", "exchangePublicToken", "getAccounts"].sort(),
    );
  });

  it("describePlaidError extracts only the error code and request id", () => {
    const axiosLike = {
      config: { headers: { "PLAID-SECRET": "super-secret" }, data: '{"access_token":"access-x"}' },
      response: { data: { error_code: "ITEM_LOGIN_REQUIRED", request_id: "req-1", extra: "x" } },
    };
    const info = plaid.describePlaidError(axiosLike);
    expect(info).toEqual({ errorCode: "ITEM_LOGIN_REQUIRED", requestId: "req-1" });
    expect(JSON.stringify(info)).not.toMatch(/super-secret|access-x/);
  });
});
