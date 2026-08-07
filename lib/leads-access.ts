// RLS-scoped reads for the leads module (queue views, lead detail, counts).

import { createServerSupabase } from "@/lib/db";
import { shopifyOrderAdminUrl } from "@/lib/shopify";
import { resolveAliclikHealth, type AliclikHealth } from "@/lib/aliclik-health";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import {
  buildAnomalyReport,
  EMPTY_REPORT,
  localDay,
  type AnomalyReport,
  type AnomalyRow,
} from "@/lib/ingest-anomalies";

/** El foco de salud de Aliclik para la org de una tienda. Gris si no se ubica la
 * org o no hay sonda fresca. Espeja `aliclikHealthFor` de orders-master-access. */
async function aliclikHealthForStore(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeId: string | null,
): Promise<AliclikHealth> {
  if (!storeId) return "sin_monitoreo";
  const { data: store } = await sb
    .from("stores")
    .select("org_id")
    .eq("id", storeId)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return "sin_monitoreo";
  const { data } = await sb
    .from("aliclik_health_checks")
    .select("status,checked_at")
    .eq("org_id", orgId)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latest = data as { status: string; checked_at: string } | null;
  return resolveAliclikHealth(
    latest ? { status: latest.status, checkedAt: latest.checked_at } : null,
    Date.now(),
  );
}

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
  "referencia",
  "address1",
  "ship_name",
  "inbound_count",
  "first_inbound_text",
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
const LEAD_BOARD_SELECT_LEGACY = LEAD_BOARD_SELECT.split(",")
  .filter((c) => c !== "first_inbound_text")
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
 * mismo indice `(store_id, ...)` que `eq`, asi que no hay dos caminos que
 * mantener ni un `if` que se pueda olvidar en una de las siete vistas.
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
          .order("needs_attention", { ascending: false })
          .order("last_interaction_at", { ascending: false })
          .order("id", { ascending: true }); // stable pagination tie-breaker
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
    let res = await buildQuery().limit(limit);
    if (res.error) res = await buildQuery(LEAD_BOARD_SELECT_LEGACY).limit(limit);
    return (res.data as unknown as LeadRow[]) ?? [];
  }

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

export async function getLeadWithCalls(
  leadId: string,
): Promise<{ lead: LeadRow; calls: LeadCallRow[] } | null> {
  const sb = await createServerSupabase();
  const { data: lead } = await sb.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) return null;
  const { data: calls } = await sb
    .from("lead_calls")
    .select("*")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: false });
  return { lead: lead as LeadRow, calls: (calls as LeadCallRow[]) ?? [] };
}

/** One prior Shopify order, for the drawer's "Pedidos anteriores" list. */
export interface PriorOrder {
  name: string | null; // Shopify order name, e.g. "#AUR1234"
  createdAt: string | null;
  amount: number; // net (total_amount − refunds)
  adminUrl: string | null; // deep-link to the order in Shopify admin (new tab)
}

export interface CustomerHistory {
  orderCount: number; // prior non-cancelled orders for this phone (excl. the lead's own)
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
  currentOrderAliclikHealth: AliclikHealth;
  recentOrders: PriorOrder[]; // last 3 prior orders (excl. own), newest first
}

/**
 * Prior purchase history for a phone — powers the "cliente recurrente" pill, the
 * "Pedidos anteriores" list, and the current order's Shopify name in the drawer.
 * RLS-scoped (only stores the caller may access). Excludes the lead's own order
 * from the prior list, but resolves its name separately for the footer.
 */
export async function getCustomerHistory(
  storeId: string,
  phone: string | null,
  excludeOrderId?: string | null,
  shopDomain?: string | null,
): Promise<CustomerHistory | null> {
  const sb = await createServerSupabase();

  // The lead's own current order name (#AUR…) — resolved by id so it's reliable
  // regardless of phone formatting. Junto con él, si ese pedido YA tiene guía:
  // el drawer usa las dos cosas para decidir si ofrecer crear una en Aliclik.
  let currentOrderName: string | null = null;
  let currentOrderGuide: string | null = null;
  let currentOrderHasCoordinate = false;
  let currentOrderAliclikHealth: AliclikHealth = "sin_monitoreo";
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
    currentOrderAliclikHealth = await aliclikHealthForStore(sb, m?.store_id ?? null);
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

  const { data } = await sb
    .from("orders")
    .select("id, shopify_order_id, name, created_at, total_amount, total_refunded, line_items")
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .is("cancelled_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  let rows =
    (data as {
      id: string;
      shopify_order_id: string | null;
      name: string | null;
      created_at: string | null;
      total_amount: number | null;
      total_refunded: number | null;
      line_items: unknown;
    }[]) ?? [];
  if (excludeOrderId) rows = rows.filter((r) => r.id !== excludeOrderId);
  if (!rows.length) return { ...emptyPrior, ...own, recentOrders: [] };
  const last = rows[0]!;
  const items = Array.isArray(last.line_items) ? (last.line_items as { title?: string }[]) : [];
  const lastProduct = items.length ? String(items[0]?.title ?? "").trim() || null : null;
  const recentOrders: PriorOrder[] = rows.slice(0, 3).map((r) => ({
    name: r.name,
    createdAt: r.created_at,
    amount: Math.round(((r.total_amount ?? 0) - (r.total_refunded ?? 0)) * 100) / 100,
    adminUrl: shopifyOrderAdminUrl(shopDomain, r.shopify_order_id),
  }));
  return {
    orderCount: rows.length,
    lastOrderName: last.name,
    lastOrderAt: last.created_at,
    lastProduct,
    ...own,
    recentOrders,
  };
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
  return { counts, signature: perStore.map((p) => p.signature).join("|") };
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
