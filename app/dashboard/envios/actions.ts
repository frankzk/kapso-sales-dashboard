"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import {
  getReprogramRows,
  getShipmentWithCalls,
  searchOrdersForLink,
  searchShipmentsQuery,
  type OrderLinkCandidate,
} from "@/lib/shipments-access";
import type { ReprogramChildRow } from "@/lib/shipments";
import {
  CLAIM_TTL_MINUTES,
  COURIER_REPORT_RESULTS,
  attemptLabel,
  categoryOf,
  courierReportTransition,
  evaluateAliclikReschedule,
  isFutureShipmentFollowup,
  isCallable,
  isFenixCity,
  isValidStatus,
  nextShipmentTransition,
  normalizeCity,
  rescheduleGuideCode,
  shipmentRequiresCourierResult,
  type CourierReportResult,
  type RerouteDisposition,
} from "@/lib/shipments";
import { getStoreCreds } from "@/lib/ingest";
import { getAccessibleStores } from "@/lib/access";
import {
  fetchOrderById,
  pickStoresForOrderQuery,
  searchOrdersLive,
  searchProductVariants,
  updateOrderShippingAddress,
  type ProductVariantResult,
} from "@/lib/shopify";
import { runSuggestionBatch, SUGGESTION_BATCH_SIZE, type BatchResult } from "@/lib/shipment-auto-match";
import { evaluateFenix, type FenixEligibility, type FenixStockRow } from "@/lib/fenix";
import {
  ajusteDelta,
  consumeFenixStockOnDelivery,
  recordStockMovement,
  STOCK_MOVEMENT_LABEL,
  type StockMovementKind,
  type StockMovementRow,
} from "@/lib/fenix-ledger";
import { resolveEmails } from "@/lib/productivity";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import type {
  LinkedShipmentSummary,
  ShipmentCallRow,
  ShipmentHistoryGuide,
  ShipmentOrderDetail,
  ShipmentRow,
} from "@/lib/types";

export interface ShipmentActionState {
  error?: string;
  notice?: string;
}

/** Filas crudas de reprogramaciones (guías Fénix hijas) + nombres de asesor,
 *  para que el popup recompute los cortes por rango en el cliente. RLS-scoped. */
export async function loadReprogramData(): Promise<{
  rows: ReprogramChildRow[];
  asesorNames: Record<string, string>;
}> {
  const stores = await getAccessibleStores();
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return { rows: [], asesorNames: {} };
  return getReprogramRows(storeIds);
}

async function resolveCurrentFenixEligibility(
  admin: SupabaseClient,
  storeId: string,
  shipment: { city: string | null; product: string | null; order_id: string | null },
): Promise<FenixEligibility | { error: string }> {
  const { data: store, error: storeError } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", storeId)
    .maybeSingle();
  if (storeError || !store) return { error: storeError?.message ?? "No se encontró la organización." };

  const stockPromise = admin
    .from("fenix_stock")
    .select("city,product,sku,quantity")
    .eq("org_id", (store as { org_id: string }).org_id);
  const orderPromise = shipment.order_id
    ? admin.from("orders").select("line_items").eq("id", shipment.order_id).maybeSingle()
    : Promise.resolve({ data: null, error: null });
  const [{ data: stock, error: stockError }, { data: order, error: orderError }] = await Promise.all([
    stockPromise,
    orderPromise,
  ]);
  if (stockError || orderError) return { error: stockError?.message ?? orderError?.message ?? "No se pudo consultar el stock." };

  const lineItems = (order as {
    line_items?: { title?: string | null; sku?: string | null }[] | null;
  } | null)?.line_items ?? undefined;
  return evaluateFenix(shipment, (stock as FenixStockRow[]) ?? [], lineItems);
}

// Process-level cache of agent id → display name (email local-part).
const agentNameCache = new Map<string, string>();

async function resolveAgentName(
  userId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<string | null> {
  if (agentNameCache.has(userId)) return agentNameCache.get(userId)!;
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data?.user?.email ?? null;
    const name = email ? email.split("@")[0]! : userId.slice(0, 8);
    agentNameCache.set(userId, name);
    return name;
  } catch {
    return null;
  }
}

/** Authorize the caller against a shipment via RLS (must see its store). */
async function authorizeShipment(
  shipmentId: string,
): Promise<{ userId: string; storeId: string } | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb.from("shipments").select("store_id").eq("id", shipmentId).maybeSingle();
  if (!data) return null;
  return { userId: user.id, storeId: data.store_id as string };
}

/** Fetch a shipment + its call history (RLS-scoped). Drives the drawer. */
export async function loadShipmentDetail(
  shipmentId: string,
): Promise<
  | {
      shipment: ShipmentRow;
      calls: ShipmentCallRow[];
      guideHistory: ShipmentHistoryGuide[];
      order: ShipmentOrderDetail | null;
      linkedFenixShipment: LinkedShipmentSummary | null;
    }
  | { error: string }
> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const detail = await getShipmentWithCalls(shipmentId);
  if (!detail) return { error: "No encontrado." };
  const admin = createAdminSupabase();
  const historyCalls = detail.guideHistory.flatMap((guide) => guide.calls);
  const ids = [...new Set(historyCalls.map((c) => c.agent).filter(Boolean))] as string[];
  if (ids.length) {
    await Promise.all(ids.map((id) => resolveAgentName(id, admin)));
  }
  const calls = detail.calls.map((c) => ({
    ...c,
    agent_name: c.agent ? (agentNameCache.get(c.agent) ?? null) : null,
  }));
  const guideHistory = detail.guideHistory.map((guide) => ({
    ...guide,
    calls: guide.calls.map((call) => ({
      ...call,
      agent_name: call.agent ? (agentNameCache.get(call.agent) ?? null) : null,
    })),
  }));
  let order = detail.order;
  // If the local order came from an older no-phone Shopify fallback, its raw
  // payload can have products but no shippingAddress. Refresh that one order
  // live, cache the repaired payload, and keep the drawer fast on later opens.
  if (order && !order.shipping_address && order.shopify_order_id) {
    const creds = await getStoreCreds(ctx.storeId, admin);
    if (creds?.shopify_token) {
      try {
        const liveOrder = await fetchOrderById({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId: ctx.storeId,
          orderGid: `gid://shopify/Order/${order.shopify_order_id}`,
        });
        const liveAddress = shopifyShippingAddress(liveOrder?.raw);
        if (liveOrder && liveAddress) {
          order = {
            name: liveOrder.name,
            shopify_order_id: liveOrder.shopify_order_id,
            line_items: liveOrder.line_items,
            shipping_address: liveAddress,
          };
          if (detail.shipment.order_id) {
            await admin
              .from("orders")
              .update({ raw: liveOrder.raw, line_items: liveOrder.line_items })
              .eq("id", detail.shipment.order_id);
          }
        }
      } catch {
        // Keep the local/draft-order result; the drawer remains usable if the
        // store temporarily cannot be reached.
      }
    }
  }
  return {
    shipment: detail.shipment,
    calls,
    guideHistory,
    order,
    linkedFenixShipment: detail.linkedFenixShipment,
  };
}

/** Global search (guía / pedido / guía Fenix / celular), RLS-scoped. */
export async function searchShipments(query: string): Promise<ShipmentRow[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return searchShipmentsQuery(query);
}

/** Search accessible orders (guía/pedido drawer's manual-link picker), RLS-scoped. */
export async function searchOrdersToLink(query: string): Promise<OrderLinkCandidate[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return searchOrdersForLink(query);
}

/** Claim a shipment (one at a time). Succeeds if free, stale, or already mine. */
export async function claimShipment(shipmentId: string): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const admin = createAdminSupabase();
  const cutoff = new Date(Date.now() - CLAIM_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("shipments")
    .update({ claimed_by: ctx.userId, claimed_at: new Date().toISOString() })
    .eq("id", shipmentId)
    .or(`claimed_by.is.null,claimed_by.eq.${ctx.userId},claimed_at.lt.${cutoff}`)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) {
    const { data: held } = await admin
      .from("shipments")
      .select("claimed_by")
      .eq("id", shipmentId)
      .maybeSingle();
    const holderId = (held as { claimed_by: string | null } | null)?.claimed_by ?? null;
    const who = holderId && holderId !== ctx.userId ? await resolveAgentName(holderId, admin) : null;
    return { error: who ? `${who} está atendiendo este envío.` : "Otro agente está atendiendo este envío." };
  }
  return { notice: "Envío tomado." };
}

/** Keep an existing reservation alive while its drawer remains open. */
export async function renewShipmentClaim(shipmentId: string): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("shipments")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", shipmentId)
    .eq("claimed_by", ctx.userId)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "La reserva de este envío ya no está activa." };
  return { notice: "Reserva renovada." };
}

/** Release a claim (only your own). */
export async function releaseShipment(shipmentId: string): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso." };
  const admin = createAdminSupabase();
  await admin
    .from("shipments")
    .update({ claimed_by: null, claimed_at: null })
    .eq("id", shipmentId)
    .eq("claimed_by", ctx.userId);
  return { notice: "Liberado." };
}

/**
 * Register a gestión call. Reads the current state, applies the transition
 * (confirma→En ruta / no_contesta→siguiente intento o Anulado / cancela→Anulado
 * / entregado→Entregado por Fenix), updates the shipment and logs the call.
 *
 * "Cliente confirma" doubles as the re-dispatch step: it AUTO-generates a new,
 * unique Fenix guide (date-stamped with the reprogramación date) and transfers
 * this shipment to it, in one action — because Fenix rejects re-uploading a guide
 * code it has already seen, every confirmed reprogramación needs a fresh guide.
 * Successive re-dispatches chain (each new guide spins off the current active one),
 * so an order can accumulate several Fenix guides over its life.
 */
export async function registerRerouteCall(
  shipmentId: string,
  input: {
    disposition: RerouteDisposition;
    note?: string;
    nextFollowupAt?: string | null;
    reprogramProvider?: "aliclik" | "fenix";
    forceAliclik?: boolean;
  },
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const admin = createAdminSupabase();

  const fetchShipment = (columns: string) => admin
    .from("shipments")
    .select(columns)
    .eq("id", shipmentId)
    .maybeSingle();
  let shipmentResult = await fetchShipment(
    "id,courier,guide_code,delivery_status,reroute_attempts,order_id,order_name,city,product,fenix_eligible,fenix_shipment_id,aliclik_attempts,aliclik_service_date",
  );
  // 0038 may land moments after the app deploy. Preserve the existing Fenix
  // workflow instead of making every gestión return "No encontrado".
  if (shipmentResult.error) {
    shipmentResult = await fetchShipment(
      "id,courier,guide_code,delivery_status,reroute_attempts,order_id,order_name,city,product,fenix_eligible,fenix_shipment_id",
    );
  }
  const ship = shipmentResult.data;
  if (!ship) return { error: "No encontrado." };
  const shipmentSnapshot = ship as unknown as {
    courier: string;
    guide_code: string;
    delivery_status: string;
    reroute_attempts: number | null;
    order_id: string | null;
    order_name: string | null;
    city: string | null;
    product: string | null;
    fenix_eligible: boolean;
    fenix_shipment_id: string | null;
    aliclik_attempts?: number | null;
    aliclik_service_date?: string | null;
  };
  const cur = {
    ...shipmentSnapshot,
    aliclik_attempts: shipmentSnapshot.aliclik_attempts ?? null,
    aliclik_service_date: shipmentSnapshot.aliclik_service_date ?? null,
  };

  // A Fenix guide that is still En ruta is waiting for the courier/motorizado
  // outcome. Do not let a stale drawer skip that operational stage and create
  // another reprogramming before the delivery result has been processed.
  if (shipmentRequiresCourierResult(cur.courier, cur.delivery_status)) {
    return {
      error: `Primero registra el resultado del courier para la guía ${cur.guide_code}. Si Fenix informa “No contesta”, volverá a Pendiente y se habilitará la gestión con el cliente.`,
    };
  }

  // Only pendiente/en_ruta admit gestión. The UI hides this on terminal guides,
  // but enforce it server-side too so a stale drawer can't reactivate a frozen
  // (transferido/entregado/anulado) guide into an active queue.
  if (!isCallable(cur.delivery_status)) {
    return { error: "Este envío ya no admite gestión (entregado, anulado o transferido)." };
  }

  // A confirmed reprogramación must carry its date: it stamps the new Fenix guide
  // and schedules the dispatch. Required so we never mint a guide with a silent
  // "today" fallback (the UI also disables the button until a date is picked).
  if (input.disposition === "confirma" && !input.nextFollowupAt) {
    return { error: "Elige la fecha de reprogramación para confirmar." };
  }
  if (
    input.disposition === "programar" &&
    !isFutureShipmentFollowup(input.nextFollowupAt)
  ) {
    return { error: "Elige una fecha futura para programar la próxima llamada." };
  }

  // Cliente confirma + fecha → generate a NEW Fenix guide automatically and
  // transfer this shipment to it (skip if already transferred). Needs an order
  // name to build the code; without one we fall through to the plain En ruta
  // transition and the operator uses the manual "Generar guía Fenix" section.
  const reprogramProvider = input.reprogramProvider ?? "fenix";
  if (input.disposition === "confirma" && reprogramProvider === "aliclik") {
    const decision = evaluateAliclikReschedule({
      courier: cur.courier,
      attempts: cur.aliclik_attempts,
      serviceDate: cur.aliclik_service_date,
    });
    if (decision.reason === "not_aliclik") {
      return { error: "Esta ya no es una guía Aliclik; corresponde continuar con Fenix." };
    }
    if (decision.reason === "three_attempts") {
      return { error: "Aliclik ya registra 3 intentos o más; solo corresponde continuar con Fenix." };
    }
    if (!decision.eligible && !input.forceAliclik) {
      return { error: aliclikDecisionMessage(decision) };
    }
    if (!decision.eligible && !input.note?.trim()) {
      return { error: "Describe el motivo de la excepción manual para reprogramar con Aliclik." };
    }

    const overrideLabel = decision.eligible ? "" : " (excepción manual)";
    const auditNote = [`Reprogramación Aliclik${overrideLabel}.`, input.note?.trim() || null]
      .filter(Boolean)
      .join(" ");
    const { error: updateError } = await admin
      .from("shipments")
      .update({
        delivery_status: "en_ruta",
        status_category: categoryOf("en_ruta"),
        next_followup_at: input.nextFollowupAt,
        reroute_outcome: decision.eligible ? "reprogramado_aliclik" : "reprogramado_aliclik_manual",
      })
      .eq("id", shipmentId);
    if (updateError) return { error: updateError.message };

    await admin.from("shipment_calls").insert({
      shipment_id: shipmentId,
      store_id: ctx.storeId,
      agent: ctx.userId,
      kind: "reroute",
      new_status: "en_ruta",
      note: auditNote,
      next_followup_at: input.nextFollowupAt,
    });
    revalidatePath("/dashboard/envios");
    return { notice: `Reprogramado en Aliclik${overrideLabel}; se conserva la guía ${cur.guide_code}.` };
  }

  if (input.disposition === "confirma" && reprogramProvider === "fenix" && cur.courier === "aliclik") {
    const currentFenix = await resolveCurrentFenixEligibility(admin, ctx.storeId, cur);
    if ("error" in currentFenix) {
      return { error: `No se pudo validar el stock Fenix: ${currentFenix.error}` };
    }
    if (currentFenix.eligible !== cur.fenix_eligible) {
      await admin.from("shipments").update({ fenix_eligible: currentFenix.eligible }).eq("id", shipmentId);
    }
    if (!currentFenix.eligible) {
      return {
        error: currentFenix.reason === "sin_stock"
          ? `Fenix no tiene stock disponible para este producto en ${cur.city ?? "la ciudad indicada"}.`
          : `Fenix no tiene cobertura en ${cur.city ?? "la ciudad indicada"}.`,
      };
    }
  }

  if (
    input.disposition === "confirma" &&
    reprogramProvider === "fenix" &&
    !cur.fenix_shipment_id
  ) {
    const guideCode = rescheduleGuideCode(cur.order_name, input.nextFollowupAt);
    if (guideCode) {
      // carry the reprogramación date onto the new active guide at insert time
      const spun = await spinOffFenixGuide(admin, ctx, shipmentId, guideCode, {
        childNextFollowupAt: input.nextFollowupAt,
      });
      // A failure here (e.g. the code was already used) is surfaced rather than
      // falling back to En ruta — that would re-activate the old, unusable guide.
      if ("error" in spun) return { error: spun.error };
      // audit the confirma on the new active guide (best-effort, like other logs)
      await admin.from("shipment_calls").insert({
        shipment_id: spun.childId,
        store_id: ctx.storeId,
        agent: ctx.userId,
        kind: "call",
        new_status: "en_ruta",
        note: input.note?.trim() || null,
        next_followup_at: input.nextFollowupAt,
      });
      revalidatePath("/dashboard/envios");
      return { notice: `Confirmado — nueva guía Fenix ${spun.guideCode} (En ruta).` };
    }
  }

  const t = nextShipmentTransition(cur.delivery_status, input.disposition, cur.reroute_attempts ?? 0);
  // when the queue keeps this shipment, carry the agent's next-call date
  const nextFollowup = t.closed ? null : input.nextFollowupAt ?? null;

  const { error: updErr } = await admin
    .from("shipments")
    .update({
      delivery_status: t.status,
      status_category: categoryOf(t.status),
      reroute_attempts: t.attempts,
      next_followup_at: nextFollowup,
      ...(t.deliveredSource ? { delivered_source: t.deliveredSource } : {}),
      // closing drops the claim so the queue frees it
      ...(t.closed ? { claimed_by: null, claimed_at: null } : {}),
    })
    .eq("id", shipmentId);
  if (updErr) return { error: updErr.message };

  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "call",
    // Programming a call does not enter a new delivery state. Keeping this
    // null also prevents statusSince() from treating it as a state transition.
    new_status: input.disposition === "programar" ? null : t.status,
    note: input.note?.trim() || null,
    next_followup_at: nextFollowup,
  });

  // Guía Fénix entregada → descuenta 1 del inventario (idempotente, best-effort).
  if (t.status === "entregado") {
    await consumeFenixStockOnDelivery(admin, shipmentId).catch(() => {});
  }

  revalidatePath("/dashboard/envios");
  let notice: string;
  if (input.disposition === "programar") {
    const date = new Date(nextFollowup!).toLocaleDateString("es-PE", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });
    notice = `Llamada programada para el ${date}; los intentos no cambiaron.`;
  } else if (t.status === "en_ruta") {
    notice = "Registrado — En ruta (Fenix).";
  } else if (t.status === "entregado") {
    notice = "Registrado — Entregado.";
  } else if (t.status === "anulado") {
    notice = "Registrado — Anulado.";
  } else {
    notice = `Registrado — ${attemptLabel(t.attempts)}.`;
  }
  return { notice };
}

function aliclikDecisionMessage(
  decision: ReturnType<typeof evaluateAliclikReschedule>,
): string {
  if (decision.reason === "three_attempts") {
    return "Aliclik ya registra 3 intentos o más; solo corresponde continuar con Fenix.";
  }
  if (decision.reason === "outside_week") {
    return `La fecha de Aliclik está fuera de la ventana ${decision.cutoffDate}–${decision.today}. Continúa con Fenix o usa la excepción manual.`;
  }
  if (decision.reason === "missing_attempts") {
    return "El Excel no informó NRO. INTENTOS. Continúa con Fenix o usa la excepción manual.";
  }
  return "El Excel no informó una fecha operativa válida. Continúa con Fenix o usa la excepción manual.";
}

export interface ShipmentAddressInput {
  address: string;
  reference?: string | null;
  district: string;
  city: string;
  region: string;
  latitude: number;
  longitude: number;
}

/** Update the delivery destination in Shopify first, then persist an override
 * on the shipment so later Aliclik Excel imports cannot revert it. */
export async function updateShipmentDeliveryAddress(
  shipmentId: string,
  input: ShipmentAddressInput,
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };

  const address = input.address.trim();
  const reference = input.reference?.trim() || null;
  const district = input.district.trim();
  const cityLabel = input.city.trim();
  const region = input.region.trim();
  if (!address || !district || !cityLabel || !region) {
    return { error: "Dirección, distrito, ciudad/provincia y departamento son obligatorios." };
  }
  if (address.length > 500 || (reference?.length ?? 0) > 500) {
    return { error: "La dirección o referencia es demasiado larga." };
  }
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
    return { error: "La latitud debe estar entre -90 y 90." };
  }
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    return { error: "La longitud debe estar entre -180 y 180." };
  }

  const admin = createAdminSupabase();
  const { data: shipment } = await admin
    .from("shipments")
    .select("id,store_id,order_id,customer_name,customer_phone,product,fenix_shipment_id")
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return { error: "Envío no encontrado." };
  const current = shipment as {
    store_id: string;
    order_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    product: string | null;
    fenix_shipment_id: string | null;
  };

  type LinkedOrderForAddress = {
    shopify_order_id: string | null;
    line_items: { title?: string | null; sku?: string | null }[] | null;
  };
  let order: LinkedOrderForAddress | null = null;
  if (current.order_id) {
    const { data } = await admin
      .from("orders")
      .select("shopify_order_id,line_items")
      .eq("id", current.order_id)
      .maybeSingle();
    order = data as LinkedOrderForAddress | null;
  }

  const shopifyOrderId = order?.shopify_order_id;
  const isRealShopifyOrder = !!shopifyOrderId && !shopifyOrderId.startsWith("manual-");
  if (isRealShopifyOrder) {
    const creds = await getStoreCreds(current.store_id);
    if (!creds?.shopify_token) return { error: "La tienda no tiene Shopify conectado." };
    try {
      await updateOrderShippingAddress({
        domain: creds.shopify_domain,
        token: creds.shopify_token,
        orderGid: `gid://shopify/Order/${shopifyOrderId}`,
        address: {
          name: current.customer_name,
          phone: current.customer_phone,
          address1: address,
          address2: reference,
          city: district,
          province: region,
          country: "Peru",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: message.includes("Access denied") || message.includes("write_orders")
          ? "Shopify no autorizó el cambio. La tienda necesita el permiso write_orders."
          : `Shopify rechazó la dirección: ${message}`,
      };
    }
  }

  const combinedCity = normalizeCity([district, cityLabel, region].join(" "));
  const city = isFenixCity(combinedCity) ? combinedCity : normalizeCity(cityLabel || district);
  const { data: store } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", current.store_id)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  let fenixEligible = false;
  if (orgId) {
    const { data: stock } = await admin
      .from("fenix_stock")
      .select("city,product,sku,quantity")
      .eq("org_id", orgId);
    fenixEligible = evaluateFenix(
      { city, product: current.product },
      (stock as FenixStockRow[]) ?? [],
      order?.line_items ?? undefined,
    ).eligible;
  }

  const update = {
    delivery_address: address,
    delivery_reference: reference,
    district,
    province: cityLabel,
    city,
    region,
    latitude: input.latitude,
    longitude: input.longitude,
    address_override: true,
    address_updated_at: new Date().toISOString(),
    address_updated_by: ctx.userId,
    fenix_eligible: fenixEligible,
  };
  const targetIds = [shipmentId, current.fenix_shipment_id].filter((id): id is string => !!id);
  let updateResult = await admin.from("shipments").update(update).in("id", targetIds);
  if (
    updateResult.error &&
    (updateResult.error.code === "PGRST204" ||
      updateResult.error.code === "42703" ||
      updateResult.error.message.toLowerCase().includes("province"))
  ) {
    const { province: _province, ...legacyUpdate } = update;
    updateResult = await admin.from("shipments").update(legacyUpdate).in("id", targetIds);
  }
  const updateError = updateResult.error;
  if (updateError) return { error: updateError.message };

  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: current.store_id,
    agent: ctx.userId,
    kind: "address_change",
    note: `Dirección actualizada: ${address}${reference ? ` · Ref.: ${reference}` : ""} · ${input.latitude}, ${input.longitude}`,
  });
  revalidatePath("/dashboard/envios");
  return {
    notice: isRealShopifyOrder
      ? "Dirección y coordenadas actualizadas en Shopify y en el envío."
      : "Dirección y coordenadas actualizadas en el envío; no había un pedido Shopify vinculado.",
  };
}

/** Register one row/result from the Fenix courier report. Operators choose the
 * courier outcome; the application owns the internal status transition. */
export async function registerCourierReportResult(
  shipmentId: string,
  input: {
    result: CourierReportResult;
    deliveryDate?: string | null;
    note?: string | null;
  },
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a esta guía." };

  const definition = COURIER_REPORT_RESULTS.find((item) => item.code === input.result);
  if (!definition) return { error: "Resultado del courier inválido." };

  const note = input.note?.trim() || null;
  if (definition.requiresNote && !note) {
    return { error: "Describe el motivo informado por Fenix para anular la guía." };
  }

  let deliveryDate: string | null = null;
  if (definition.requiresDate) {
    if (!input.deliveryDate) return { error: "Elige la nueva fecha de entrega." };
    const parsed = new Date(input.deliveryDate);
    if (Number.isNaN(parsed.getTime())) return { error: "La fecha de entrega no es válida." };
    deliveryDate = parsed.toISOString();
  }

  const admin = createAdminSupabase();
  const { data: shipment } = await admin
    .from("shipments")
    .select("id,courier,guide_code,delivery_status,next_followup_at,fenix_shipment_id")
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return { error: "Guía no encontrada." };
  const current = shipment as {
    courier: string;
    guide_code: string;
    delivery_status: string;
    next_followup_at: string | null;
    fenix_shipment_id: string | null;
  };
  if (current.courier !== "fenix") {
    return { error: "Este flujo corresponde al reporte Fenix. Aliclik se actualiza con su Excel diario." };
  }
  if (current.delivery_status === "transferido") {
    return {
      error: current.fenix_shipment_id
        ? "Esta guía ya fue reemplazada. Registra el resultado en su nueva guía Fenix."
        : "Una guía transferida no admite resultados; abre la guía Fenix activa.",
    };
  }

  const transition = courierReportTransition(input.result);
  const nextFollowupAt =
    input.result === "reprogramado"
      ? deliveryDate
      : transition.clearScheduledDate
        ? null
        : current.next_followup_at;

  const { error } = await admin
    .from("shipments")
    .update({
      delivery_status: transition.status,
      status_category: categoryOf(transition.status),
      reroute_outcome: transition.outcome,
      next_followup_at: nextFollowupAt,
      delivered_source: transition.deliveredSource,
      claimed_by: null,
      claimed_at: null,
    })
    .eq("id", shipmentId);
  if (error) return { error: error.message };

  const auditNote = [
    `Resultado Fenix: ${definition.label}.`,
    note,
  ].filter(Boolean).join(" ");
  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "courier_report",
    new_status: transition.status,
    note: auditNote,
    // Only a courier reprogramming creates a new delivery date. `en_ruta`
    // preserves the shipment's existing date but does not pretend the report
    // changed it in this history entry.
    next_followup_at: input.result === "reprogramado" ? deliveryDate : null,
  });

  if (transition.status === "entregado") {
    await consumeFenixStockOnDelivery(admin, shipmentId).catch(() => {});
  }

  revalidatePath("/dashboard/envios");
  return {
    notice: `Guía ${current.guide_code}: ${definition.label} → ${definition.effect}`,
  };
}

/** Manually set a delivery status (e.g. correcting an import). Logged. */
export async function setShipmentStatus(
  shipmentId: string,
  status: string,
  note?: string,
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso." };
  if (!isValidStatus(status)) return { error: "Estado inválido." };
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("shipments")
    .update({ delivery_status: status, status_category: categoryOf(status) })
    .eq("id", shipmentId);
  if (error) return { error: error.message };
  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "state_change",
    new_status: status,
    note: note?.trim() || null,
  });
  if (status === "entregado") {
    await consumeFenixStockOnDelivery(admin, shipmentId).catch(() => {});
  }
  revalidatePath("/dashboard/envios");
  return { notice: "Estado actualizado." };
}

/**
 * Spin off a Fenix sub-guide from a shipment: insert a second shipments row
 * (courier='fenix', En ruta) carrying the order snapshot, then freeze the source
 * shipment as `transferido` (the Fenix guide is the active shipment going
 * forward) and log the hand-off. Shared by the manual `createFenixGuide` and the
 * automatic confirma flow in `registerRerouteCall`. `guideCode` is normalized
 * (trim + uppercase). Returns the new child id + code, or an error (missing code,
 * source already transferred, or a unique violation = code already used in Fenix).
 */
async function spinOffFenixGuide(
  admin: SupabaseClient,
  ctx: { userId: string; storeId: string },
  shipmentId: string,
  guideCode: string,
  opts: { childNextFollowupAt?: string | null } = {},
): Promise<{ error: string } | { childId: string; guideCode: string }> {
  const code = guideCode.trim().toUpperCase();
  if (!code) return { error: "Ingresa el número de guía de Fenix." };

  const fetchParent = (columns: string) => admin
    .from("shipments")
    .select(columns)
    .eq("id", shipmentId)
    .maybeSingle();
  let parentResult = await fetchParent(
    "courier,delivery_status,store_id,order_id,order_name,customer_name,customer_phone,product,district,province,city,region,delivery_address,delivery_reference,latitude,longitude,address_override,address_updated_at,address_updated_by,fenix_shipment_id",
  );
  if (parentResult.error) {
    parentResult = await fetchParent(
      "courier,delivery_status,store_id,order_id,order_name,customer_name,customer_phone,product,district,city,region,fenix_shipment_id",
    );
  }
  const parent = parentResult.data;
  if (!parent) return { error: "No encontrado." };
  const source = parent as unknown as {
    courier: string;
    delivery_status: string;
    fenix_shipment_id: string | null;
  };
  if (shipmentRequiresCourierResult(source.courier, source.delivery_status)) {
    return { error: "Primero registra el resultado del courier antes de crear otra guía Fenix." };
  }
  if (source.fenix_shipment_id) {
    return { error: "Este envío ya tiene una guía Fenix." };
  }

  const p = parent as unknown as Record<string, unknown>;
  const { data: child, error: insErr } = await admin
    .from("shipments")
    .insert({
      courier: "fenix",
      guide_code: code,
      store_id: p.store_id,
      order_id: p.order_id,
      matched: !!p.order_id,
      match_method: "manual",
      order_name: p.order_name,
      customer_name: p.customer_name,
      customer_phone: p.customer_phone,
      product: p.product,
      district: p.district,
      province: p.province,
      city: p.city,
      region: p.region,
      delivery_address: p.delivery_address,
      delivery_reference: p.delivery_reference,
      latitude: p.latitude,
      longitude: p.longitude,
      address_override: p.address_override,
      address_updated_at: p.address_updated_at,
      address_updated_by: p.address_updated_by,
      delivery_status: "en_ruta",
      status_category: "in_route",
      next_followup_at: opts.childNextFollowupAt ?? null,
    })
    .select("id")
    .single();
  if (insErr || !child) {
    // unique(courier, guide_code) violation → this code was already used in Fenix
    const dup = (insErr as { code?: string } | null)?.code === "23505";
    return {
      error: dup
        ? `Ya existe una guía Fenix con el código ${code}. Elige otra fecha de reprogramación.`
        : (insErr?.message ?? "No se pudo crear la guía Fenix."),
    };
  }

  // Transfer the source guide atomically: the UPDATE only matches while
  // fenix_shipment_id is still null, so two concurrent spin-offs can't both
  // transfer the same parent (each would otherwise leave an orphan En ruta
  // child). If we lost the race, roll back the child we just inserted.
  const { data: transferred, error: updErr } = await admin
    .from("shipments")
    .update({
      fenix_shipment_id: child.id,
      delivery_status: "transferido",
      status_category: "transferred",
      // the source guide is now terminal — free its claim so the queue releases it
      claimed_by: null,
      claimed_at: null,
    })
    .eq("id", shipmentId)
    .is("fenix_shipment_id", null)
    .select("id")
    .maybeSingle();
  if (updErr || !transferred) {
    await admin.from("shipments").delete().eq("id", child.id);
    return { error: "Este envío acaba de recibir otra guía Fenix. Actualiza y reintenta." };
  }
  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "reroute",
    note: `Guía Fenix creada: ${code}`,
  });

  return { childId: child.id as string, guideCode: code };
}

/**
 * Create a Fenix sub-guide for a re-routed shipment (manual entry of the guide
 * number generated in Fenix's own system). Inserts a second shipments row
 * (courier='fenix') and links the parent. API-ready: a later phase swaps the
 * manual `guideCode` for createFenixGuideViaApi() without changing this shape.
 */
export async function createFenixGuide(
  shipmentId: string,
  input: { guideCode: string; nextFollowupAt?: string | null },
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso." };
  const admin = createAdminSupabase();

  // carry the reprogramación date onto the new Fenix guide (same as the
  // automatic confirma flow) so it isn't left En ruta without a dispatch date
  const r = await spinOffFenixGuide(admin, ctx, shipmentId, input.guideCode, {
    childNextFollowupAt: input.nextFollowupAt ?? null,
  });
  if ("error" in r) return { error: r.error };

  revalidatePath("/dashboard/envios");
  return { notice: `Guía Fenix ${r.guideCode} creada.` };
}

/**
 * Resolve an unmatched shipment in the "Por revisar" queue: either link it to an
 * order (mark it matched) or confirm it has no order (Kenku/manual), which drops
 * it from the queue via match_method='dismissed' without inventing a link.
 */
export async function resolveShipmentMatch(
  shipmentId: string,
  input: { orderId?: string | null },
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const admin = createAdminSupabase();
  const orderId = input.orderId ?? null;

  if (orderId) {
    // verify the order is in an accessible store + resolve its store_id (RLS)
    const sb = await createServerSupabase();
    const { data: order } = await sb
      .from("orders")
      .select("id,store_id,name")
      .eq("id", orderId)
      .maybeSingle();
    if (!order) return { error: "Pedido inválido o sin acceso." };
    const o = order as { store_id: string; name: string | null };
    const { error } = await admin
      .from("shipments")
      .update({
        order_id: orderId,
        store_id: o.store_id,
        order_name: o.name,
        matched: true,
        match_method: "manual",
      })
      .eq("id", shipmentId);
    if (error) return { error: error.message };
    revalidatePath("/dashboard/envios");
    return { notice: "Pedido vinculado." };
  }

  // confirmed: no order (Kenku/manual) — keep the snapshot, drop it from review
  const { error } = await admin
    .from("shipments")
    .update({ match_method: "dismissed" })
    .eq("id", shipmentId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/envios");
  return { notice: "Marcado sin pedido." };
}

export interface ShopifyOrderCandidate {
  gid: string;
  storeId: string;
  name: string | null;
  customer_phone: string | null;
  created_at: string | null;
}

/**
 * On-demand live search against Shopify (NOT the local, tag:kapso-scoped
 * `orders` table) — a fallback for orders the reconciliation sync never pulled
 * in, e.g. a real order referenced in an Aliclik guide that isn't tag:kapso.
 *
 * A guide's own `store_id` isn't a reliable hint for which store to search:
 * the Aliclik guide pool is shared across stores, and an unmatched guide just
 * carries whatever store the import batch defaulted to. Instead route by the
 * query itself — `#KP…` → Kenku, `#AUR…` → Aurela, otherwise every connected
 * store (see `pickStoresForOrderQuery`) — and search all of those.
 */
export async function searchShopifyOrdersLive(
  shipmentId: string,
  query: string,
): Promise<ShopifyOrderCandidate[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return [];
  const stores = await getAccessibleStores();
  const targets = pickStoresForOrderQuery(q, stores);
  const perStore = await Promise.all(
    targets.map(async (store) => {
      const creds = await getStoreCreds(store.id);
      if (!creds?.shopify_token) return [];
      try {
        const orders = await searchOrdersLive({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId: store.id,
          query: q,
          first: 10,
        });
        return orders.map((o) => ({
          gid: (o.raw as { id?: string } | undefined)?.id ?? `gid://shopify/Order/${o.shopify_order_id}`,
          storeId: store.id,
          name: o.name,
          customer_phone: o.customer_phone ?? null,
          created_at: o.created_at,
        }));
      } catch {
        return []; // missing scope / API error on this store → skip it
      }
    }),
  );
  return perStore.flat().slice(0, 10);
}

/**
 * Capture one Shopify order on-demand (by gid, from the live-search fallback
 * above) and link it to the shipment. Preserves the order's real tags — unlike
 * the COD-recovery precedent in lib/leads-ingest.ts, this order may genuinely
 * not be Kapso-attributed, so we must not force the `kapso` tag onto it.
 * `storeId` is the store the candidate was found in (from searchShopifyOrdersLive),
 * which may differ from the shipment's current store — resolveShipmentMatch
 * below re-homes the shipment to it, same as a local-search manual link would.
 */
export async function linkShipmentToShopifyOrder(
  shipmentId: string,
  orderGid: string,
  storeId: string,
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const sb = await createServerSupabase();
  const { data: store } = await sb.from("stores").select("id").eq("id", storeId).maybeSingle();
  if (!store) return { error: "Tienda inválida o sin acceso." };
  const creds = await getStoreCreds(storeId);
  if (!creds?.shopify_token) return { error: "La tienda no tiene Shopify conectado." };

  let order;
  try {
    order = await fetchOrderById({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      storeId,
      orderGid,
    });
  } catch {
    return { error: "No se pudo obtener el pedido de Shopify." };
  }
  if (!order) return { error: "Pedido no encontrado en Shopify." };

  const admin = createAdminSupabase();
  const { error: upsertErr } = await admin
    .from("orders")
    .upsert([order], { onConflict: "store_id,shopify_order_id" });
  if (upsertErr) return { error: upsertErr.message };

  const { data: row } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", storeId)
    .eq("shopify_order_id", order.shopify_order_id)
    .maybeSingle();
  const orderId = (row as { id: string } | null)?.id ?? null;
  if (!orderId) return { error: "No se pudo vincular el pedido." };

  return resolveShipmentMatch(shipmentId, { orderId });
}

/**
 * Process one chunk of the "Revisión" queue against live Shopify: for each
 * unchecked unmatched shipment, search (routed by store like the live picker)
 * and — only when exactly one candidate's phone cross-validates the shipment's
 * own phone (NOTA reference + same phone) — LINK it directly to that Shopify
 * order (falling back to a saved suggestion only if the link's fetch/upsert
 * fails). Admin-gated: it fans out many live Shopify calls and writes across
 * potentially hundreds of shipments in one org, same category as
 * upsertFenixStock's bulk-maintenance gate.
 */
export async function processSuggestionBatch(): Promise<
  { error: string } | BatchResult
> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: mem } = await sb.from("memberships").select("org_id,role");
  const adminOrg = ((mem as { org_id: string; role: string }[]) ?? []).find(
    (m) => m.role === "owner" || m.role === "admin",
  );
  if (!adminOrg) return { error: "Solo un administrador puede ejecutar el emparejamiento automático." };

  const stores = await getAccessibleStores();
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return { processed: 0, linked: 0, done: true };
  const result = await runSuggestionBatch(createAdminSupabase(), storeIds, stores, SUGGESTION_BATCH_SIZE);
  if (result.linked > 0) revalidatePath("/dashboard/envios");
  return result;
}

/**
 * Clear a pending suggestion without dismissing the shipment — it stays in
 * Revisión, still searchable manually via OrderLinkPicker underneath.
 */
export async function clearShipmentSuggestion(shipmentId: string): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("shipments")
    .update({ suggested_order_gid: null, suggested_store_id: null, suggested_order_name: null })
    .eq("id", shipmentId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/envios");
  return { notice: "Sugerencia descartada." };
}

/**
 * Search a store's Shopify catalog to populate the Fenix-stock product picker.
 * RLS-authorized to the store; the store is only the catalog source (Fenix stock
 * itself stays org-scoped). Degrades to [] if the store lacks read_products.
 */
export async function searchStockProducts(
  storeId: string,
  query: string,
): Promise<ProductVariantResult[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  // RLS check: can the caller see this store?
  const { data: store } = await sb.from("stores").select("id").eq("id", storeId).maybeSingle();
  if (!store) return [];
  const creds = await getStoreCreds(storeId);
  if (!creds?.shopify_token) return [];
  try {
    return await searchProductVariants({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      query,
      first: 20,
    });
  } catch {
    return []; // read_products not granted → picker degrades to a free-text product
  }
}

// ── Fenix stock (admin) ──────────────────────────────────────────────────────

/** Upsert a Fenix stock row for the caller's org. RLS gates the write to admins. */
export async function upsertFenixStock(input: {
  city: string;
  product: string;
  quantity: number;
  sku?: string | null;
}): Promise<ShipmentActionState> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  // resolve the caller's admin org (first one)
  const { data: mem } = await sb.from("memberships").select("org_id,role");
  const adminOrg = ((mem as { org_id: string; role: string }[]) ?? []).find(
    (m) => m.role === "owner" || m.role === "admin",
  );
  if (!adminOrg) return { error: "Solo un administrador puede editar el stock." };

  const city = input.city.trim().toLowerCase();
  const product = input.product.trim();
  if (!city || !product) return { error: "Ciudad y producto son obligatorios." };
  const targetQty = Math.max(0, Math.trunc(input.quantity));

  const admin = createAdminSupabase();
  // Saldo previo (para saber si es alta = entrada, o edición = ajuste).
  const { data: prev } = await admin
    .from("fenix_stock")
    .select("id, quantity")
    .eq("org_id", adminOrg.org_id)
    .eq("city", city)
    .eq("product", product)
    .maybeSingle();
  const isNew = !prev;
  const oldQty = (prev as { quantity: number } | null)?.quantity ?? 0;

  const { data: row, error } = await admin
    .from("fenix_stock")
    .upsert(
      {
        org_id: adminOrg.org_id,
        city,
        product,
        sku: input.sku?.trim() || null,
        quantity: targetQty,
        updated_by: user.id,
      },
      { onConflict: "org_id,city,product" },
    )
    .select("id")
    .single();
  if (error || !row) return { error: error?.message ?? "No se pudo guardar." };

  // Kardex: alta con cantidad → entrada; editar la cantidad → ajuste. El saldo
  // ya quedó en targetQty por el upsert, así que el movimiento lo registra con
  // ese balance_after (no vuelve a aplicar el delta).
  const delta = targetQty - oldQty;
  if (delta !== 0) {
    await admin.from("fenix_stock_movements").insert({
      org_id: adminOrg.org_id,
      fenix_stock_id: (row as { id: string }).id,
      city,
      product,
      kind: isNew ? "entrada" : "ajuste",
      delta,
      balance_after: targetQty,
      note: isNew ? "Alta de producto" : "Ajuste desde el formulario de stock",
      created_by: user.id,
    });
  }
  const sync = await recomputeFenixEligibility();
  revalidatePath("/dashboard/envios/stock");
  revalidatePath("/dashboard/envios");
  return "error" in sync
    ? { notice: `Stock actualizado. No se pudo sincronizar las guías: ${sync.error}` }
    : { notice: `Stock actualizado — ${sync.updated} guías sincronizadas.` };
}

/** Delete a Fenix stock row (admin). */
export async function deleteFenixStock(id: string): Promise<ShipmentActionState> {
  const sb = await createServerSupabase();
  const { error } = await sb.from("fenix_stock").delete().eq("id", id);
  if (error) return { error: error.message };
  const sync = await recomputeFenixEligibility();
  revalidatePath("/dashboard/envios/stock");
  revalidatePath("/dashboard/envios");
  return "error" in sync
    ? { notice: `Stock eliminado. No se pudo sincronizar las guías: ${sync.error}` }
    : { notice: `Stock eliminado — ${sync.updated} guías sincronizadas.` };
}

/**
 * Registra un movimiento manual de kardex sobre un renglón de stock (admin):
 *   entrada       → suma `quantity` unidades.
 *   salida_merma  → resta `quantity` unidades (daño/pérdida), motivo obligatorio.
 *   ajuste        → `quantity` es el CONTEO REAL de Fénix; el delta se calcula
 *                   solo para llevar el saldo a ese número.
 * Actualiza el saldo + inserta el historial (recordStockMovement) y re-sincroniza
 * la elegibilidad de las guías.
 */
export async function recordFenixStockMovement(input: {
  stockId: string;
  kind: Exclude<StockMovementKind, "salida_entrega">;
  quantity: number;
  note?: string | null;
}): Promise<ShipmentActionState> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: mem } = await sb.from("memberships").select("org_id,role");
  const adminOrgs = ((mem as { org_id: string; role: string }[]) ?? [])
    .filter((m) => m.role === "owner" || m.role === "admin")
    .map((m) => m.org_id);
  if (!adminOrgs.length) return { error: "Solo un administrador puede mover el stock." };

  const admin = createAdminSupabase();
  const { data: stock } = await admin
    .from("fenix_stock")
    .select("id, org_id, city, product, quantity")
    .eq("id", input.stockId)
    .maybeSingle();
  const s = stock as { id: string; org_id: string; city: string; product: string; quantity: number } | null;
  if (!s || !adminOrgs.includes(s.org_id)) return { error: "Renglón de stock no encontrado o sin acceso." };

  const qty = Math.max(0, Math.trunc(input.quantity));
  const note = input.note?.trim() || null;
  let delta: number;
  if (input.kind === "entrada") delta = qty;
  else if (input.kind === "salida_merma") {
    if (qty <= 0) return { error: "Indica cuántas unidades salieron." };
    if (!note) return { error: "La merma/pérdida necesita un motivo." };
    delta = -qty;
  } else {
    // ajuste: qty es el conteo real de Fénix
    delta = ajusteDelta(s.quantity, qty);
  }
  if (delta === 0) return { notice: "El saldo ya coincide; no se registró movimiento." };

  const balance = await recordStockMovement(admin, {
    stockId: s.id,
    orgId: s.org_id,
    city: s.city,
    product: s.product,
    kind: input.kind,
    delta,
    note,
    createdBy: user.id,
  });
  if (balance === null) return { error: "No se pudo registrar el movimiento." };

  const sync = await recomputeFenixEligibility();
  revalidatePath("/dashboard/envios/stock");
  revalidatePath("/dashboard/envios");
  const label = STOCK_MOVEMENT_LABEL[input.kind];
  return "error" in sync
    ? { notice: `${label} registrada. Saldo: ${balance}. (No se sincronizaron las guías: ${sync.error})` }
    : { notice: `${label} registrada — saldo ${balance}, ${sync.updated} guías sincronizadas.` };
}

/** Historial de movimientos (kardex) de un renglón de stock, con el nombre de
 *  quien lo registró. RLS-scoped (lectura para miembros de la org). */
export async function getFenixStockMovements(
  stockId: string,
): Promise<(StockMovementRow & { by: string | null })[]> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("fenix_stock_movements")
    .select("id, kind, delta, balance_after, note, shipment_id, created_by, created_at")
    .eq("fenix_stock_id", stockId)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data as StockMovementRow[]) ?? [];
  const userIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const names = userIds.length ? await resolveEmails(userIds) : new Map<string, string>();
  return rows.map((r) => ({ ...r, by: r.created_by ? names.get(r.created_by) ?? null : null }));
}

/**
 * Recompute `fenix_eligible` for every pending shipment against the current
 * stock. Eligibility is normally set at import time, so this applies stock
 * edits (and any change to the matching logic) to guides already in the queue
 * without waiting for the next Aliclik import. Admin-gated, same as stock edits.
 */
export async function recomputeFenixEligibility(): Promise<
  { error: string } | { notice: string; updated: number }
> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: mem } = await sb.from("memberships").select("org_id,role");
  const adminOrg = ((mem as { org_id: string; role: string }[]) ?? []).find(
    (m) => m.role === "owner" || m.role === "admin",
  );
  if (!adminOrg) return { error: "Solo un administrador puede recalcular la elegibilidad." };

  const stores = (await getAccessibleStores()).filter((s) => s.org_id === adminOrg.org_id);
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return { notice: "Sin envíos.", updated: 0 };

  const admin = createAdminSupabase();
  const { data: stock, error: stockError } = await admin
    .from("fenix_stock")
    .select("city,product,sku,quantity")
    .eq("org_id", adminOrg.org_id);
  if (stockError) return { error: stockError.message };
  const stockRows = (stock as FenixStockRow[]) ?? [];

  // Only pending guides carry eligibility; re-evaluate each and flip the ones
  // whose stored flag no longer matches. Paginate past Supabase's 1,000-row
  // response cap so a large queue is never only partially synchronized.
  type PendingShipment = {
    id: string;
    city: string | null;
    product: string | null;
    order_id: string | null;
    fenix_eligible: boolean;
  };
  const shipments: PendingShipment[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data: rows, error: rowsError } = await admin
      .from("shipments")
      .select("id,city,product,order_id,fenix_eligible")
      .in("store_id", storeIds)
      .eq("status_category", "pending")
      .range(from, from + pageSize - 1);
    if (rowsError) return { error: rowsError.message };
    const page = (rows as PendingShipment[]) ?? [];
    shipments.push(...page);
    if (page.length < pageSize) break;
  }

  // Pull the linked orders' line items so eligibility can match against the
  // Shopify catalog (title + SKU) — the same source the stock sheet is keyed
  // on — instead of the Aliclik report's free-text product.
  const orderIds = Array.from(new Set(shipments.map((s) => s.order_id).filter((v): v is string => !!v)));
  const productsByOrder = new Map<string, { title?: string | null; sku?: string | null }[]>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data: orders, error: ordersError } = await admin
      .from("orders")
      .select("id,line_items")
      .in("id", orderIds.slice(i, i + 300));
    if (ordersError) return { error: ordersError.message };
    for (const o of (orders as { id: string; line_items: { title?: string | null; sku?: string | null }[] | null }[]) ?? []) {
      productsByOrder.set(
        o.id,
        (o.line_items ?? []).map((li) => ({ title: li.title ?? null, sku: li.sku ?? null })),
      );
    }
  }

  const toEligible: string[] = [];
  const toIneligible: string[] = [];
  for (const s of shipments) {
    const orderProducts = s.order_id ? productsByOrder.get(s.order_id) : undefined;
    const eligible = evaluateFenix(s, stockRows, orderProducts).eligible;
    if (eligible !== s.fenix_eligible) {
      (eligible ? toEligible : toIneligible).push(s.id);
    }
  }

  // Update in bounded groups instead of one network round-trip per guide.
  for (const [eligible, ids] of [
    [true, toEligible],
    [false, toIneligible],
  ] as const) {
    for (let i = 0; i < ids.length; i += 150) {
      const { error: updateError } = await admin
        .from("shipments")
        .update({ fenix_eligible: eligible })
        .in("id", ids.slice(i, i + 150));
      if (updateError) return { error: updateError.message };
    }
  }
  const updated = toEligible.length + toIneligible.length;
  revalidatePath("/dashboard/envios");
  return { notice: `Elegibilidad recalculada — ${updated} guías actualizadas.`, updated };
}
