// Ingesta del webhook de Swayp: cada cambio de estado de una guía llega como
//
//   POST { token, guide_number, state }
//
// Swayp registra la URL de destino de su lado (no se configura por API), y el
// `token` del body es lo único que prueba que la llamada es de ellos: no hay
// firma HMAC ni timestamp. Por eso la comparación es constant-time y, sin
// SWAYP_WEBHOOK_TOKEN configurado, el endpoint rechaza todo en vez de aceptar
// cualquier cosa.
//
// Separado de la ruta para poder testearlo sin HTTP, igual que
// processKapsoWebhook en lib/ingest.ts.

import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { mapSwaypState, SWAYP_STATES } from "@/lib/swayp";
import { categoryOf } from "@/lib/shipments";

export interface SwaypWebhookBody {
  token?: unknown;
  guide_number?: unknown;
  state?: unknown;
}

export type SwaypWebhookResult =
  /**
   * `not_configured` se distingue de `bad_token` a propósito. Los dos responden
   * 401, pero durante la puesta en marcha el integrador de Swayp prueba contra
   * nuestra URL sin poder ver nuestras variables de entorno: sin esta
   * distinción, "todavía no cargamos el token" y "el token que mandás está mal"
   * son el mismo 401 opaco y se pierde media jornada averiguando cuál es.
   * No filtra nada: que el endpoint aún no esté configurado no es un secreto.
   */
  | { status: "unauthorized"; reason: "not_configured" | "bad_token" }
  | { status: "ignored"; reason: "bad_payload" | "unknown_state" | "no_shipment" | "no_change" }
  | { status: "updated"; shipmentId: string; deliveryStatus: string; swaypState: number };

/** ¿Está cargado el token del webhook? Para el health-check, sin revelarlo. */
export function swaypWebhookConfigured(): boolean {
  return Boolean(env.swaypWebhookToken());
}

/** Constant-time compare with an equal-length gate (mirrors lib/ingest.ts). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Applies one Swayp state notification to its shipment.
 *
 * Deliberately conservative — a webhook is an untrusted, unordered, retryable
 * message:
 *   · An unknown state code is ignored rather than written, so a state Swayp
 *     adds later can't blank out a shipment's status.
 *   · A guide we don't know is ignored (guides created before the integration,
 *     or another integrator's traffic hitting the same URL).
 *   · Re-delivering the same state is a no-op, so Swayp's retries are safe.
 */
export async function processSwaypWebhook(input: {
  body: SwaypWebhookBody;
  admin?: SupabaseClient;
  now?: Date;
}): Promise<SwaypWebhookResult> {
  const expected = env.swaypWebhookToken();
  // También se recorta lo que llega: el token viaja copiado y pegado por dos
  // equipos distintos, y un blanco al borde no debería costar una tarde de
  // depuración. No afloja nada — nadie gana acceso por un espacio de más.
  const provided = typeof input.body?.token === "string" ? input.body.token.trim() : "";
  // Sin token configurado no se puede autenticar a nadie: cerrado por defecto.
  if (!expected) return { status: "unauthorized", reason: "not_configured" };
  if (!constantTimeEquals(provided, expected)) {
    return { status: "unauthorized", reason: "bad_token" };
  }

  const guide = input.body?.guide_number;
  const guideNumber =
    typeof guide === "string" || typeof guide === "number" ? String(guide).trim() : "";
  if (!guideNumber) return { status: "ignored", reason: "bad_payload" };

  const stateId = Number(input.body?.state);
  if (!Number.isFinite(stateId) || !SWAYP_STATES[stateId]) {
    return { status: "ignored", reason: "unknown_state" };
  }
  const deliveryStatus = mapSwaypState(stateId);
  if (!deliveryStatus) return { status: "ignored", reason: "unknown_state" };

  const admin = input.admin ?? createAdminSupabase();
  const { data: shipment } = await admin
    .from("shipments")
    .select("id,delivery_status,swayp_state")
    .eq("swayp_guide", guideNumber)
    .maybeSingle();
  if (!shipment) return { status: "ignored", reason: "no_shipment" };

  const row = shipment as { id: string; delivery_status: string; swayp_state: number | null };
  const syncedAt = (input.now ?? new Date()).toISOString();

  if (row.swayp_state === stateId && row.delivery_status === deliveryStatus) {
    // El estado no cambia, pero SÍ se sella la hora: 0080 define
    // `swayp_synced_at` como «cuándo se recibió la última notificación», y su
    // razón de ser es detectar guías que dejaron de reportar. Si sólo se
    // escribiera al cambiar de estado, una guía que Swayp sigue notificando en
    // el mismo estado —sus reintentos, o un estado que dura días— se leería
    // como abandonada. La columna mediría otra cosa que la que dice medir.
    await admin.from("shipments").update({ swayp_synced_at: syncedAt }).eq("id", row.id);
    return { status: "ignored", reason: "no_change" };
  }

  await admin
    .from("shipments")
    .update({
      delivery_status: deliveryStatus,
      status_category: categoryOf(deliveryStatus),
      swayp_state: stateId,
      swayp_synced_at: syncedAt,
    })
    .eq("id", row.id);

  return { status: "updated", shipmentId: row.id, deliveryStatus, swaypState: stateId };
}
