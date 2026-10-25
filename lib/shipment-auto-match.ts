// Batch auto-match for the "Revisión" queue: search the order (routed to the
// right store) for each unmatched shipment's parsed order reference, and —
// only when exactly one candidate's phone cross-validates the shipment's own
// phone (the 2-variable gate: NOTA reference + same phone) — LINK it directly,
// no human click needed. If the link's Shopify fetch/upsert fails, we fall back
// to persisting a *suggestion* so a human can still confirm it manually.
// Mirrors lib/shipment-match.ts's split: decideSuggestion is pure/testable,
// runSuggestionBatch is the I/O orchestration (like aliclik-ingest.ts).
//
// DÓNDE SE BUSCA (25-10-2026, MOM §38.12 «Envíos: el auto-vínculo y la
// búsqueda con pedidos de WooCommerce»). Un pedido de WooCommerce no está en
// Shopify: se busca en `orders` de Kapta, siempre. Los de Shopify se siguen
// buscando en Shopify mientras la tienda tenga token y Shopify conteste; si no
// tiene token o Shopify dice que la tienda ya no está (401, 402, 403, 404, 423,
// `isShopifyShopGone`), también se buscan en `orders`. Un fallo pasajero (5xx,
// tiempo agotado, red) sigue dejando el envío sin revisar, como antes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds, type StoreCreds } from "@/lib/ingest";
import {
  fetchOrderById,
  isShopifyShopGone,
  pickStoresForOrderQuery,
  searchOrdersLive,
  updateOrderShippingAddress,
} from "@/lib/shopify";
import { captureShopifyOrderForLink, type ShipmentShopifyDeps } from "@/lib/shipment-order-capture";
import type { StoreSummary } from "@/lib/types";

/** Shopify order-search round-trips run ~200–500ms; 25 shipments (each 1–2
 *  calls) comfortably finishes well under any serverless timeout, so a
 *  client-side loop of chunks never risks a request timing out. */
export const SUGGESTION_BATCH_SIZE = 25;

export interface SuggestInput {
  orderName: string | null; // shipments.order_name (NOTA-parsed guess)
  customerPhone: string | null; // shipments.customer_phone
}

export interface SuggestCandidate {
  gid: string;
  storeId: string;
  name: string | null;
  customer_phone: string | null;
  /**
   * El id del pedido en Kapta cuando el candidato salió de la base local
   * (`orders`): se vincula con esa fila, sin preguntarle nada a Shopify. Sin
   * él, el candidato es de la búsqueda en vivo de Shopify y `gid` es su gid.
   */
  orderId?: string;
}

export interface SuggestDecision {
  suggest: boolean;
  candidate: SuggestCandidate | null;
}

/**
 * Given a shipment's NOTA-guessed reference + phone, and the search results
 * for that reference, decide whether to suggest a link. Mirrors the
 * interactive PhoneBadge/sortByPhoneMatch logic in order-link-picker.tsx —
 * never trust a bare digits/name coincidence alone; only exactly one
 * phone-cross-validated candidate earns a suggestion.
 */
export function decideSuggestion(
  input: SuggestInput,
  candidates: SuggestCandidate[],
): SuggestDecision {
  if (!input.customerPhone) return { suggest: false, candidate: null };
  const phoneMatches = candidates.filter((c) => c.customer_phone === input.customerPhone);
  if (phoneMatches.length === 1) return { suggest: true, candidate: phoneMatches[0]! };
  return { suggest: false, candidate: null };
}

export interface BatchResult {
  processed: number;
  linked: number; // confidently auto-linked to an order this round
  done: boolean; // true when fewer than `limit` unchecked rows remained
  /**
   * Envíos que se quedaron sin revisar porque la búsqueda falló en alguna de
   * sus tiendas (un mal momento de Shopify o de la base): se vuelven a buscar
   * en la próxima pasada. Solo aparece si hubo alguno.
   */
  retry?: number;
}

interface CandidateRow {
  id: string;
  order_name: string | null;
  customer_phone: string | null;
}

interface PendingSuggestionRow {
  id: string;
  suggested_order_gid: string | null;
  suggested_store_id: string | null;
  suggested_order_name: string | null;
}

/**
 * Lo que la captura del pedido (lib/shipment-order-capture.ts) usa de afuera,
 * con las credenciales ya descifradas de la tanda.
 */
function captureDeps(credsByStore: Map<string, StoreCreds>): ShipmentShopifyDeps {
  return {
    getCreds: async (storeId) => credsByStore.get(storeId) ?? null,
    fetchOrder: fetchOrderById,
    updateAddress: updateOrderShippingAddress,
  };
}

/**
 * Vincula el envío con el candidato, con el cliente admin (la tanda no tiene
 * sesión). Uno de la base local (`orderId`) se vincula con esa fila tal cual.
 * Uno de Shopify se captura igual que en linkShipmentToShopifyOrder
 * (`captureShopifyOrderForLink`): con Shopify se lee y se guarda, como
 * siempre; sin token, o si Shopify falla, se usa la fila que ya está en Kapta.
 * Devuelve false si no se pudo, para que quien llama guarde una sugerencia o
 * lo deje sin revisar. Mueve el envío a la tienda del candidato (una guía
 * `#KP…` importada con la tienda de Aurela va a Kenku), igual que un vínculo a
 * mano.
 */
async function autoLinkShipment(
  admin: SupabaseClient,
  shipmentId: string,
  candidate: SuggestCandidate,
  credsByStore: Map<string, StoreCreds>,
  now: string,
): Promise<boolean> {
  let orderId = candidate.orderId ?? null;
  let orderName = candidate.name;
  if (!orderId) {
    const captured = await captureShopifyOrderForLink(
      admin,
      { storeId: candidate.storeId, orderGid: candidate.gid },
      captureDeps(credsByStore),
    );
    if (!captured.ok) return false;
    orderId = captured.orderId;
    // El nombre que quedó en Kapta (el que dijo Shopify al capturarlo).
    const { data: row } = await admin.from("orders").select("name").eq("id", orderId).maybeSingle();
    const saved = (row as { name?: unknown } | null)?.name;
    if (typeof saved === "string" && saved) orderName = saved;
  }
  const { error } = await admin
    .from("shipments")
    .update({
      order_id: orderId,
      store_id: candidate.storeId,
      order_name: orderName,
      matched: true,
      match_method: "auto",
      suggested_order_gid: null,
      suggested_store_id: null,
      suggested_order_name: null,
      suggestion_checked_at: now,
    })
    .eq("id", shipmentId);
  return !error;
}

/** Cuántos candidatos se piden por tienda, en Shopify y en la base local. */
const CANDIDATES_PER_STORE = 5;

/**
 * La referencia de la NOTA lista para buscarla por nombre en `orders`: sin «#»
 * y solo letras, dígitos y guiones (lo demás rompería el filtro o haría de
 * comodín). «#KP200001» → «KP200001».
 */
export function localOrderReference(reference: string): string {
  return reference.trim().replace(/^#/, "").replace(/[^A-Za-z0-9-]/g, "");
}

/** Qué pedidos de la base local se buscan: solo los de WooCommerce (Shopify
 *  contestó por los suyos) o todos (la tienda no tiene Shopify, o ya no está). */
export type LocalOrderScope = "woocommerce" | "todas";

interface LocalOrderRow {
  id: string;
  shopify_order_id: string;
  name: string | null;
  customer_phone: string | null;
}

/**
 * Busca la referencia en los pedidos de la tienda guardados en Kapta, en el
 * mismo orden que la búsqueda en vivo de Shopify (`searchOrdersLive`): primero
 * el nombre exacto (`#KP200001`, sin distinguir mayúsculas) y, solo si no hay,
 * el nombre que contiene la referencia o sus dígitos. No busca por celular: el
 * celular es la segunda señal y la pone `decideSuggestion`. Devuelve null si la
 * base falló (no es «no hay»).
 */
export async function searchLocalOrderCandidates(
  admin: SupabaseClient,
  storeId: string,
  reference: string,
  scope: LocalOrderScope,
  first: number = CANDIDATES_PER_STORE,
): Promise<SuggestCandidate[] | null> {
  const ref = localOrderReference(reference);
  if (ref.length < 2) return [];
  const digits = ref.replace(/\D/g, "");
  const run = async (byName: { exact: string } | { loose: string }): Promise<LocalOrderRow[] | null> => {
    let q = admin.from("orders").select("id,shopify_order_id,name,customer_phone").eq("store_id", storeId);
    if (scope === "woocommerce") q = q.eq("platform", "woocommerce");
    q = "exact" in byName ? q.ilike("name", byName.exact) : q.or(byName.loose);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(first);
    if (error) return null;
    return (data as LocalOrderRow[] | null) ?? [];
  };
  let rows = await run({ exact: `#${ref}` });
  if (rows === null) return null;
  if (!rows.length) {
    const loose = [`name.ilike.%${ref}%`];
    if (digits && digits !== ref) loose.push(`name.ilike.%${digits}%`);
    rows = await run({ loose: loose.join(",") });
    if (rows === null) return null;
  }
  return rows.map((o) => ({
    gid: o.shopify_order_id,
    storeId,
    name: o.name,
    customer_phone: o.customer_phone ?? null,
    orderId: o.id,
  }));
}

type StoreSearch = { failed: true } | { failed: false; candidates: SuggestCandidate[] };

/**
 * Los candidatos de una tienda para la referencia, o `failed` si no se pudo
 * saber (no es «no hay»):
 * - con token de Shopify y Shopify contestando: los de Shopify en vivo, como
 *   siempre, más los de WooCommerce de la base local;
 * - sin token, o con Shopify diciendo que la tienda ya no está
 *   (`isShopifyShopGone`): todos los de la base local, de las dos plataformas.
 *   La tienda se anota en `goneStores` para no volver a preguntarle en la tanda;
 * - un fallo pasajero de Shopify (5xx, tiempo agotado, red, permiso) o de la
 *   base: `failed`, y el envío se vuelve a buscar en la próxima pasada.
 */
async function storeCandidates(
  admin: SupabaseClient,
  store: StoreSummary,
  reference: string,
  credsByStore: Map<string, StoreCreds>,
  goneStores: Set<string>,
): Promise<StoreSearch> {
  const creds = credsByStore.get(store.id);
  if (creds?.shopify_token && !goneStores.has(store.id)) {
    let live: SuggestCandidate[] | null = null;
    try {
      const orders = await searchOrdersLive({
        domain: creds.shopify_domain,
        token: creds.shopify_token,
        storeId: store.id,
        query: reference,
        first: CANDIDATES_PER_STORE,
      });
      live = orders.map((o) => ({
        gid: (o.raw as { id?: string } | undefined)?.id ?? `gid://shopify/Order/${o.shopify_order_id}`,
        storeId: store.id,
        name: o.name,
        customer_phone: o.customer_phone ?? null,
      }));
    } catch (e) {
      // Un mal momento de Shopify (o un permiso que falta) no es «no hay».
      if (!isShopifyShopGone(e)) return { failed: true };
      goneStores.add(store.id);
    }
    if (live) {
      const woo = await searchLocalOrderCandidates(admin, store.id, reference, "woocommerce");
      if (woo === null) return { failed: true };
      return { failed: false, candidates: [...live, ...woo] };
    }
  }
  const local = await searchLocalOrderCandidates(admin, store.id, reference, "todas");
  if (local === null) return { failed: true };
  return { failed: false, candidates: local };
}

/**
 * Process one chunk of the "Revisión" queue in two passes: first LINK any row
 * that already carries a saved suggestion (from a prior suggest-only run) —
 * straight from the stored gid, no search — then, once those are drained,
 * search each never-checked shipment's order_name (Shopify and the local base,
 * `storeCandidates`) and LINK it when the phone cross-validates a single
 * candidate. `suggestion_checked_at is null` is the resumability cursor for the
 * search pass; `suggested_order_gid is not null` for the drain pass. A stored
 * suggestion whose link fails has its suggestion cleared (drops to plain
 * manual review) so it can't loop forever.
 */
export async function runSuggestionBatch(
  admin: SupabaseClient,
  storeIds: string[],
  stores: StoreSummary[],
  limit: number = SUGGESTION_BATCH_SIZE,
): Promise<BatchResult> {
  const now = new Date().toISOString();

  // Decrypt each store's Shopify creds once — reused by both passes.
  const credsByStore = new Map<string, StoreCreds>();
  await Promise.all(
    stores.map(async (s) => {
      const c = await getStoreCreds(s.id, admin);
      if (c?.shopify_token) credsByStore.set(s.id, c);
    }),
  );

  // Pass 1: drain rows that already have a saved suggestion — link them from
  // the stored gid (no search; without Shopify, from the row already in Kapta).
  // Returns early so the caller keeps looping until this backlog is empty
  // before moving on to the search pass.
  const { data: pend } = await admin
    .from("shipments")
    .select("id,suggested_order_gid,suggested_store_id,suggested_order_name")
    .in("store_id", storeIds)
    .eq("matched", false)
    .not("suggested_order_gid", "is", null)
    .limit(limit);
  const pendRows = (pend as PendingSuggestionRow[]) ?? [];
  if (pendRows.length) {
    let linked = 0;
    for (const r of pendRows) {
      const ok =
        r.suggested_store_id != null &&
        (await autoLinkShipment(
          admin,
          r.id,
          {
            gid: r.suggested_order_gid!,
            storeId: r.suggested_store_id,
            name: r.suggested_order_name,
            customer_phone: null,
          },
          credsByStore,
          now,
        ));
      if (ok) linked++;
      else
        await admin
          .from("shipments")
          .update({ suggested_order_gid: null, suggested_store_id: null, suggested_order_name: null })
          .eq("id", r.id);
    }
    return { processed: pendRows.length, linked, done: false };
  }

  // Pass 2: never-checked rows — search then link.
  const { data } = await admin
    .from("shipments")
    .select("id,order_name,customer_phone")
    .in("store_id", storeIds)
    .eq("matched", false)
    .is("suggestion_checked_at", null)
    .in("status_category", ["pending", "in_route"])
    .order("created_at")
    .limit(limit);
  const rows = (data as CandidateRow[]) ?? [];
  if (!rows.length) return { processed: 0, linked: 0, done: true };

  const noReference = rows.filter((r) => !r.order_name);
  if (noReference.length) {
    await admin
      .from("shipments")
      .update({ suggestion_checked_at: now })
      .in(
        "id",
        noReference.map((r) => r.id),
      );
  }

  const searchable = rows.filter((r) => r.order_name);
  // Tiendas cuya Shopify ya contestó en esta tanda que no está: no se le vuelve
  // a preguntar por cada envío.
  const goneStores = new Set<string>();
  let linked = 0;
  let retry = 0;
  for (const row of searchable) {
    const targets = pickStoresForOrderQuery(row.order_name!, stores);
    // Una tienda cuya búsqueda falló no dijo «no hay»: no se sabe. Antes caía
    // como una lista vacía, el envío quedaba revisado y no se volvía a buscar
    // nunca. Ahora se queda sin marcar y entra en la próxima pasada. Tampoco se
    // decide con las demás tiendas: el candidato único podía no serlo.
    const perStore = await Promise.all(
      targets.map((store) => storeCandidates(admin, store, row.order_name!, credsByStore, goneStores)),
    );
    if (perStore.some((r) => r.failed)) {
      retry++;
      continue;
    }
    const candidates = perStore.flatMap((r) => (r.failed ? [] : r.candidates));
    const decision = decideSuggestion(
      { orderName: row.order_name, customerPhone: row.customer_phone },
      candidates,
    );
    if (decision.suggest && decision.candidate) {
      const ok = await autoLinkShipment(admin, row.id, decision.candidate, credsByStore, now);
      if (ok) {
        linked++;
        continue;
      }
      // Uno de la base local que no se pudo vincular (falló la base): sin
      // sugerencia, que solo sabe de gid de Shopify; se vuelve a buscar.
      if (decision.candidate.orderId) {
        retry++;
        continue;
      }
      // link failed (Shopify fetch/upsert error) → leave a suggestion to confirm by hand
      await admin
        .from("shipments")
        .update({
          suggested_order_gid: decision.candidate.gid,
          suggested_store_id: decision.candidate.storeId,
          suggested_order_name: decision.candidate.name,
          suggestion_checked_at: now,
        })
        .eq("id", row.id);
    } else {
      await admin.from("shipments").update({ suggestion_checked_at: now }).eq("id", row.id);
    }
  }

  // `done` también si nada avanzó: los que quedan son todos de una búsqueda que
  // falló, y pedirlos otra vez en el mismo bucle del cliente (import-review)
  // daría la misma respuesta para siempre. Se reintentan en la próxima pasada.
  const reviewed = rows.length - retry;
  return {
    processed: reviewed,
    linked,
    done: rows.length < limit || reviewed === 0,
    ...(retry ? { retry } : {}),
  };
}
