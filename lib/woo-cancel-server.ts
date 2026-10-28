// «Anular pedido» desde Kapta para los pedidos de WooCommerce (MOM §38.15): la
// llamada a WooCommerce y lo que se escribe en Kapta. Solo servidor (descifra
// las claves de la tienda); las reglas puras están en lib/woo-cancel.ts.
//
// EL ORDEN. 1) las reglas, con lo leído de la base (un error de lectura no es
// «no hay nada»: no se anula); 2) `PUT /orders/<id> {status: "cancelled"}` con
// las claves guardadas, el tope de «Generar pedido» para un PUT y su reintento
// de autenticación por query string; 3) solo si WooCommerce dejó el pedido
// anulado, el hecho de la Actividad con quién y el motivo; 4) la fila local
// con `mapWooOrder` sobre la respuesta, por el camino de la entrada, y la del
// Master. Si WooCommerce no contesta o no lo deja anulado, no se escribe nada.
//
// UNA SOLA ANULACIÓN EN LA ACTIVIDAD. El hecho de Kapta ES el «Anulado en
// WooCommerce» (`cancelled_woocommerce`), con el usuario de Kapta como actor,
// `source = 'kapta'` y el motivo en la nota. Se escribe ANTES de guardar la
// fila: la entrada (esta misma, el webhook o la pasada que lleguen después)
// solo escribe su hecho si el último de WooCommerce del pedido no es ya una
// anulación (`recordWooStatusTransitions`), y además ya encuentra el pedido
// anulado. Su clave (`operation_id`) sale del intento (`requestId`): el doble
// clic o el reintento del mismo intento no escriben otro (0122).
//
// NUNCA LA PAPELERA. Solo `PUT` a «cancelled»: ni `DELETE` ni `trash`.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyWooOrderResponse } from "@/lib/ingest";
import { loadCompanionRides } from "@/lib/order-companion-access";
import { legacySaleSendBlock } from "@/lib/legacy-sale-cancel-access";
import { parseWooOrderId } from "@/lib/order-admin-url";
import { WOO_CANCELLED_STATUSES, WooError, fetchWooOrder, wooGmt, wooRequest, type WooClientOpts, type WooOrder } from "@/lib/woocommerce";
import {
  hasWooApiCredentials,
  loadWooStoreCreds,
  withWooAuthFallback,
  wooClientOpts,
} from "@/lib/woocommerce-intake";
import { WOO_EVENT_KIND } from "@/lib/woocommerce-activity";
import { WOO_SALE_TIMEOUTS, normalizeWooRequestId } from "@/lib/woocommerce-orders";
import {
  validateWooCancelReason,
  wooCancelBlocks,
  wooCancelEventNote,
  type WooCancelBlock,
  type WooCancelShipment,
} from "@/lib/woo-cancel";

/** `order_events.source` del hecho que escribe Kapta al anular. */
export const WOO_CANCEL_SOURCE = "kapta";

/**
 * Los topes: los de «Generar pedido» (`WOO_SALE_TIMEOUTS`, MOM §38.12) para un
 * PUT de estado (10 s) y para releer un pedido (5 s).
 */
export const WOO_CANCEL_TIMEOUTS = {
  update: WOO_SALE_TIMEOUTS.update,
  reread: WOO_SALE_TIMEOUTS.cleanup,
} as const;

function statusOf(order: Pick<WooOrder, "status"> | null | undefined): string {
  return String(order?.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^wc-/, "");
}

function isCancelled(order: Pick<WooOrder, "status"> | null | undefined): boolean {
  return WOO_CANCELLED_STATUSES.includes(statusOf(order));
}

/**
 * ¿Pudo haberse aplicado el PUT aunque falló? WooCommerce no contestó (tiempo,
 * red), contestó roto, o un proxy contestó por él (502/503/504) mientras
 * WordPress seguía trabajando. Un 4xx, o un 500 de PHP, es un «no».
 */
function mayHaveApplied(e: unknown): boolean {
  if (!(e instanceof WooError)) return true;
  if (e.kind === "tiempo" || e.kind === "red" || e.kind === "respuesta_invalida") return true;
  return e.status != null && [502, 503, 504].includes(e.status);
}

export type WooCancelCallOutcome =
  /** WooCommerce lo dejó anulado (lo dijo el PUT, o se vio al releerlo). */
  | { kind: "cancelled"; order: WooOrder; confirmedBy: "put" | "reread" }
  /** WooCommerce contestó, pero el pedido no quedó anulado (un plugin, otra regla). */
  | { kind: "not_cancelled"; status: string }
  /** No se anuló, o no se sabe: no se marca nada. */
  | { kind: "error"; message: string; unknown: boolean };

/**
 * Pasa el pedido a «Cancelado» en WooCommerce. `PUT` con su tope (y el
 * reintento por query string si el hosting borra la cabecera); si el PUT no
 * tuvo respuesta clara, relee el pedido para saber cómo quedó. Nunca lanza.
 */
export async function cancelWooOrderInStore(input: {
  client: WooClientOpts;
  wooId: number;
  timeouts?: Partial<typeof WOO_CANCEL_TIMEOUTS>;
}): Promise<WooCancelCallOutcome> {
  const t = { ...WOO_CANCEL_TIMEOUTS, ...(input.timeouts ?? {}) };
  let auth = input.client.auth ?? "basic";
  try {
    const res = await withWooAuthFallback({ ...input.client, timeoutMs: t.update }, (o) =>
      wooRequest<WooOrder>(o, { method: "PUT", path: `/orders/${input.wooId}`, body: { status: "cancelled" } }),
    );
    auth = res.auth;
    const order = res.value.data;
    if (!order || typeof order !== "object" || Array.isArray(order)) {
      throw new WooError("respuesta_invalida", "WooCommerce no devolvió el pedido.");
    }
    if (isCancelled(order)) return { kind: "cancelled", order, confirmedBy: "put" };
    return { kind: "not_cancelled", status: statusOf(order) || "(sin estado)" };
  } catch (e) {
    const said = e instanceof WooError ? e.message : "error desconocido";
    if (!mayHaveApplied(e)) {
      return { kind: "error", message: `WooCommerce no lo anuló: ${said}`, unknown: false };
    }
    // Sin respuesta clara: se relee para saber cómo quedó.
    try {
      const { value: order } = await withWooAuthFallback({ ...input.client, auth, timeoutMs: t.reread }, (o) =>
        fetchWooOrder(o, input.wooId),
      );
      if (isCancelled(order)) return { kind: "cancelled", order, confirmedBy: "reread" };
      return {
        kind: "error",
        message: `WooCommerce no confirmó la anulación (${said}) y el pedido sigue «${statusOf(order) || "sin estado"}» allí.`,
        unknown: false,
      };
    } catch {
      return {
        kind: "error",
        message: `WooCommerce no contestó (${said}) y no se pudo comprobar cómo quedó el pedido.`,
        unknown: true,
      };
    }
  }
}

/**
 * La clave del hecho de Kapta (`order_events.operation_id`): un uuid derivado
 * del pedido y del intento. El mismo intento (doble clic, reintento) da la
 * misma clave y el índice único de la 0122 deja entrar un solo hecho.
 */
export function wooKaptaCancelOperationId(orderId: string, requestId: string): string {
  const hex = createHash("sha256").update(`woo-kapta-cancel|${orderId}|${requestId}`, "utf8").digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type CancelWooOrderResult =
  | { ok: true; notice: string; already?: true }
  | { ok: false; error: string; blocks?: WooCancelBlock[] };

interface OrderFacts {
  id: string;
  store_id: string;
  shopify_order_id: string;
  name: string | null;
  platform: string | null;
  cancelled_at: string | null;
  financial_status: string | null;
}

const log = (event: string, data: Record<string, unknown>) => {
  const line = `[woo-cancel] ${JSON.stringify({ event, ...data })}`;
  if (event.endsWith("failed") || event.endsWith("error")) console.error(line);
  else console.info(line);
};

/**
 * Lo que impide anular, leído de la base. Lanza si algo no se pudo leer: «no
 * lo sé» no es «no hay salidas» ni «no hay pagos».
 */
async function loadBlocks(admin: SupabaseClient, order: OrderFacts): Promise<WooCancelBlock[]> {
  const { data: master, error: masterErr } = await admin
    .from("order_master")
    .select("general_status")
    .eq("order_id", order.id)
    .maybeSingle();
  if (masterErr) throw new Error(`el estado del pedido (${masterErr.message})`);
  const { data: shipments, error: shipErr } = await admin
    .from("shipments")
    .select("courier,guide_code,delivery_status,custody_state,created_via")
    .eq("order_id", order.id);
  if (shipErr) throw new Error(`las salidas (${shipErr.message})`);
  const { data: payments, error: payErr } = await admin
    .from("order_payments")
    .select("validation_status")
    .eq("order_id", order.id);
  if (payErr) throw new Error(`los comprobantes (${payErr.message})`);
  let rides: Awaited<ReturnType<typeof loadCompanionRides>>;
  try {
    rides = await loadCompanionRides(admin, [order.id]);
  } catch (e) {
    throw new Error(`los pedidos acompañantes (${e instanceof Error ? e.message : String(e)})`);
  }
  const travelsIn = rides.find((r) => r.link.companionOrderId === order.id && r.shipment);
  const carries = rides.filter((r) => r.link.hostOrderId === order.id && r.shipment);
  return wooCancelBlocks({
    platform: order.platform,
    generalStatus: (master as { general_status?: string | null } | null)?.general_status ?? null,
    financialStatus: order.financial_status,
    shipments: (shipments ?? []) as WooCancelShipment[],
    payments: (payments ?? []) as { validation_status: string | null }[],
    companion: {
      travelsIn: travelsIn ? (travelsIn.link.hostOrderName ?? "otro pedido") : null,
      carries: carries.map((r) => r.link.companionOrderName ?? "otro pedido"),
    },
  });
}

/**
 * Anula en WooCommerce un pedido de WooCommerce, a pedido de una persona desde
 * la ficha. Quien llama ya comprobó que esa persona ve el pedido y tiene el
 * permiso (app/dashboard/pedidos/woo-cancel-actions.ts). Nunca lanza.
 */
export async function cancelWooOrderFromKapta(input: {
  admin: SupabaseClient;
  orderId: string;
  userId: string;
  reasonCode: unknown;
  reasonText: unknown;
  requestId: unknown;
  fetchImpl?: typeof fetch;
  timeouts?: Partial<typeof WOO_CANCEL_TIMEOUTS>;
  now?: () => string;
}): Promise<CancelWooOrderResult> {
  const { admin, orderId, userId } = input;
  const requestId = normalizeWooRequestId(input.requestId);
  if (!requestId) return { ok: false, error: "Falta el id del intento: cierra y vuelve a abrir la anulación." };
  const reason = validateWooCancelReason(input.reasonCode, input.reasonText);
  if (!reason.ok) return { ok: false, error: reason.error };

  const { data, error } = await admin
    .from("orders")
    .select("id,store_id,shopify_order_id,name,platform,cancelled_at,financial_status")
    .eq("id", orderId)
    .maybeSingle();
  if (error) return { ok: false, error: `No se pudo leer el pedido (${error.message}). No se anuló nada.` };
  if (!data) return { ok: false, error: "No se encontró el pedido." };
  const order = data as OrderFacts;
  const label = order.name ?? "El pedido";

  // Shopify (o una base sin la 0274) no cambia: nada de aquí lo toca.
  if (order.platform !== "woocommerce") {
    const blocks = wooCancelBlocks({ platform: order.platform, generalStatus: null, financialStatus: null, shipments: [], payments: [] });
    return { ok: false, error: blocks[0]!.message, blocks };
  }
  // Ya anulado (el doble clic, un reintento, o lo anularon en wp-admin): no se
  // vuelve a llamar a WooCommerce ni se escribe otro hecho.
  if (order.cancelled_at) return { ok: true, already: true, notice: `${label} ya está anulado en la tienda.` };
  const ended = await legacySaleSendBlock(admin,orderId);
  if (ended) return { ok:false,error:`${ended} La cancelación en WooCommerce se completa por la recepción y el inventario de sus retornos.` };

  let blocks: WooCancelBlock[];
  try {
    blocks = await loadBlocks(admin, order);
  } catch (e) {
    return {
      ok: false,
      error: `No se pudo comprobar ${e instanceof Error ? e.message : String(e)}. No se anuló nada; vuelve a intentarlo.`,
    };
  }
  if (blocks.length) {
    return { ok: false, error: `No se anuló ${label}: ${blocks.map((b) => b.message).join(" ")}`, blocks };
  }

  const { creds, error: credsErr } = await loadWooStoreCreds(admin, order.store_id);
  if (credsErr) return { ok: false, error: "No se pudo leer la tienda. No se anuló nada; vuelve a intentarlo." };
  if (!creds || !hasWooApiCredentials(creds)) {
    return {
      ok: false,
      error:
        "La tienda no tiene claves de la API de WooCommerce que se puedan usar: revísalas en Ajustes → WooCommerce. No se anuló nada.",
    };
  }
  const parsed = parseWooOrderId(order.shopify_order_id);
  if (!parsed || parsed.siteKey !== creds.siteKey) {
    return {
      ok: false,
      error: "Este pedido es de otro sitio de WooCommerce que el que tiene guardado la tienda: anúlalo en su wp-admin. No se anuló nada.",
    };
  }
  const wooId = Number(parsed.wooId);
  const client = wooClientOpts(creds, input.fetchImpl ? { fetchImpl: input.fetchImpl } : {});

  const outcome = await cancelWooOrderInStore({ client, wooId, timeouts: input.timeouts });
  if (outcome.kind === "not_cancelled") {
    log("woo.cancel.not_cancelled", { orderId, wooId, status: outcome.status });
    return {
      ok: false,
      error: `WooCommerce contestó, pero ${label} quedó «${outcome.status}» allí, no anulado (puede ser un plugin). No se marcó nada en Kapta; revísalo en WooCommerce.`,
    };
  }
  if (outcome.kind === "error") {
    log("woo.cancel.failed", { orderId, wooId, unknown: outcome.unknown });
    return {
      ok: false,
      error: outcome.unknown
        ? `${outcome.message} No se marcó nada en Kapta. Si WooCommerce sí lo anuló, el Master lo mostrará solo en unos minutos; si no, vuelve a intentarlo.`
        : `${outcome.message} No se marcó nada en Kapta.`,
    };
  }

  // 3) El hecho, antes de la fila: la entrada no escribirá otro.
  const nowIso = input.now?.() ?? new Date().toISOString();
  const note = wooCancelEventNote(reason.label, reason.text);
  const { error: evErr } = await admin.from("order_events").insert({
    store_id: order.store_id,
    order_id: order.id,
    kind: WOO_EVENT_KIND.cancelled,
    occurred_at: wooGmt(outcome.order.date_modified_gmt) ?? nowIso,
    actor: userId,
    source: WOO_CANCEL_SOURCE,
    note,
    reason: `${reason.label} — ${reason.text}`,
    operation_id: wooKaptaCancelOperationId(order.id, requestId),
    payload: {
      woo_order_id: String(wooId),
      woo_status: statusOf(outcome.order),
      woo_by: "kapta",
      via: "kapta",
      reason_code: reason.code,
      request_id: requestId,
      confirmed_by: outcome.confirmedBy,
    },
  });
  const eventSaved = !evErr || (evErr as { code?: string }).code === "23505";
  if (!eventSaved) log("woo.cancel.event_failed", { orderId, wooId, error: evErr!.message });

  // 4) La fila local y la del Master, como la entrada.
  let rowSaved = false;
  try {
    const applied = await applyWooOrderResponse(admin, creds, outcome.order, input.fetchImpl);
    rowSaved = applied.applied;
    if (!applied.applied) log("woo.cancel.apply_skipped", { orderId, wooId, message: applied.message });
  } catch (e) {
    log("woo.cancel.apply_failed", { orderId, wooId, error: e instanceof Error ? e.message : String(e) });
  }
  log("woo.cancel.done", { orderId, wooId, userId, eventSaved, rowSaved });

  const extra = [
    rowSaved ? null : "El Master lo mostrará anulado cuando llegue el aviso de WooCommerce (en unos minutos).",
    eventSaved ? null : "No se pudo guardar el motivo en la Actividad: déjalo como comentario.",
  ].filter(Boolean);
  return { ok: true, notice: [`${label} quedó anulado en WooCommerce.`, ...extra].join(" ") };
}
