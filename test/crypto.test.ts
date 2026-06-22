import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  encryptOrNull,
  decryptOrNull,
  generateEncryptionKey,
} from "@/lib/crypto";

const KEY = generateEncryptionKey(); // base64, 32 bytes
const HEX_KEY = Buffer.from(KEY, "base64").toString("hex");

describe("crypto (AES-256-GCM)", () => {
  it("round-trips a token", () => {
    const secret = "shpat_1234567890abcdef_ADMIN_TOKEN";
    const ct = encrypt(secret, KEY);
    expect(decrypt(ct, KEY)).toBe(secret);
  });

  it("round-trips unicode and long values", () => {
    const secret = "clé-secrète-🔐-" + "x".repeat(5000);
    expect(decrypt(encrypt(secret, KEY), KEY)).toBe(secret);
  });

  it("produces the v1: prefixed format", () => {
    expect(encrypt("hello", KEY)).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
  });

  it("uses a random IV (ciphertexts differ, both decrypt)", () => {
    const a = encrypt("same-plaintext", KEY);
    const b = encrypt("same-plaintext", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("same-plaintext");
    expect(decrypt(b, KEY)).toBe("same-plaintext");
  });

  it("accepts a hex-encoded key equivalently to base64", () => {
    const ct = encrypt("token", KEY);
    expect(decrypt(ct, HEX_KEY)).toBe("token");
  });

  it("fails to decrypt with the wrong key (auth tag mismatch)", () => {
    const ct = encrypt("token", KEY);
    const other = generateEncryptionKey();
    expect(() => decrypt(ct, other)).toThrow();
  });

  it("detects tampering with the ciphertext body", () => {
    const ct = encrypt("token", KEY);
    const b64 = ct.split(":")[1]!;
    const buf = Buffer.from(b64, "base64");
    const last = buf.length - 1;
    buf[last] = (buf[last] ?? 0) ^ 0xff; // flip a bit in the auth tag
    const tampered = `v1:${buf.toString("base64")}`;
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decrypt("not-versioned", KEY)).toThrow();
    expect(() => decrypt("v2:abcd", KEY)).toThrow(/version/i);
    expect(() => decrypt("v1:AAAA", KEY)).toThrow(/too short/i);
  });

  it("rejects keys that are not 32 bytes", () => {
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => encrypt("x", shortKey)).toThrow(/32 bytes/);
  });

  it("encryptOrNull / decryptOrNull pass through empty values", () => {
    expect(encryptOrNull(null, KEY)).toBeNull();
    expect(encryptOrNull("", KEY)).toBeNull();
    expect(decryptOrNull(null, KEY)).toBeNull();
    const ct = encryptOrNull("v", KEY);
    expect(decryptOrNull(ct, KEY)).toBe("v");
  });
});
