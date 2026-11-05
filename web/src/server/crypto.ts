import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope: [version (1)][iv (12)][auth tag (16)][ciphertext]
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  }
  return key;
}

/**
 * AES-256-GCM encrypt. `aad` binds the ciphertext to its context (e.g. the Plaid item_id)
 * so an encrypted token can't be swapped onto a different row.
 */
export function encrypt(plaintext: string, key: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(envelope: Buffer, key: Buffer, aad: string): string {
  if (envelope.length <= HEADER_LEN || envelope[0] !== VERSION) {
    throw new Error("Unrecognized ciphertext envelope");
  }
  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, HEADER_LEN);
  const ciphertext = envelope.subarray(HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
