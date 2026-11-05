import { describe, expect, it } from "vitest";
import { loginLockedFor, recordLoginFailure, recordLoginSuccess } from "./rate-limit";

describe("login rate limit", () => {
  it("locks after 5 failures and unlocks after the window", () => {
    recordLoginSuccess();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordLoginFailure(t0);
    expect(loginLockedFor(t0)).toBe(0);
    recordLoginFailure(t0);
    expect(loginLockedFor(t0)).toBeGreaterThan(0);
    expect(loginLockedFor(t0 + 15 * 60 * 1000)).toBe(0);
  });
});
