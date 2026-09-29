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
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { mapSwaypState, SWAYP_STATES, swaypCustodyFor } from "@/lib/swayp";
import { categoryOf, reconcileDeliveryStatus } from "@/lib/shipments";

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

/** Las columnas que hacen falta para aplicar un estado de Swayp a su guía. */
export const SWAYP_SHIPMENT_COLUMNS =
  "id,order_id,delivery_status,swayp_state,custody_state,custody_transferred_at," +
  "dispatched_at,out_for_delivery_at,closed_at";

/** La guía tal como la necesita `swaypStatePatch`. */
export interface SwaypShipmentRow {
  id: string;
  order_id?: string | null;
  delivery_status: string;
  swayp_state: number | null;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
  dispatched_at?: string | null;
  out_for_delivery_at?: string | null;
  closed_at?: string | null;
}

/** Un estado de Swayp ya traducido a código, con las fechas que Swayp dé. */
export interface SwaypIncomingState {
  state: number;
  /** Cuándo salió a reparto, si se sabe (historial de la API). */
  departedAt?: string | null;
  /** Cuándo entró al estado actual, si se sabe. */
  changedAt?: string | null;
}

/** Estados de la guía que no se reabren (`reconcileDeliveryStatus`). */
const TERMINAL_DELIVERY = new Set(["entregado", "anulado", "transferido"]);

/** Estados que prueban que el paquete ya salió aunque no sepamos cuándo. */
const LEFT_FOR_SURE = new Set([6, 8, 9, 12]);

/** Estados en los que la guía ya estaba con un mensajero (o volviendo). */
const LEFT_STATES = new Set([4, 5, 6, 8, 9, 12]);

/** ¿Lo que ya sabemos de la guía prueba que el paquete salió? */
function guideLeft(row: SwaypShipmentRow): boolean {
  return (
    LEFT_STATES.has(Number(row.swayp_state)) ||
    Boolean(row.dispatched_at || row.out_for_delivery_at) ||
    row.custody_state === "courier" ||
    row.custody_state === "retorno"
  );
}

/**
 * La API de Swayp cierra una DEVOLUCIÓN como 10 «Cancelada». Su documentación
 * dice que 10 solo es posible desde 1 (Generada), pero el 29-09-2026 las 15
 * guías que su tracking enseña en 9 «Devolución confirmada» —con Reparto,
 * Novedad y Devolución en el historial— llegaron por `GET /v2/guias` como 10, y
 * Kapta las tomó por canceladas: siete pedidos sin anular cayeron en
 * «Finalizado · Anulado cerrado». Un 10 sobre una guía que ya salió es el final
 * de su devolución (9); sobre una que nunca salió, una cancelación de verdad.
 */
export function normalizeSwaypIncoming(row: SwaypShipmentRow, incoming: SwaypIncomingState): SwaypIncomingState {
  if (incoming.state === 10 && guideLeft(row)) return { ...incoming, state: 9 };
  return incoming;
}

/**
 * Lo que un estado de Swayp cambia en su guía. PURA: la usan el webhook y el
 * barrido de la API (lib/swayp-status-sweep.ts), para que las dos puertas
 * escriban lo mismo.
 *
 *   · El estado de entrega solo AVANZA (`reconcileDeliveryStatus`): una
 *     lectura de «Por recolectar» no devuelve a `pendiente` una guía directa que
 *     nació `en_ruta`, y un terminal no se reabre.
 *   · El estado crudo se guarda siempre que la guía siga viva, porque es la
 *     verdad de Swayp y lo único que distingue una Novedad de un Reparto. En
 *     una guía ya cerrada solo entra si dice lo mismo (9 → 12).
 *   · La custodia sigue a Swayp —`courier` en ruta, `retorno` al volver—, y a
 *     diferencia de Tanders PUEDE volver de `retorno` a `courier`: una novedad
 *     resuelta regresa a Reparto (5, «Solucionado») y la lectura es del
 *     presente, no una foto atrasada. `devuelto` no lo toca nunca: eso lo pone
 *     quien recibe la caja (MOM §9.4).
 *   · Las fechas se llenan UNA vez: la salida (`dispatched_at`) es el ancla de
 *     la recuperación, igual que en Tanders; el reparto (`out_for_delivery_at`)
 *     y el cierre (`closed_at`) salen del historial de Swayp si viene.
 *
 * Repetir el mismo estado no cambia nada: cada estado se aplica al llegar.
 */
export function swaypStatePatch(
  row: SwaypShipmentRow,
  read: SwaypIncomingState,
  nowIso: string,
): { patch: Record<string, unknown>; changed: boolean; deliveryStatus: string } {
  const incoming = normalizeSwaypIncoming(row, read);
  const mapped = mapSwaypState(incoming.state);
  if (!mapped) return { patch: {}, changed: false, deliveryStatus: row.delivery_status };

  const next = reconcileDeliveryStatus(row.delivery_status, mapped);
  const applies = !TERMINAL_DELIVERY.has(row.delivery_status) || mapped === row.delivery_status;
  const stateMoved = applies && row.swayp_state !== incoming.state;
  const patch: Record<string, unknown> = {};
  if (!stateMoved && next === row.delivery_status) {
    return { patch, changed: false, deliveryStatus: row.delivery_status };
  }

  if (stateMoved) patch.swayp_state = incoming.state;
  if (next !== row.delivery_status) {
    patch.delivery_status = next;
    patch.status_category = categoryOf(next);
  }

  const departed = incoming.departedAt ?? null;
  const changedAt = incoming.changedAt ?? null;
  const custody = swaypCustodyFor(incoming.state);
  if (custody && row.custody_state !== "devuelto" && row.custody_state !== custody) {
    patch.custody_state = custody;
    if (!row.custody_transferred_at) patch.custody_transferred_at = departed ?? changedAt ?? nowIso;
  }
  if (!row.dispatched_at && (departed || LEFT_FOR_SURE.has(incoming.state))) {
    patch.dispatched_at = departed ?? changedAt ?? nowIso;
  }
  if (!row.out_for_delivery_at && (incoming.state === 5 || incoming.state === 6)) {
    patch.out_for_delivery_at = departed ?? changedAt ?? nowIso;
  }
  if (!row.closed_at && next !== row.delivery_status && TERMINAL_DELIVERY.has(next)) {
    patch.closed_at = changedAt ?? nowIso;
  }
  return { patch, changed: true, deliveryStatus: next };
}

/**
 * Aplica un estado de Swayp a su guía y, si cambió algo, recalcula el Master
 * del pedido. `swayp_synced_at` se sella SIEMPRE: 0080 lo define como «cuándo
 * supimos de Swayp por última vez», y sirve para ver guías que dejaron de
 * reportar.
 */
export async function applySwaypState(
  admin: SupabaseClient,
  row: SwaypShipmentRow,
  incoming: SwaypIncomingState,
  opts: {
    now?: Date;
    /** El recálculo del Master; `false` = lo hace quien llama, en lote. */
    recompute?: ((admin: SupabaseClient, orderIds: string[]) => Promise<unknown>) | false;
  } = {},
): Promise<{ changed: boolean; deliveryStatus: string }> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const { patch, changed, deliveryStatus } = swaypStatePatch(row, incoming, nowIso);
  const { error } = await admin
    .from("shipments")
    .update({ ...patch, swayp_synced_at: nowIso })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  const recompute = opts.recompute ?? recomputeOrderMasterSafe;
  // Sin esto el cambio no llega al Master hasta la puerta de guías movidas del
  // cron (hasta 10 minutos), y un pedido que Swayp devolvió sigue «En tránsito».
  if (changed && row.order_id && recompute) await recompute(admin, [row.order_id]);
  return { changed, deliveryStatus };
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
  recompute?: ((admin: SupabaseClient, orderIds: string[]) => Promise<unknown>) | false;
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
  if (!mapSwaypState(stateId)) return { status: "ignored", reason: "unknown_state" };

  const admin = input.admin ?? createAdminSupabase();
  const { data: shipment } = await admin
    .from("shipments")
    .select(SWAYP_SHIPMENT_COLUMNS)
    .eq("swayp_guide", guideNumber)
    .maybeSingle();
  if (!shipment) return { status: "ignored", reason: "no_shipment" };

  const row = shipment as unknown as SwaypShipmentRow;
  // El estado no cambia, pero SÍ se sella la hora: 0080 define
  // `swayp_synced_at` como «cuándo se recibió la última notificación», y su
  // razón de ser es detectar guías que dejaron de reportar. Si sólo se
  // escribiera al cambiar de estado, una guía que Swayp sigue notificando en el
  // mismo estado —sus reintentos, o un estado que dura días— se leería como
  // abandonada. La columna mediría otra cosa que la que dice medir.
  const { changed, deliveryStatus } = await applySwaypState(
    admin,
    row,
    { state: stateId },
    { now: input.now, recompute: input.recompute },
  );
  if (!changed) return { status: "ignored", reason: "no_change" };
  return { status: "updated", shipmentId: row.id, deliveryStatus, swaypState: stateId };
}
