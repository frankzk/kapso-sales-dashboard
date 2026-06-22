// AES-256-GCM authenticated encryption for tokens at rest.
//
// Ciphertext format:  "v1:" + base64( iv[12] | ciphertext | authTag[16] )
//
// The key comes from ENCRYPTION_KEY (32 bytes) provided as base64 or hex.
// Generate one with:  openssl rand -base64 32
//
// Plaintext (Shopify Admin token, Shopify API secret, Kapso API key) is only
// ever decrypted server-side, on demand. It is never logged or sent to the
// client.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const IV_LEN = 12; // 96-bit nonce, recommended for GCM
const TAG_LEN = 16; // 128-bit auth tag

function loadKey(keyOverride?: string): Buffer {
  const raw = keyOverride ?? process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is not set");
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM (got ${key.length})`,
    );
  }
  return key;
}

/** Encrypt a UTF-8 string. Returns a self-describing "v1:..." token. */
export function encrypt(plaintext: string, keyOverride?: string): string {
  const key = loadKey(keyOverride);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, ciphertext, tag]);
  return `${VERSION}:${packed.toString("base64")}`;
}

/** Decrypt a "v1:..." token produced by encrypt(). Throws if tampered. */
export function decrypt(payload: string, keyOverride?: string): string {
  const key = loadKey(keyOverride);
  const sep = payload.indexOf(":");
  if (sep === -1) {
    throw new Error("Invalid ciphertext: missing version prefix");
  }
  const version = payload.slice(0, sep);
  const b64 = payload.slice(sep + 1);
  if (version !== VERSION) {
    throw new Error(`Unsupported ciphertext version: ${version}`);
  }
  const packed = Buffer.from(b64, "base64");
  if (packed.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Invalid ciphertext: too short");
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(packed.length - TAG_LEN);
  const ciphertext = packed.subarray(IV_LEN, packed.length - TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

/** Encrypt only when a value is present; pass-through null/empty. */
export function encryptOrNull(
  value: string | null | undefined,
  keyOverride?: string,
): string | null {
  return value ? encrypt(value, keyOverride) : null;
}

/** Decrypt only when a value is present; pass-through null/empty. */
export function decryptOrNull(
  value: string | null | undefined,
  keyOverride?: string,
): string | null {
  return value ? decrypt(value, keyOverride) : null;
}

/** Helper to mint a fresh 32-byte key (base64) — handy for setup/tests. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}
