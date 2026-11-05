// La consulta de la tienda: «¿este celular paga por adelantado?» (MOM §41.5).
//
// La llaman el mu-plugin de WordPress (docs/kapta/wordpress/kapta-prepago.php)
// en el checkout y el formulario de COD Core (docs/kapta/cod-core-prepago.md)
// antes de ofrecer «Pago contra entrega». Contesta SOLO `{ prepay_required }`:
// nunca el motivo, la evidencia ni nada de la clienta.
//
// LA FIRMA. La misma de los formularios abandonados de COD Core
// (`verifyWooSignature`, el secreto de los webhooks de WooCommerce de la
// tienda): `X-Kapta-Signature` = base64(HMAC-SHA256(cuerpo crudo, secreto)).
// Para que una respuesta capturada no sirva después, el cuerpo lleva su
// `timestamp` (segundos unix) y la cabecera `X-Kapta-Timestamp` lo repite: como
// el cuerpo va firmado, el sello también; más de 5 minutos de diferencia con
// el reloj de Kapta se rechaza.
//
// LIVIANA: una lectura de la tienda y una del índice de la lista. Sin
// historial, sin pedidos.

import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyWooSignature } from "@/lib/woocommerce";
import { WOO_STORE_COLUMNS, wooCredsFromRow } from "@/lib/woocommerce-intake";
import { prepayLookup } from "@/lib/prepay-list-server";

export const PREPAY_SIGNATURE_HEADER = "x-kapta-signature";
export const PREPAY_TIMESTAMP_HEADER = "x-kapta-timestamp";
/** Cuánta diferencia de reloj se acepta: 5 minutos. */
export const PREPAY_MAX_SKEW_S = 300;
/** El cuerpo es un celular y un sello: 4 KB sobran. */
export const PREPAY_MAX_BODY_BYTES = 4096;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrepayQueryResult =
  | { status: 200; body: { prepay_required: boolean } }
  | { status: 400 | 401 | 404 | 409 | 413 | 503; body: { error: string } };

const err = (status: 400 | 401 | 404 | 409 | 413 | 503, error: string): PrepayQueryResult => ({ status, body: { error } });

/**
 * El sello de la cabecera y el del cuerpo: los dos iguales y a 5 minutos o
 * menos del reloj. Null si sirve, o por qué no. Pura.
 */
export function prepayTimestampProblem(header: string | null | undefined, bodyTimestamp: unknown, nowMs: number): string | null {
  const h = Number((header ?? "").trim());
  if (!Number.isInteger(h) || h <= 0) return "Falta la cabecera X-Kapta-Timestamp (segundos unix).";
  const b = typeof bodyTimestamp === "number" ? bodyTimestamp : typeof bodyTimestamp === "string" ? Number(bodyTimestamp) : NaN;
  if (b !== h) return "El timestamp del cuerpo no coincide con X-Kapta-Timestamp.";
  if (Math.abs(nowMs / 1000 - h) > PREPAY_MAX_SKEW_S) return "El timestamp está a más de 5 minutos del reloj de Kapta.";
  return null;
}

/** La consulta entera: firma, sello, tienda y lista. Nunca lanza. */
export async function handlePrepayQuery(
  admin: SupabaseClient,
  params: { storeId: string; rawBody: string; signature: string | null; timestamp: string | null; nowMs?: number },
): Promise<PrepayQueryResult> {
  const nowMs = params.nowMs ?? Date.now();
  if (Buffer.byteLength(params.rawBody ?? "", "utf8") > PREPAY_MAX_BODY_BYTES) return err(413, "El cuerpo es demasiado grande.");
  if (!UUID_RE.test(params.storeId ?? "")) return err(404, "tienda desconocida");
  try {
    const { data, error } = await admin.from("stores").select(`${WOO_STORE_COLUMNS},org_id`).eq("id", params.storeId).maybeSingle();
    if (error) return err(503, "No se pudo leer la tienda.");
    if (!data) return err(404, "tienda desconocida");
    const row = data as Record<string, unknown>;
    const creds = wooCredsFromRow(row);
    if (!creds.webhookSecret) return err(401, "La tienda no tiene guardado el secreto de los webhooks (Ajustes → WooCommerce).");
    if (!verifyWooSignature(params.rawBody, params.signature, creds.webhookSecret)) {
      return err(401, "La firma no cuadra con el secreto de los webhooks de la tienda.");
    }
    if (creds.platform !== "woocommerce" || creds.status !== "active") return err(409, "La tienda no está activa en WooCommerce.");

    let body: unknown;
    try {
      body = JSON.parse(params.rawBody);
    } catch {
      return err(400, "El cuerpo no es JSON.");
    }
    const b = (body ?? {}) as { phone?: unknown; timestamp?: unknown };
    const stale = prepayTimestampProblem(params.timestamp, b.timestamp, nowMs);
    if (stale) return err(401, stale);
    if (typeof b.phone !== "string" || !b.phone.trim()) return err(400, "Falta `phone`.");

    const orgId = typeof row.org_id === "string" ? row.org_id : null;
    if (!orgId) return { status: 200, body: { prepay_required: false } };
    const lookup = await prepayLookup(admin, orgId, b.phone);
    if (lookup.state === "unread") return err(503, "No se pudo leer la lista. Reintenta.");
    return { status: 200, body: { prepay_required: lookup.state === "listed" } };
  } catch {
    return err(503, "Error interno. Reintenta.");
  }
}
