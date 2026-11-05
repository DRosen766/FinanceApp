import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn<() => Promise<boolean>>(),
  createLinkToken: vi.fn(),
  getItem: vi.fn(),
}));

vi.mock("@/server/session", () => ({ isAuthenticated: mocks.isAuthenticated }));
vi.mock("@/server/db", () => ({ getItem: mocks.getItem }));
vi.mock("@/server/plaid", () => ({
  createLinkToken: mocks.createLinkToken,
  describePlaidError: () => ({ errorCode: "X" }),
}));

import { POST } from "./route";

const ORIGIN = "http://127.0.0.1:3000";
const ACCESS = "access-sandbox-secret-token";

function request(body?: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/plaid/link-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body,
  });
}

describe("POST /api/plaid/link-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.createLinkToken.mockResolvedValue("link-sandbox-abc");
    mocks.getItem.mockImplementation((id: number) =>
      id === 1
        ? { id: 1, plaidItemId: "item-1", institutionName: "Fidelity", accessToken: ACCESS }
        : null,
    );
  });

  it("401s without a session", async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.createLinkToken).not.toHaveBeenCalled();
  });

  it("403s on a cross-site Origin", async () => {
    expect((await POST(request(undefined, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("creates a new-link token with an empty body", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linkToken: "link-sandbox-abc" });
    expect(mocks.createLinkToken).toHaveBeenCalledWith({ accessToken: undefined });
  });

  it.each([
    ['{"itemId":"1"}'],
    ['{"itemId":0}'],
    ['{"itemId":1.5}'],
    ['{"itemId":1,"extra":true}'],
    ["not json"],
  ])("400s on invalid body %s", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.createLinkToken).not.toHaveBeenCalled();
  });

  it("404s on an unknown itemId", async () => {
    expect((await POST(request('{"itemId":999}'))).status).toBe(404);
    expect(mocks.createLinkToken).not.toHaveBeenCalled();
  });

  it("uses the stored token for update mode and never echoes it", async () => {
    const res = await POST(request('{"itemId":1}'));
    expect(res.status).toBe(200);
    expect(mocks.createLinkToken).toHaveBeenCalledWith({ accessToken: ACCESS });
    const text = await res.text();
    expect(text).not.toContain("access-");
    expect(text).not.toContain("item-1");
  });
});
