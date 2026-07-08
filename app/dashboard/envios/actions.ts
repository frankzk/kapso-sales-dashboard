"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import {
  getShipmentWithCalls,
  searchOrdersForLink,
  searchShipmentsQuery,
  type OrderLinkCandidate,
} from "@/lib/shipments-access";
import {
  CLAIM_TTL_MINUTES,
  attemptLabel,
  categoryOf,
  isValidStatus,
  nextShipmentTransition,
  type RerouteDisposition,
} from "@/lib/shipments";
import { getStoreCreds } from "@/lib/ingest";
import { getAccessibleStores } from "@/lib/access";
import {
  fetchOrderById,
  pickStoresForOrderQuery,
  searchOrdersLive,
  searchProductVariants,
  type ProductVariantResult,
} from "@/lib/shopify";
import { runSuggestionBatch, SUGGESTION_BATCH_SIZE, type BatchResult } from "@/lib/shipment-auto-match";
import { evaluateFenix, type FenixStockRow } from "@/lib/fenix";
import type { ShipmentCallRow, ShipmentRow } from "@/lib/types";

export interface ShipmentActionState {
  error?: string;
  notice?: string;
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
): Promise<{ shipment: ShipmentRow; calls: ShipmentCallRow[] } | { error: string }> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const detail = await getShipmentWithCalls(shipmentId);
  if (!detail) return { error: "No encontrado." };
  const ids = [...new Set(detail.calls.map((c) => c.agent).filter(Boolean))] as string[];
  if (ids.length) {
    const admin = createAdminSupabase();
    await Promise.all(ids.map((id) => resolveAgentName(id, admin)));
  }
  const calls = detail.calls.map((c) => ({
    ...c,
    agent_name: c.agent ? (agentNameCache.get(c.agent) ?? null) : null,
  }));
  return { shipment: detail.shipment, calls };
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
  revalidatePath("/dashboard/envios");
  return { notice: "Envío tomado." };
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
  revalidatePath("/dashboard/envios");
  return { notice: "Liberado." };
}

/**
 * Register a gestión call. Reads the current state, applies the transition
 * (confirma→En ruta / no_contesta→siguiente intento o Anulado / cancela→Anulado
 * / entregado→Entregado por Fenix), updates the shipment and logs the call.
 */
export async function registerRerouteCall(
  shipmentId: string,
  input: { disposition: RerouteDisposition; note?: string; nextFollowupAt?: string | null },
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso a este envío." };
  const admin = createAdminSupabase();

  const { data: ship } = await admin
    .from("shipments")
    .select("id,delivery_status,reroute_attempts")
    .eq("id", shipmentId)
    .maybeSingle();
  if (!ship) return { error: "No encontrado." };
  const cur = ship as { delivery_status: string; reroute_attempts: number | null };

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
    new_status: t.status,
    note: input.note?.trim() || null,
    next_followup_at: nextFollowup,
  });

  revalidatePath("/dashboard/envios");
  const notice =
    t.status === "en_ruta"
      ? "Registrado — En ruta (Fenix)."
      : t.status === "entregado"
        ? "Registrado — Entregado."
        : t.status === "anulado"
          ? "Registrado — Anulado."
          : `Registrado — ${attemptLabel(t.attempts)}.`;
  return { notice };
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
  revalidatePath("/dashboard/envios");
  return { notice: "Estado actualizado." };
}

/**
 * Create a Fenix sub-guide for a re-routed shipment (manual entry of the guide
 * number generated in Fenix's own system). Inserts a second shipments row
 * (courier='fenix') and links the parent. API-ready: a later phase swaps the
 * manual `guideCode` for createFenixGuideViaApi() without changing this shape.
 */
export async function createFenixGuide(
  shipmentId: string,
  input: { guideCode: string },
): Promise<ShipmentActionState> {
  const ctx = await authorizeShipment(shipmentId);
  if (!ctx) return { error: "Sin acceso." };
  const guideCode = input.guideCode.trim().toUpperCase();
  if (!guideCode) return { error: "Ingresa el número de guía de Fenix." };
  const admin = createAdminSupabase();

  const { data: parent } = await admin
    .from("shipments")
    .select(
      "store_id,order_id,order_name,customer_name,customer_phone,product,district,city,region,fenix_shipment_id",
    )
    .eq("id", shipmentId)
    .maybeSingle();
  if (!parent) return { error: "No encontrado." };
  if ((parent as { fenix_shipment_id: string | null }).fenix_shipment_id) {
    return { error: "Este envío ya tiene una guía Fenix." };
  }

  const p = parent as Record<string, unknown>;
  const { data: child, error: insErr } = await admin
    .from("shipments")
    .insert({
      courier: "fenix",
      guide_code: guideCode,
      store_id: p.store_id,
      order_id: p.order_id,
      matched: !!p.order_id,
      match_method: "manual",
      order_name: p.order_name,
      customer_name: p.customer_name,
      customer_phone: p.customer_phone,
      product: p.product,
      district: p.district,
      city: p.city,
      region: p.region,
      delivery_status: "en_ruta",
      status_category: "in_route",
    })
    .select("id")
    .single();
  if (insErr || !child) {
    // unique violation → guide code already used
    return { error: insErr?.message ?? "No se pudo crear la guía Fenix." };
  }

  await admin
    .from("shipments")
    .update({ fenix_shipment_id: child.id, delivery_status: "transferido", status_category: "transferred" })
    .eq("id", shipmentId);
  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "reroute",
    note: `Guía Fenix creada: ${guideCode}`,
  });

  revalidatePath("/dashboard/envios");
  return { notice: `Guía Fenix ${guideCode} creada.` };
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

  // write under RLS as the user (the policy allows org admins)
  const { error } = await sb.from("fenix_stock").upsert(
    {
      org_id: adminOrg.org_id,
      city,
      product,
      sku: input.sku?.trim() || null,
      quantity: Math.max(0, Math.trunc(input.quantity)),
      updated_by: user.id,
    },
    { onConflict: "org_id,city,product" },
  );
  if (error) return { error: error.message };
  revalidatePath("/dashboard/envios/stock");
  return { notice: "Stock actualizado." };
}

/** Delete a Fenix stock row (admin). */
export async function deleteFenixStock(id: string): Promise<ShipmentActionState> {
  const sb = await createServerSupabase();
  const { error } = await sb.from("fenix_stock").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/envios/stock");
  return { notice: "Eliminado." };
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

  const stores = await getAccessibleStores();
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return { notice: "Sin envíos.", updated: 0 };

  const admin = createAdminSupabase();
  const { data: stock } = await admin
    .from("fenix_stock")
    .select("city,product,sku,quantity")
    .eq("org_id", adminOrg.org_id);
  const stockRows = (stock as FenixStockRow[]) ?? [];

  // Only pending guides carry eligibility; re-evaluate each and flip the ones
  // whose stored flag no longer matches.
  const { data: rows } = await admin
    .from("shipments")
    .select("id,city,product,order_id,fenix_eligible")
    .in("store_id", storeIds)
    .eq("status_category", "pending");
  const shipments =
    (rows as {
      id: string;
      city: string | null;
      product: string | null;
      order_id: string | null;
      fenix_eligible: boolean;
    }[]) ?? [];

  // Pull the linked orders' line items so eligibility can match against the
  // Shopify catalog (title + SKU) — the same source the stock sheet is keyed
  // on — instead of the Aliclik report's free-text product.
  const orderIds = Array.from(new Set(shipments.map((s) => s.order_id).filter((v): v is string => !!v)));
  const productsByOrder = new Map<string, { title?: string | null; sku?: string | null }[]>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data: orders } = await admin
      .from("orders")
      .select("id,line_items")
      .in("id", orderIds.slice(i, i + 300));
    for (const o of (orders as { id: string; line_items: { title?: string | null; sku?: string | null }[] | null }[]) ?? []) {
      productsByOrder.set(
        o.id,
        (o.line_items ?? []).map((li) => ({ title: li.title ?? null, sku: li.sku ?? null })),
      );
    }
  }

  let updated = 0;
  for (const s of shipments) {
    const orderProducts = s.order_id ? productsByOrder.get(s.order_id) : undefined;
    const eligible = evaluateFenix(s, stockRows, orderProducts).eligible;
    if (eligible !== s.fenix_eligible) {
      await admin.from("shipments").update({ fenix_eligible: eligible }).eq("id", s.id);
      updated++;
    }
  }
  revalidatePath("/dashboard/envios");
  return { notice: `Elegibilidad recalculada — ${updated} guías actualizadas.`, updated };
}
