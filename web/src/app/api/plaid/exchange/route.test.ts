import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn<() => Promise<boolean>>(),
  exchangePublicToken: vi.fn(),
  saveItem: vi.fn(),
}));

vi.mock("@/server/session", () => ({ isAuthenticated: mocks.isAuthenticated }));
vi.mock("@/server/db", () => ({ saveItem: mocks.saveItem }));
vi.mock("@/server/plaid", () => ({
  exchangePublicToken: mocks.exchangePublicToken,
  describePlaidError: () => ({ errorCode: "X" }),
}));

import { POST } from "./route";

const ORIGIN = "http://127.0.0.1:3000";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/plaid/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const goodBody = { publicToken: "public-sandbox-abc", institutionName: "First Platypus Bank" };

describe("POST /api/plaid/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.exchangePublicToken.mockResolvedValue({
      accessToken: "access-sandbox-secret",
      itemId: "item-1",
    });
  });

  it("401s without a session", async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    const res = await POST(request(goodBody));
    expect(res.status).toBe(401);
    expect(mocks.exchangePublicToken).not.toHaveBeenCalled();
  });

  it("403s on a cross-site Origin", async () => {
    const res = await POST(request(goodBody, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("403s when Origin is missing", async () => {
    const req = request(goodBody);
    req.headers.delete("origin");
    expect((await POST(req)).status).toBe(403);
  });

  it("403s on Sec-Fetch-Site: cross-site", async () => {
    const res = await POST(request(goodBody, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  it("400s on a malformed body", async () => {
    const res = await POST(request({ publicToken: "access-sandbox-nope" }));
    expect(res.status).toBe(400);
  });

  it("stores the token and never returns it", async () => {
    const res = await POST(request(goodBody));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("access-");
    expect(text).not.toContain("item-1");
    expect(mocks.saveItem).toHaveBeenCalledWith(
      "item-1",
      "access-sandbox-secret",
      "First Platypus Bank",
    );
  });
});
