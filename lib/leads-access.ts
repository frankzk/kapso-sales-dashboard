// RLS-scoped reads for the leads module (queue views, lead detail, counts).

import { createServerSupabase } from "@/lib/db";
import { leadCartDetailOf } from "@/lib/lead-cart-detail";
import { normalizePhone } from "@/lib/phone";
import {
  combinePriorOrders,
  firstProductTitle,
  historyNetAmount,
  HISTORY_PRIOR_LIMIT,
  type HistoryPriorRow,
  type LocalPriorRow,
} from "@/lib/customer-history-merge";
import { orderAdminLink, orderPlatform } from "@/lib/order-admin-url";
import {
  cartPhoneVariants,
  mergeCustomerCarts,
  summarizeCarts,
  type ArchiveCartRow,
  type CustomerCarts,
  type MirrorDraftRow,
} from "@/lib/customer-carts";
import type { AliclikHealthState } from "@/lib/aliclik-health";
import { loadAliclikHealthState } from "@/lib/aliclik-health-access";
import type { LeadCallRow, LeadRow, OrderPlatform } from "@/lib/types";
import type { DistrictCoverageRule } from "@/lib/district-coverage";
import type { PedidoPrevio } from "@/lib/pedido-duplicado";
import { sortHandoffWithPendingVouchers } from "@/lib/pending-voucher";
import {
  countExtraPendingVoucherLeads,
  loadPendingVoucherLeads,
  loadPendingVouchers,
} from "@/lib/pending-voucher-access";
import {
  buildAnomalyReport,
  EMPTY_REPORT,
  localDay,
  type AnomalyReport,
  type AnomalyRow,
} from "@/lib/ingest-anomalies";

export type LeadView = "por_llamar" | "handoff" | "yape" | "seguimientos" | "ganados" | "perdidos";

export const LEAD_VIEWS: { key: LeadView; label: string }[] = [
  { key: "por_llamar", label: "Por llamar" },
  { key: "handoff", label: "⚡ Atender ahora" },
  { key: "yape", label: "🔥 Yape/Shalom" },
  { key: "seguimientos", label: "Seguimientos" },
  { key: "ganados", label: "Ganados" },
  { key: "perdidos", label: "Perdidos" },
];

/** Ventana de "frescura" de un handoff: si el cliente no escribe hace más de
 *  esto, sale de "Atender ahora" (el cron lo devuelve a la cola normal). */
export const HANDOFF_FRESH_HOURS = 24;

/** ISO del corte de frescura de handoffs (now − HANDOFF_FRESH_HOURS). */
export function handoffFreshCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - HANDOFF_FRESH_HOURS * 3_600_000).toISOString();
}

const LEADS_PAGE_SIZE = 1000;
const LEADS_PAGE_CAP = 20_000;
// Keep the queue payload lean: the drawer refetches the full row on open. Every
// field below is used by the list, its facets, or the drawer's instant shell.
const LEAD_BOARD_SELECT = [
  "id",
  "store_id",
  "phone",
  "name",
  "first_seen_at",
  "last_interaction_at",
  "kapso_conversation_id",
  "handoff_reason",
  "handoff_context",
  "handoff_at",
  "category",
  "status",
  "needs_attention",
  "has_order",
  "district",
  "cart_value",
  "cart_item_count",
  "cart_summary",
  "draft_order_gid",
  "draft_order_name",
  "draft_order_status",
  "draft_order_url",
  "province",
  "region", // 0013; el filtro de cobertura la lee (lib/lead-coverage.ts)
  "referencia",
  "address1",
  "ship_name",
  "inbound_count",
  "first_inbound_text",
  "last_product_handle",
  "cart_product_handle",
  "cart_count_48h",
  "source",
  "ad_id",
  "ad_headline",
  "ctwa_clid",
  "wa_phone_number_id",
  "last_inbound_at",
  "claimed_by",
  "claimed_at",
].join(",");

// Deployment safety: the app can ship before 0043 is applied. Without this the
// whole select errors and the board renders EMPTY (not just missing the hook).
//
// `last_product_handle` (0140) entra por la misma puerta y por la misma razón:
// mientras la migración no corra, la cola tiene que seguir dibujándose sin el
// filtro de producto en vez de quedarse en blanco.
const COLUMNAS_CON_MIGRACION_PENDIENTE = new Set([
  "first_inbound_text",
  "last_product_handle",
  "cart_product_handle",
  "cart_count_48h", // 0207: sin ella la cola se ordena como antes, sin el factor
]);
const LEAD_BOARD_SELECT_LEGACY = LEAD_BOARD_SELECT.split(",")
  .filter((c) => !COLUMNAS_CON_MIGRACION_PENDIENTE.has(c))
  .join(",");

/** Cuántas filas carga la página por vista. "Por llamar" se filtra y cuenta en
 *  cliente (jerarquía de facetas), así que necesita el universo completo; el
 *  resto se acota para que la carga inicial siga siendo rápida. Compartido para
 *  que la UI SEPA si lo que tiene en memoria está truncado (p. ej. antes de
 *  exportar una audiencia completa). */
export const LEADS_VIEW_LIMIT = 200;

/**
 * A qué tiendas mira la cola. Una sola, o varias con la opción "Todas".
 *
 * Es SIEMPRE un array, incluso para una tienda: `in ("store_id", [x])` usa el
 * mismo indice `(store_id, ...)` que `eq` PARA FILTRAR, asi que no hay dos
 * caminos que mantener ni un `if` que se pueda olvidar en una de las siete
 * vistas. Para ORDENAR no es lo mismo: con `= ANY` el planificador no da por
 * ordenado lo que sale del indice y lo vuelve a ordenar entero. Aqui las vistas
 * se cortan en 200 y «Por llamar» ordena por id, que ningun indice de la cola
 * sirve con o sin `eq`; pero donde se drenan miles de filas por un indice
 * ordenado hay que pedir tienda por tienda con `eq` (ver getLeadsForDashboard).
 *
 * NO mezcla nada por dentro: cada lead sigue siendo su fila, con su tienda. Lo
 * unico que cambia es que la consulta deja de acotarse a una. La RLS sigue
 * decidiendo cuales de esas tiendas puede ver quien mira.
 */
export type StoreScope = string[];

/** Valor de `?store=` que significa "todas las que puedo ver". */
export const ALL_STORES = "all";

export function leadsViewLimit(view: LeadView): number | null {
  return view === "por_llamar" ? null : LEADS_VIEW_LIMIT;
}

export async function getStoreLeads(
  storeIds: StoreScope,
  view: LeadView,
  limit: number | null = LEADS_VIEW_LIMIT,
): Promise<LeadRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const buildQuery = (select: string = LEAD_BOARD_SELECT, count?: "exact") => {
    let q = sb
      .from("leads")
      .select(select, count ? { count } : undefined)
      .in("store_id", storeIds);
    switch (view) {
      case "por_llamar":
        q = q
          .in("category", ["open", "hot"])
          .neq("status", "yape_por_verificar") // payment-pending leads live in the Yape/Shalom tab
          // Solo por `id`: la cola se carga ENTERA y se ordena aquí
          // (sortPorLlamar). Ordenar en la base las filas anchas de la cola
          // —~7.000 con 40 columnas— desbordaba a disco en CADA página de cada
          // refresco: 15 millones de bloques temporales escritos, la segunda
          // consulta más cara de la base (02-10-2026).
          .order("id", { ascending: true });
        break;
      case "handoff":
        // "Atender ahora": handoffs del bot ocurridos en las últimas
        // HANDOFF_FRESH_HOURS y aún sin gestionar (needs_attention). El más
        // antiguo primero (el que más espera arriba). Se filtra por handoff_at
        // (siempre seteado por applyHandoff), NO por last_inbound_at — que
        // applyHandoff no puebla y dejaría la cola vacía. Sale al dispositionar
        // (needs_attention=false), al marcar resuelto, o cuando el cron lo
        // expira por antigüedad.
        q = q
          .eq("needs_attention", true)
          .gte("handoff_at", handoffFreshCutoffIso())
          .order("handoff_at", { ascending: true })
          .order("id", { ascending: true });
        break;
      case "yape":
        q = q
          .eq("status", "yape_por_verificar")
          .order("last_interaction_at", { ascending: false })
          .order("id", { ascending: true });
        break;
      case "seguimientos":
        q = q
          .not("next_followup_at", "is", null)
          .lte("next_followup_at", new Date().toISOString())
          .order("next_followup_at", { ascending: true })
          .order("id", { ascending: true });
        break;
      case "ganados":
        q = q
          .eq("category", "won")
          .order("updated_at", { ascending: false })
          .order("id", { ascending: true });
        break;
      case "perdidos":
        q = q
          .eq("category", "lost")
          .order("updated_at", { ascending: false })
          .order("id", { ascending: true });
        break;
    }
    return q;
  };

  if (limit !== null) {
    // «Atender ahora»: los pagos por validar se leen a la par de la vista.
    const pendingIndex = view === "handoff" ? loadPendingVouchers(sb, storeIds) : null;
    let res = await buildQuery().limit(limit);
    let select = LEAD_BOARD_SELECT;
    if (res.error) {
      select = LEAD_BOARD_SELECT_LEGACY;
      res = await buildQuery(select).limit(limit);
    }
    const limited = (res.data as unknown as LeadRow[]) ?? [];
    if (pendingIndex) return withPendingVoucherLeads(sb, storeIds, limited, select, await pendingIndex);
    return view === "por_llamar" ? sortPorLlamar(limited) : limited;
  }
  const all = await drainLeads(buildQuery);
  return view === "por_llamar" ? sortPorLlamar(all) : all;
}

/**
 * «Atender ahora» con los comprobantes por validar delante (MOM §16.1).
 *
 * La clienta que ya pagó y espera —su clave, en agencia— sube aquí aunque el
 * bot no la haya derivado o su handoff haya caducado: se busca por
 * `leads.order_id` el lead de cada pedido con un comprobante en
 * `pendiente_revision` / `info_incompleta`, se le pone el motivo y va arriba.
 * No se escribe nada en `leads`: lo decide el pago, así que sale solo cuando
 * alguien lo valida o lo rechaza, igual que el pop-up de cobranza, y nadie
 * tiene que pulsar «Resuelto».
 *
 * Los handoffs de siempre siguen debajo, en su orden. Si la lectura de pagos
 * falla, la vista queda como era (no se inventa ni se quita a nadie).
 */
async function withPendingVoucherLeads(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: StoreScope,
  handoffs: LeadRow[],
  select: string,
  index: Awaited<ReturnType<typeof loadPendingVouchers>>,
): Promise<LeadRow[]> {
  if (!index || !index.size) return handoffs;
  const voucherLeads = await loadPendingVoucherLeads<LeadRow>(sb, storeIds, index, select);
  if (!voucherLeads.length) return handoffs;
  const byId = new Map(voucherLeads.map((l) => [l.id, l]));
  // Un lead que ya estaba por un handoff conserva su fila; solo gana el motivo.
  const merged: LeadRow[] = handoffs.map((l) => (byId.has(l.id) ? { ...l, pending_voucher: byId.get(l.id)!.pending_voucher } : l));
  const present = new Set(handoffs.map((l) => l.id));
  for (const l of voucherLeads) if (!present.has(l.id)) merged.push(l);
  return sortHandoffWithPendingVouchers(merged);
}

/**
 * El orden de «Por llamar»: primero los que piden atención, luego la última
 * interacción más reciente, y el id como desempate estable. Es el mismo orden
 * que antes hacía la base (`DESC` deja los nulos primero, como Postgres).
 */
export function sortPorLlamar<T extends Pick<LeadRow, "id" | "needs_attention" | "last_interaction_at">>(rows: T[]): T[] {
  const desc = (a: string | null | undefined, b: string | null | undefined) => {
    if (a == b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return a < b ? 1 : -1;
  };
  return [...rows].sort(
    (a, b) =>
      Number(Boolean(b.needs_attention)) - Number(Boolean(a.needs_attention)) ||
      desc(a.last_interaction_at, b.last_interaction_at) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

async function drainLeads(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: (select?: string, count?: "exact") => any,
): Promise<LeadRow[]> {
  // PostgREST caps one response at ~1000 rows even when `.limit()` asks for
  // more. The queue's facets and chart drill-downs run client-side, so they must
  // receive the same complete universe that the paginated insights query uses.
  //
  // La primera página se pide con `count: "exact"`: PostgREST lo resuelve en la
  // MISMA consulta, así que sale gratis y nos dice cuántas páginas faltan. Con
  // eso el resto se piden TODAS A LA VEZ en lugar de una tras otra — con 2.500
  // leads eso pasa de tres viajes encadenados a dos. Si el servidor no devuelve
  // el total (mock, versión antigua), se cae al drenado secuencial de siempre.
  const rows: LeadRow[] = [];
  let select = LEAD_BOARD_SELECT;
  let first = await buildQuery(select, "exact").range(0, LEADS_PAGE_SIZE - 1);
  if (first.error && select !== LEAD_BOARD_SELECT_LEGACY) {
    select = LEAD_BOARD_SELECT_LEGACY;
    first = await buildQuery(select, "exact").range(0, LEADS_PAGE_SIZE - 1);
  }
  if (first.error) return [];
  const firstBatch = (first.data as unknown as LeadRow[] | null) ?? [];
  rows.push(...firstBatch);
  if (firstBatch.length < LEADS_PAGE_SIZE) return rows;

  const total = first.count != null ? Math.min(first.count, LEADS_PAGE_CAP) : null;
  if (total != null) {
    const offsets: number[] = [];
    for (let from = LEADS_PAGE_SIZE; from < total; from += LEADS_PAGE_SIZE) offsets.push(from);
    const pages = await Promise.all(
      offsets.map((from) => buildQuery(select).range(from, from + LEADS_PAGE_SIZE - 1)),
    );
    for (const page of pages) {
      // Un fallo a media tanda dejaría un HUECO en la cola (las páginas
      // siguientes ya no encajan), así que se corta ahí en vez de concatenar.
      if (page.error) break;
      rows.push(...((page.data as unknown as LeadRow[] | null) ?? []));
    }
    return rows;
  }

  for (let from = LEADS_PAGE_SIZE; from < LEADS_PAGE_CAP; from += LEADS_PAGE_SIZE) {
    const res = await buildQuery(select).range(from, from + LEADS_PAGE_SIZE - 1);
    if (res.error) break;
    const batch = (res.data as unknown as LeadRow[] | null) ?? [];
    rows.push(...batch);
    if (batch.length < LEADS_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Cobertura del último pedido del mismo teléfono, por lead de «Por llamar»
 * (0225). Es la pista del filtro de cobertura cuando el lead no dejó dirección.
 *
 * Vacío si la migración no corrió o la consulta falla: la cola se dibuja igual
 * y esos leads quedan «Sin identificar», que es lo que eran antes.
 */
export async function getLeadPriorCoverage(storeIds: StoreScope): Promise<Record<string, string>> {
  if (!storeIds.length) return {};
  const rows = await drainRpc<{ lead_id: string; coverage: string }>("lead_prior_order_coverage", {
    p_store_ids: storeIds,
  });
  const out: Record<string, string> = {};
  for (const row of rows) out[row.lead_id] = row.coverage;
  return out;
}

/**
 * La dirección que Shopify tiene del cliente, para los leads de la cola que no
 * dicen dónde viven (0228). La busca la sincronización; aquí solo se lee. Es la
 * última pista del filtro de cobertura. Vacío si la migración no corrió.
 */
export async function getLeadShopifyLocations(
  storeIds: StoreScope,
): Promise<Record<string, { province: string | null; city: string | null }>> {
  if (!storeIds.length) return {};
  const rows = await drainRpc<{ lead_id: string; province: string | null; city: string | null }>(
    "lead_shopify_location_hints",
    { p_store_ids: storeIds },
  );
  const out: Record<string, { province: string | null; city: string | null }> = {};
  for (const row of rows) out[row.lead_id] = { province: row.province, city: row.city };
  return out;
}

/**
 * Todas las filas de una función de la base, por páginas.
 *
 * PostgREST corta cada respuesta en 1.000 filas SIN avisar, y una función que
 * devuelve un conjunto no es la excepción: la pista del pedido anterior ya
 * devuelve ~800 leads, y el día que pasara de 1.000 la cola habría perdido el
 * resto en silencio. Se pide por `lead_id` para que las páginas no se pisen.
 * Ante un error devuelve lo que llegó hasta ahí (vacío si falla la primera).
 */
async function drainRpc<T extends { lead_id: string }>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const sb = await createServerSupabase();
  const out: T[] = [];
  for (let from = 0; from < LEADS_PAGE_CAP; from += LEADS_PAGE_SIZE) {
    const { data, error } = await sb
      .rpc(fn, args)
      .order("lead_id", { ascending: true })
      .range(from, from + LEADS_PAGE_SIZE - 1);
    if (error || !data) break;
    const page = data as unknown as T[];
    out.push(...page);
    if (page.length < LEADS_PAGE_SIZE) break;
  }
  return out;
}

/**
 * Las excepciones de cobertura por distrito (0121), para que el filtro de la
 * cola diga lo mismo que el pedido (Pucusana va por agencia). Las globales y
 * las de las tiendas que se miran. Vacío si falla: manda la regla general.
 */
export async function getDistrictCoverageRules(storeIds: StoreScope): Promise<DistrictCoverageRule[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("district_coverage")
    .select("store_id,district,coverage")
    .or(`store_id.is.null,store_id.in.(${storeIds.join(",")})`);
  if (error || !data) return [];
  return data as DistrictCoverageRule[];
}

export async function getLeadWithCalls(
  leadId: string,
): Promise<{ lead: LeadRow; calls: LeadCallRow[] } | null> {
  const sb = await createServerSupabase();
  const { data: lead } = await sb.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) return null;
  const row = lead as LeadRow;
  const [callsRes, draftRes] = await Promise.all([
    sb.from("lead_calls").select("*").eq("lead_id", leadId)
      .order("occurred_at", { ascending: false }),
    row.draft_order_gid
      ? sb.from("draft_orders").select("created_at,line_items")
        .eq("store_id", row.store_id).eq("draft_order_gid", row.draft_order_gid).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  return {
    lead: { ...row, cart_detail: draftRes.error ? null : leadCartDetailOf(draftRes.data) },
    calls: (callsRes.data as LeadCallRow[]) ?? [],
  };
}

/** One prior order, for the drawer's "Pedidos anteriores" list. */
export interface PriorOrder {
  name: string | null; // order name, e.g. "#AUR1234" o "#AUR900004"
  createdAt: string | null;
  amount: number; // net (total_amount − refunds); un anulado de Shopify trae su total original
  /** El pedido en el admin de SU tienda (`orderAdminLink`, MOM §38.12), en pestaña nueva. */
  adminUrl: string | null;
  /**
   * `orders.platform` (MOM §38): de qué tienda vino. Sin dato, Shopify (la lista
   * que se lee en vivo de Shopify no lo trae: todos sus pedidos son de Shopify).
   */
  platform?: OrderPlatform;
  /** Anulado en Shopify (solo la lista de Shopify lo sabe; la local ya los excluye). */
  cancelled?: boolean;
  /** Viene del historial de Shopify importado (MOM §37.7), no de `orders`. */
  fromHistory?: boolean;
}

export interface CustomerHistory {
  /** Pedidos antes, no anulados, sin el propio: los de `orders` más los del historial de Shopify (§37.7). */
  orderCount: number;
  lastOrderName: string | null;
  lastOrderAt: string | null;
  lastProduct: string | null;
  currentOrderName: string | null; // Shopify name (#AUR…) of the lead's OWN current order
  /**
   * Id INTERNO (`orders.id`) del pedido propio del lead — no el de Shopify.
   * Es la clave con la que trabaja todo lo interno (`order_master`, `shipments`,
   * `order_events`), y por tanto la que necesita el panel de guías de Aliclik.
   */
  currentOrderId: string | null;
  /** Guía ya creada para ese pedido, si la hay. Con guía no se ofrece crear otra. */
  currentOrderGuide: string | null;
  /** Si ese pedido ya tiene punto en el mapa (casi siempre, vía Shopify). */
  currentOrderHasCoordinate: boolean;
  /** Foco de salud de la API de Aliclik, para el panel de crear guía. */
  currentOrderAliclikHealth: AliclikHealthState;
  recentOrders: PriorOrder[]; // last 3 prior orders (excl. own), newest first
  /**
   * Sus carritos anteriores: ¿termina la compra o solo deja carritos? (MOM §11,
   * 25-10-2026, `getCustomerCarts`). Lo rellena quien carga la ficha; null si no
   * se pudo leer o no hay celular.
   */
  carts?: CustomerCarts | null;
}

const PRIOR_ORDER_COLUMNS = "id, shopify_order_id, name, created_at, total_amount, total_refunded, line_items";

/**
 * Prior purchase history for a phone — powers the "cliente recurrente" pill, the
 * "Pedidos anteriores" list, and the current order's Shopify name in the drawer.
 * RLS-scoped (only stores the caller may access). Excludes the lead's own order
 * from the prior list, but resolves its name separately for the footer.
 *
 * Desde el 25-10-2026 (MOM §37.7) también lee el historial de Shopify
 * importado (`shopify_history_orders`, mismo celular normalizado y tienda), en
 * paralelo con `orders`: así la clienta que compró antes de que Kapta existiera
 * no sale como «cliente nuevo». Un pedido que ya está en `orders` (mismo
 * número) cuenta una vez. Solo lee: el historial nunca se copia a `orders`.
 */
export async function getCustomerHistory(
  storeId: string,
  phone: string | null,
  excludeOrderId?: string | null,
  shopDomain?: string | null,
  /** `stores.woo_site_url`: el enlace de un pedido de WooCommerce (MOM §38.12). */
  wooSiteUrl?: string | null,
): Promise<CustomerHistory | null> {
  const sb = await createServerSupabase();

  // The lead's own current order name (#AUR…) — resolved by id so it's reliable
  // regardless of phone formatting. Junto con él, si ese pedido YA tiene guía:
  // el drawer usa las dos cosas para decidir si ofrecer crear una en Aliclik.
  let currentOrderName: string | null = null;
  let currentOrderGuide: string | null = null;
  let currentOrderHasCoordinate = false;
  let currentOrderAliclikHealth: AliclikHealthState = { quote: "sin_monitoreo", create: "sin_datos" };
  if (excludeOrderId) {
    const [cur, master] = await Promise.all([
      sb.from("orders").select("name").eq("id", excludeOrderId).maybeSingle(),
      sb
        .from("order_master")
        .select("guide_code,latitude,longitude,store_id")
        .eq("order_id", excludeOrderId)
        .maybeSingle(),
    ]);
    currentOrderName = (cur.data as { name: string | null } | null)?.name ?? null;
    const m = master.data as {
      guide_code: string | null;
      latitude: number | null;
      longitude: number | null;
      store_id: string | null;
    } | null;
    currentOrderGuide = m?.guide_code ?? null;
    currentOrderHasCoordinate = m?.latitude != null && m?.longitude != null;
    currentOrderAliclikHealth = await loadAliclikHealthState(sb, m?.store_id ?? null);
  }
  const own = {
    currentOrderName,
    currentOrderId: excludeOrderId ?? null,
    currentOrderGuide,
    currentOrderHasCoordinate,
    currentOrderAliclikHealth,
  };

  // Sin teléfono no hay historial de compras que buscar, pero el pedido propio sí
  // existe. Antes se salía aquí devolviendo null y el drawer se quedaba sin saber
  // que el lead tenía un pedido sin guía.
  if (!phone) return { ...emptyPrior, ...own, recentOrders: [] };

  // Los de Kapta, anulados incluidos: el anulado no cuenta, pero su número
  // descarta la copia del historial de Shopify que aún lo tenía vivo.
  const readOrders = (columns: string) =>
    sb
      .from("orders")
      .select(columns)
      .eq("store_id", storeId)
      .eq("customer_phone", phone)
      .order("created_at", { ascending: false })
      .limit(HISTORY_PRIOR_LIMIT);
  // Con `platform` (0274): el enlace de cada pedido va al admin de su tienda
  // (MOM §38.12). Sin la columna, se repite sin ella y todos son de Shopify.
  const readLocal = async () => {
    const res = await readOrders(`${PRIOR_ORDER_COLUMNS}, cancelled_at, platform`);
    return res.error ? readOrders(`${PRIOR_ORDER_COLUMNS}, cancelled_at`) : res;
  };
  const [ordersRes, history] = await Promise.all([readLocal(), readShopifyHistory(sb, storeId, phone)]);
  const rows =
    (ordersRes.data as unknown as (LocalPriorRow & {
      shopify_order_id: string | null;
      total_amount: number | null;
      total_refunded: number | null;
      platform?: unknown;
    })[]) ?? [];
  const { entries, count } = combinePriorOrders(rows, history.rows, {
    excludeOrderId,
    currentOrderName,
    historyTotal: history.total,
  });
  if (!entries.length) return { ...emptyPrior, ...own, recentOrders: [] };
  const last = entries[0]!;
  const recentOrders: PriorOrder[] = entries.slice(0, 3).map((e) => {
    if (e.kind === "history") {
      // Del archivo (§37): sin enlace, la tienda puede ya no existir.
      return {
        name: e.row.order_name,
        createdAt: e.row.created_at,
        amount: historyNetAmount(e.row),
        adminUrl: null,
        platform: "shopify",
        fromHistory: true,
      };
    }
    const r = e.row;
    const platform = orderPlatform(r.platform);
    return {
      name: r.name,
      createdAt: r.created_at,
      amount: Math.round(((r.total_amount ?? 0) - (r.total_refunded ?? 0)) * 100) / 100,
      adminUrl: orderAdminLink({ platform, shopifyOrderId: r.shopify_order_id, shopDomain, wooSiteUrl })?.url ?? null,
      platform,
    };
  });
  return {
    orderCount: count,
    lastOrderName: last.kind === "history" ? last.row.order_name : last.row.name,
    lastOrderAt: last.createdAt,
    lastProduct: firstProductTitle(last.row.line_items),
    ...own,
    recentOrders,
  };
}

/**
 * Los pedidos del historial de Shopify (§37) del mismo celular y tienda, para
 * «Pedidos antes» (§37.7). Una consulta por el índice (store_id, phone_norm) de
 * la 0273, con límite y el conteo exacto. Si falla (sin la tabla, sin permiso),
 * nada: la ficha queda como antes, solo con `orders`. Nunca escribe.
 */
async function readShopifyHistory(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeId: string,
  phone: string,
): Promise<{ rows: HistoryPriorRow[]; total: number | null }> {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) return { rows: [], total: null };
  try {
    const { data, error, count } = await sb
      .from("shopify_history_orders")
      .select("order_name, created_at, total, refunded_amount, line_items", { count: "exact" })
      .eq("store_id", storeId)
      .eq("phone_norm", phoneNorm)
      .is("cancelled_at", null)
      .order("created_at", { ascending: false })
      .limit(HISTORY_PRIOR_LIMIT);
    if (error || !data) return { rows: [], total: null };
    return { rows: data as HistoryPriorRow[], total: typeof count === "number" ? count : null };
  } catch {
    return { rows: [], total: null };
  }
}

/** Cuántos carritos de una clienta se leen de cada fuente: de sobra para contar y listar. */
const CUSTOMER_CARTS_LIMIT = 200;

/**
 * Los carritos anteriores de la clienta en ESTA tienda (lib/customer-carts.ts):
 * el espejo `draft_orders` y el archivo de Shopify `shopify_history_carts`
 * (MOM §37.6), por su celular en cualquiera de sus formas. Sin el carrito del
 * propio lead. Con RLS: solo tiendas que quien mira puede ver. Null si una
 * lectura falla —la ficha sale sin el bloque, nunca con un conteo a medias—.
 */
export async function getCustomerCarts(
  storeId: string,
  phone: string | null,
  excludeDraftGid?: string | null,
): Promise<CustomerCarts | null> {
  const phones = cartPhoneVariants(phone);
  // Sin celular no hay por dónde buscar: como «Pedidos anteriores», sin carritos.
  if (!phones.length) return { summary: summarizeCarts([]), carts: [] };
  const sb = await createServerSupabase();
  const [mirrorRes, archiveRes] = await Promise.all([
    sb
      .from("draft_orders")
      .select("shopify_draft_order_id,draft_order_gid,name,status,created_at,total_amount,line_items,order_gid")
      .eq("store_id", storeId)
      .in("customer_phone", phones)
      .order("created_at", { ascending: false })
      .limit(CUSTOMER_CARTS_LIMIT),
    sb
      .from("shopify_history_carts")
      .select("cart_key,kind,name,status,created_at,total,order_name,line_items")
      .eq("store_id", storeId)
      .in("phone_norm", phones)
      .order("created_at", { ascending: false })
      .limit(CUSTOMER_CARTS_LIMIT),
  ]);
  if (mirrorRes.error || archiveRes.error) return null;
  const mirror = (mirrorRes.data ?? []) as (MirrorDraftRow & { order_gid: string | null })[];

  // El pedido en que terminó un borrador del espejo: su `order_gid` es el id de
  // Shopify del pedido, que en `orders` vive sin el prefijo.
  const orderIds = [...new Set(mirror.map((row) => row.order_gid?.match(/(\d+)$/)?.[1]).filter((v): v is string => Boolean(v)))];
  if (orderIds.length) {
    const { data } = await sb.from("orders").select("shopify_order_id,name").eq("store_id", storeId).in("shopify_order_id", orderIds);
    const names = new Map(((data ?? []) as { shopify_order_id: string; name: string | null }[]).map((o) => [o.shopify_order_id, o.name]));
    for (const row of mirror) {
      const id = row.order_gid?.match(/(\d+)$/)?.[1];
      row.order_name = id ? (names.get(id) ?? null) : null;
    }
  }

  const carts = mergeCustomerCarts(mirror, (archiveRes.data ?? []) as ArchiveCartRow[], excludeDraftGid);
  return { summary: summarizeCarts(carts), carts };
}

/** Valores neutros del bloque "cliente recurrente" cuando no hay compras previas. */
const emptyPrior = {
  orderCount: 0,
  lastOrderName: null,
  lastOrderAt: null,
  lastProduct: null,
} as const;

/** View counts + `sin_llamar` (status `nuevo`), the default queue tab + burndown anchor. */
export type LeadCounts = Record<LeadView, number> & { sin_llamar: number };

/**
 * Conteos + FIRMA de la cola de una tienda.
 *
 * La firma resume el estado de `leads` para esa tienda en una cadena corta
 * (cuántos hay + cuándo se tocó el último). El refresco en vivo la compara con
 * la que ya tiene: si no cambió, no recarga NADA. Antes recargaba la página
 * entera —los ~2.500 leads de la cola, los siete conteos y el panel de
 * gráficos— cada 30 segundos aunque no hubiera pasado absolutamente nada.
 */
export interface LeadQueueSnapshot {
  counts: LeadCounts;
  signature: string;
}

const ZERO_COUNTS: LeadCounts = {
  por_llamar: 0,
  handoff: 0,
  yape: 0,
  seguimientos: 0,
  ganados: 0,
  perdidos: 0,
  sin_llamar: 0,
};

/**
 * Conteos y firma de la cola para el alcance actual.
 *
 * El RPC `lead_queue_counts` (0059) recibe UNA tienda, así que con varias se
 * llama una vez por tienda y se suman. Se hace así, y no cambiando la firma de
 * la función SQL, porque sumar siete enteros en memoria no se nota y tocar la
 * función obligaría a una migración que hay que aplicar a mano antes de que el
 * código salga — un desfase que ya dejó la cola en cero una vez.
 *
 * La firma CONCATENA las de cada tienda en orden fijo. Si se sumaran o se usara
 * solo la de una, un cambio en la tienda B no movería la firma y el refresco
 * automático se quedaría dormido justo cuando hay trabajo nuevo.
 */
export async function getLeadQueueSnapshot(storeIds: StoreScope): Promise<LeadQueueSnapshot> {
  if (!storeIds.length) return { counts: { ...ZERO_COUNTS }, signature: "empty" };
  const sb = await createServerSupabase();
  const nowIso = new Date().toISOString();

  // A la par de los conteos por tienda: ver `pendingVoucherHandoffExtra` abajo.
  const vouchersPromise = pendingVoucherHandoffExtra(sb, storeIds);
  const perStore = await Promise.all(
    // Orden fijo: la firma es una comparación de cadenas, y con las tiendas en
    // otro orden parecería que cambió algo en cada recarga.
    [...storeIds].sort().map(async (storeId) => {
      // Camino normal (migración 0059): un solo recorrido de la tabla devuelve
      // los siete conteos y la firma.
      const rpc = await sb
        .rpc("lead_queue_counts", {
          p_store_id: storeId,
          p_handoff_cutoff: handoffFreshCutoffIso(),
          p_now: nowIso,
        })
        .maybeSingle();
      const row = rpc.data as Record<string, number | string | null> | null;
      if (!rpc.error && row) {
        const n = (key: string) => Number(row[key] ?? 0) || 0;
        return {
          counts: {
            por_llamar: n("por_llamar"),
            handoff: n("handoff"),
            yape: n("yape"),
            seguimientos: n("seguimientos"),
            ganados: n("ganados"),
            perdidos: n("perdidos"),
            sin_llamar: n("sin_llamar"),
          },
          signature: `${n("total")}:${String(row.last_change ?? "")}`,
        };
      }

      // La app puede desplegarse antes de aplicar 0059. Sin este camino la cola
      // se quedaría SIN contadores (los siete a cero), que es peor que ir lento.
      const counts = await legacyLeadCounts(sb, [storeId], nowIso);
      // Sin `last_change` la firma solo capta cambios de pertenencia (entra/sale
      // de una pestaña). El refresco de seguridad periódico cubre el resto.
      return { counts, signature: `legacy:${Object.values(counts).join(",")}` };
    }),
  );

  const counts = { ...ZERO_COUNTS };
  for (const part of perStore) {
    for (const key of Object.keys(counts) as (keyof LeadCounts)[]) {
      counts[key] += part.counts[key];
    }
  }
  // «Atender ahora» también lista a quien espera la validación de su
  // comprobante (MOM §16.1, `withPendingVoucherLeads`). El contador suma los
  // que NO estaban ya por un handoff, para decir lo mismo que la lista; y la
  // firma lleva quiénes son, para que el refresco en vivo se entere cuando
  // alguien valida y el lead sale.
  const vouchers = await vouchersPromise;
  counts.handoff += vouchers.extra;
  return {
    counts,
    signature: perStore.map((p) => p.signature).join("|") + (vouchers.signature ? `|cv:${vouchers.signature}` : ""),
  };
}

/** Nunca tumba los contadores: si falla, se cuentan como antes. */
async function pendingVoucherHandoffExtra(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: StoreScope,
): Promise<{ extra: number; signature: string }> {
  try {
    return await countExtraPendingVoucherLeads(sb, storeIds, handoffFreshCutoffIso());
  } catch {
    return { extra: 0, signature: "" };
  }
}

export async function getLeadCounts(storeIds: StoreScope): Promise<LeadCounts> {
  return (await getLeadQueueSnapshot(storeIds)).counts;
}

async function legacyLeadCounts(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: StoreScope,
  nowIso: string,
): Promise<LeadCounts> {
  const head = () =>
    sb.from("leads").select("*", { count: "exact", head: true }).in("store_id", storeIds);
  const [porLlamar, handoff, yape, seguimientos, ganados, perdidos, sinLlamar] = await Promise.all([
    head().in("category", ["open", "hot"]).neq("status", "yape_por_verificar"),
    head().eq("needs_attention", true).gte("handoff_at", handoffFreshCutoffIso()), // "Atender ahora"
    head().eq("status", "yape_por_verificar"),
    head().not("next_followup_at", "is", null).lte("next_followup_at", nowIso),
    head().eq("category", "won"),
    head().eq("category", "lost"),
    head().in("category", ["open", "hot"]).eq("status", "nuevo"), // "Sin llamar"
  ]);
  return {
    por_llamar: porLlamar.count ?? 0,
    handoff: handoff.count ?? 0,
    yape: yape.count ?? 0,
    seguimientos: seguimientos.count ?? 0,
    ganados: ganados.count ?? 0,
    perdidos: perdidos.count ?? 0,
    sin_llamar: sinLlamar.count ?? 0,
  };
}

/**
 * Informe de anomalías de ingesta. Ver 0107.
 *
 * NO va en la cabecera de Leads: ahí las asesoras leen trabajo accionable
 * ("sin llamar", "atender ahora") y un contador de diagnóstico es ruido en lo
 * único que miran todo el día. Vive en Tiendas, que además ya redirige a las
 * vendedoras — o sea que queda invisible para ellas por construcción.
 *
 * Se lee bajo el cliente de SESIÓN, así que la RLS decide qué tiendas entran.
 * Nunca lanza: es un indicador de salud y no debe tumbar la página.
 */
export async function getAnomalyReport(
  storeIds: StoreScope,
  timezone = "America/Lima",
  days = 7,
): Promise<AnomalyReport> {
  if (!storeIds.length) return EMPTY_REPORT;
  const hoy = localDay(timezone, 0);
  const ayer = localDay(timezone, -1);
  const desde = localDay(timezone, -(days - 1));
  try {
    const sb = await createServerSupabase();
    const { data, error } = await sb
      .from("ingest_anomalies")
      .select("store_id,dia,source,reason,count,sample,last_seen_at")
      .in("store_id", storeIds)
      .gte("dia", desde);
    if (error) return EMPTY_REPORT;
    return buildAnomalyReport((data as unknown as AnomalyRow[]) ?? [], hoy, ayer);
  } catch {
    return EMPTY_REPORT;
  }
}

/**
 * Los pedidos recientes de un teléfono en una tienda, para avisar antes de
 * crear otro. Ver `lib/pedido-duplicado.ts` para qué se hace con ellos.
 *
 * Se comparan SOLO LOS DÍGITOS: el mismo cliente llega como `+51 999 888 777`,
 * `51999888777` y `999888777` según por dónde entre, y un aviso que no salta
 * porque sobraba un espacio no protege de nada.
 */
export async function getPedidosRecientesPorTelefono(
  storeId: string,
  phone: string,
  dias = 45,
): Promise<PedidoPrevio[]> {
  const digitos = phone.replace(/\D/g, "");
  if (!storeId || digitos.length < 6) return [];
  const sb = await createServerSupabase();
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();

  // Se traen los del rango y se comparan los dígitos en TS: la columna guarda el
  // teléfono con el formato con el que llegó, así que un `eq` se perdería la
  // mitad y un `like` por sufijo no puede usar índice igual.
  const { data } = await sb
    .from("orders")
    .select("id,name,created_at,total_amount,customer_phone,line_items")
    .eq("store_id", storeId)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(500);

  const suyos = ((data ?? []) as unknown as {
    id: string;
    name: string | null;
    created_at: string;
    total_amount: number | null;
    customer_phone: string | null;
    line_items: unknown;
  }[]).filter((o) => (o.customer_phone ?? "").replace(/\D/g, "") === digitos);
  if (!suyos.length) return [];

  // El estado vive en `order_master`, no en `orders`: es lo que distingue un
  // pedido vivo de uno anulado, y esa distinción es la mitad de la regla.
  const estados = new Map<string, string | null>();
  const { data: master } = await sb
    .from("order_master")
    .select("order_id,general_status")
    .in("order_id", suyos.map((o) => o.id));
  for (const m of (master ?? []) as { order_id: string; general_status: string | null }[]) {
    estados.set(m.order_id, m.general_status);
  }

  return suyos.map((o) => ({
    order_id: o.id,
    name: o.name,
    created_at: o.created_at,
    total_amount: o.total_amount,
    general_status: estados.get(o.id) ?? null,
    titulos: (Array.isArray(o.line_items) ? o.line_items : [])
      .map((li) => String((li as Record<string, unknown>)?.title ?? "").trim())
      .filter(Boolean),
  }));
}
