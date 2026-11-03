// Batch auto-match for the "Revisión" queue: search the order (routed to the
// right store, in Kapta's `orders`) for each unmatched shipment's parsed order
// reference, and —
// only when exactly one candidate's phone cross-validates the shipment's own
// phone (the 2-variable gate: NOTA reference + same phone) — LINK it directly,
// no human click needed.
// Mirrors lib/shipment-match.ts's split: decideSuggestion is pure/testable,
// runSuggestionBatch is the I/O orchestration (like aliclik-ingest.ts).
//
// DÓNDE SE BUSCA (25-10-2026, decisión del owner, MOM §38.12 «Envíos: el
// auto-vínculo y la búsqueda con pedidos de WooCommerce»). Siempre en `orders`
// de Kapta, que ya tiene los pedidos de Shopify y los de WooCommerce de la
// tienda: no se le pregunta nada a Shopify (ni a WooCommerce). Un fallo de la
// base deja el envío sin revisar y se vuelve a buscar en la próxima pasada. Un
// pedido que la sincronización todavía no trajo no aparece: el envío queda
// revisado sin vínculo, para una persona (MOM §38.12).

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickStoresForOrderQuery } from "@/lib/shopify";
import type { StoreSummary } from "@/lib/types";

/** Each shipment costs one or two `orders` queries per store it routes to; 25
 *  shipments comfortably finish well under any serverless timeout, so a
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
   * El id del pedido en Kapta (`orders.id`): se vincula con esa fila. Todo
   * candidato de la búsqueda lo trae; solo falta en una sugerencia guardada
   * antes del 25-10-2026, que trae el gid de Shopify en `gid` y se busca en
   * `orders` por él (`autoLinkShipment`).
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
   * Envíos que se quedaron como estaban porque la base falló (al buscar en
   * alguna de sus tiendas o al vincular): se vuelven a intentar en la próxima
   * pasada. Solo aparece si hubo alguno.
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
 * El `orders.shopify_order_id` de un gid de Shopify guardado en una sugerencia:
 * «gid://shopify/Order/123» (o «123») → «123»; null si no es de Shopify. Los
 * pedidos de WooCommerce (`wc-…`) nunca se guardaron como sugerencia.
 */
export function shopifyOrderIdFromGid(gid: string): string | null {
  const m = /^(?:gid:\/\/shopify\/Order\/)?(\d+)$/.exec(gid.trim());
  return m ? m[1]! : null;
}

/** «linked»: vinculado. «not_found»: el pedido no está en Kapta. «failed»: la base falló. */
type LinkOutcome = "linked" | "not_found" | "failed";

/**
 * Vincula el envío con el candidato, con el cliente admin (la tanda no tiene
 * sesión), siempre con la fila que ya está en Kapta: la del candidato
 * (`orderId`) o, para una sugerencia guardada antes con un gid de Shopify, la
 * fila de ese pedido en `orders` (por `store_id` y `shopify_order_id`). Nunca
 * le pregunta a Shopify. Distingue «no está en Kapta» de «la base falló», que
 * no es lo mismo: lo primero no se arregla reintentando. Mueve el envío a la tienda
 * del candidato (una guía `#KP…` importada con la tienda de Aurela va a Kenku),
 * igual que un vínculo a mano.
 */
async function autoLinkShipment(
  admin: SupabaseClient,
  shipmentId: string,
  candidate: SuggestCandidate,
  now: string,
): Promise<LinkOutcome> {
  let orderId = candidate.orderId ?? null;
  let orderName = candidate.name;
  if (!orderId) {
    const shopifyOrderId = shopifyOrderIdFromGid(candidate.gid);
    if (!shopifyOrderId) return "not_found";
    const { data: row, error: readErr } = await admin
      .from("orders")
      .select("id,name")
      .eq("store_id", candidate.storeId)
      .eq("shopify_order_id", shopifyOrderId)
      .maybeSingle();
    if (readErr) return "failed";
    if (!row) return "not_found";
    orderId = (row as { id: string }).id;
    const saved = (row as { name?: unknown }).name;
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
  return error ? "failed" : "linked";
}

/** Cuántos candidatos se piden por tienda a `orders`. */
const CANDIDATES_PER_STORE = 5;

/**
 * La referencia de la NOTA lista para buscarla por nombre en `orders`: sin «#»
 * y solo letras, dígitos y guiones (lo demás rompería el filtro o haría de
 * comodín). «#KP200001» → «KP200001».
 */
export function localOrderReference(reference: string): string {
  return reference.trim().replace(/^#/, "").replace(/[^A-Za-z0-9-]/g, "");
}

interface LocalOrderRow {
  id: string;
  shopify_order_id: string;
  name: string | null;
  customer_phone: string | null;
}

/**
 * Busca la referencia en los pedidos de la tienda guardados en Kapta, de las
 * dos plataformas (Shopify y WooCommerce): primero el nombre exacto
 * (`#KP200001`, sin distinguir mayúsculas) y, solo si no hay, el nombre que
 * contiene la referencia o sus dígitos. No busca por celular: el
 * celular es la segunda señal y la pone `decideSuggestion`. Devuelve null si la
 * base falló (no es «no hay»).
 */
export async function searchLocalOrderCandidates(
  admin: SupabaseClient,
  storeId: string,
  reference: string,
  first: number = CANDIDATES_PER_STORE,
): Promise<SuggestCandidate[] | null> {
  const ref = localOrderReference(reference);
  if (ref.length < 2) return [];
  const digits = ref.replace(/\D/g, "");
  const run = async (byName: { exact: string } | { loose: string }): Promise<LocalOrderRow[] | null> => {
    let q = admin.from("orders").select("id,shopify_order_id,name,customer_phone").eq("store_id", storeId);
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

/** Los candidatos de una tienda en la base de Kapta, o `failed` si la base falló (no es «no hay»). */
async function storeCandidates(admin: SupabaseClient, store: StoreSummary, reference: string): Promise<StoreSearch> {
  const local = await searchLocalOrderCandidates(admin, store.id, reference);
  if (local === null) return { failed: true };
  return { failed: false, candidates: local };
}

/**
 * Process one chunk of the "Revisión" queue in two passes: first LINK any row
 * that already carries a saved suggestion (from a prior suggest-only run) —
 * from the stored Shopify gid's row in `orders`, no search — then, once those
 * are drained, search each never-checked shipment's order_name in Kapta's
 * `orders` (`storeCandidates`) and LINK it when the phone cross-validates a
 * single candidate. `suggestion_checked_at is null` is the resumability cursor
 * for the search pass; `suggested_order_gid is not null` for the drain pass. A
 * stored suggestion whose order isn't in `orders` has its suggestion cleared
 * (drops to plain manual review) so it can't loop forever; if the base failed,
 * it is left as it was for the next pass. Nunca llama a Shopify.
 */
export async function runSuggestionBatch(
  admin: SupabaseClient,
  storeIds: string[],
  stores: StoreSummary[],
  limit: number = SUGGESTION_BATCH_SIZE,
): Promise<BatchResult> {
  const now = new Date().toISOString();

  // Pass 1: drain rows that already have a saved suggestion — link them with
  // the stored gid's row in `orders` (no search, no Shopify). Returns early so
  // the caller keeps looping until this backlog is empty before moving on to
  // the search pass.
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
    let pendRetry = 0;
    for (const r of pendRows) {
      const outcome: LinkOutcome =
        r.suggested_store_id == null
          ? "not_found"
          : await autoLinkShipment(
              admin,
              r.id,
              {
                gid: r.suggested_order_gid!,
                storeId: r.suggested_store_id,
                name: r.suggested_order_name,
                customer_phone: null,
              },
              now,
            );
      if (outcome === "linked") linked++;
      else if (outcome === "failed") pendRetry++;
      else
        await admin
          .from("shipments")
          .update({ suggested_order_gid: null, suggested_store_id: null, suggested_order_name: null })
          .eq("id", r.id);
    }
    // Una sugerencia cuya base falló se queda tal cual: si en esta vuelta nada
    // avanzó, se termina (pedirla otra vez daría lo mismo) y se reintenta en la
    // próxima pasada.
    const drained = pendRows.length - pendRetry;
    return { processed: drained, linked, done: drained === 0, ...(pendRetry ? { retry: pendRetry } : {}) };
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
  let linked = 0;
  let retry = 0;
  for (const row of searchable) {
    const targets = pickStoresForOrderQuery(row.order_name!, stores);
    // Una tienda cuya búsqueda falló no dijo «no hay»: no se sabe. Antes caía
    // como una lista vacía, el envío quedaba revisado y no se volvía a buscar
    // nunca. Ahora se queda sin marcar y entra en la próxima pasada. Tampoco se
    // decide con las demás tiendas: el candidato único podía no serlo.
    const perStore = await Promise.all(
      targets.map((store) => storeCandidates(admin, store, row.order_name!)),
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
      // El candidato trae su `orderId`: solo puede fallar la base al escribir.
      // Sin sugerencia ni marca de revisado: se vuelve a buscar en la próxima pasada.
      if ((await autoLinkShipment(admin, row.id, decision.candidate, now)) === "linked") linked++;
      else retry++;
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
