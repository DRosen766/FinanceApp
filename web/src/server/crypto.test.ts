import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, parseKey } from "./crypto";

const key = randomBytes(32);
const token = "access-sandbox-12345678-aaaa-bbbb-cccc-1234567890ab";

describe("crypto", () => {
  it("round-trips", () => {
    expect(decrypt(encrypt(token, key, "item-1"), key, "item-1")).toBe(token);
  });

  it("does not contain the plaintext and uses a fresh IV each time", () => {
    const a = encrypt(token, key, "item-1");
    const b = encrypt(token, key, "item-1");
    expect(a.toString("latin1")).not.toContain("access-sandbox");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    const env = encrypt(token, key, "item-1");
    env[env.length - 1] ^= 0x01;
    expect(() => decrypt(env, key, "item-1")).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const env = encrypt(token, key, "item-1");
    env[1 + 12] ^= 0x01;
    expect(() => decrypt(env, key, "item-1")).toThrow();
  });

  it("rejects ciphertext moved to a different item (AAD mismatch)", () => {
    expect(() => decrypt(encrypt(token, key, "item-1"), key, "item-2")).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => decrypt(encrypt(token, key, "item-1"), randomBytes(32), "item-1")).toThrow();
  });

  it("validates key length", () => {
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 random bytes/);
    expect(parseKey(key.toString("base64")).equals(key)).toBe(true);
  });
});
