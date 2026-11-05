// El token del webhook de Anura («Llamar con Anura», fase 1). SERVIDOR.
//
// Anura manda los avisos sin autenticación propia: el secreto va en la URL.
// No hay variable nueva: se deriva de ENCRYPTION_KEY y del id de la org,
//
//   token = HMAC-SHA256(ENCRYPTION_KEY, "anura-webhook:" + orgId), en hex, 32
//
// y la URL lleva los dos: `/api/webhooks/anura?org=<orgId>&t=<token>`. El
// token solo vale para su org (no se puede usar el de una para escribir en
// otra) y se compara en tiempo constante. Rotar ENCRYPTION_KEY cambia el
// token: hay que volver a pegar la URL en Anura.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "@/lib/anura/events";

export const ANURA_WEBHOOK_PATH = "/api/webhooks/anura";
export const ANURA_WEBHOOK_TOKEN_LENGTH = 32;

function keyOf(key?: string): string {
  const k = key ?? process.env.ENCRYPTION_KEY ?? "";
  if (!k) throw new Error("ENCRYPTION_KEY is not set");
  return k;
}

/** El token de la org. Lanza si falta ENCRYPTION_KEY. */
export function anuraWebhookToken(orgId: string, key?: string): string {
  return createHmac("sha256", keyOf(key))
    .update(`anura-webhook:${orgId.toLowerCase()}`, "utf8")
    .digest("hex")
    .slice(0, ANURA_WEBHOOK_TOKEN_LENGTH);
}

/** ¿Es este el token de la org? Falso ante cualquier duda; nunca lanza. */
export function anuraWebhookTokenValid(orgId: string | null | undefined, token: string | null | undefined, key?: string): boolean {
  if (!isUuid(orgId) || typeof token !== "string" || token.length !== ANURA_WEBHOOK_TOKEN_LENGTH) return false;
  let want: string;
  try {
    want = anuraWebhookToken(orgId, key);
  } catch {
    return false;
  }
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(token.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** La URL que se pega en Anura (Configuración → Eventos). */
export function anuraWebhookUrl(siteUrl: string, orgId: string, key?: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return `${base}${ANURA_WEBHOOK_PATH}?org=${orgId}&t=${anuraWebhookToken(orgId, key)}`;
}
