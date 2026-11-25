// La firma de los avisos de Zernio (MOM §25.4). Aparte de lib/social-inbox.ts
// porque usa node:crypto y aquel también lo lee la pantalla. PURO.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `X-Zernio-Signature` es el HMAC-SHA256 en hexadecimal minúscula del cuerpo
 * CRUDO con el secreto (`ZERNIO_WEBHOOK_SECRET`). Se compara en tiempo
 * constante y antes de leer el JSON. Sin secreto o sin firma, no pasa.
 */
export function verifyZernioSignature(rawBody: string, signature: string | null | undefined, secret: string | null | undefined): boolean {
  const sig = (signature ?? "").trim().toLowerCase();
  if (!secret || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
