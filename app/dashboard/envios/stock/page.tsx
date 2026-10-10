import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAccessibleStores, getAdminOrgs } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { FenixStockEditor, type SyncResumen } from "@/components/fenix-stock";
import { buildFenixDemand, type DemandShipment } from "@/lib/fenix-demand";
import { env } from "@/lib/env";
import { FENIX_CITIES } from "@/lib/shipments";
import { parseSenders, resumenDeBodegas } from "@/lib/swayp-guide";
import {
  buildSwaypOportunidades,
  type OportunidadItem,
  type OportunidadMasterRow,
  type Oportunidades,
} from "@/lib/swayp-oportunidades";
import { fuenteAutomaticaDesdeEnv } from "@/lib/swayp-inventory-sync";
import type { FenixStockRowDb, OrderLineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function FenixStockPage() {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("fenix_stock")
    .select("id,org_id,city,product,sku,quantity,unlimited,updated_by,updated_at,created_at")
    .order("city")
    .order("product");
  const rows = (data as FenixStockRowDb[]) ?? [];

  const adminOrgs = await getAdminOrgs();
  const canEdit = adminOrgs.some((m) => m.role === "owner" || m.role === "admin");

  if (!rows.length && !canEdit) {
    return <EmptyState title="Sin stock de Swayp registrado" />;
  }

  // stores only source the product catalog for the picker (stock stays org-level)
  const stores = await getAccessibleStores();
  const storeIds = stores.map((s) => s.id);

  // Demand report: pending guides (what customers are asking for per province)
  // crossed with stock. Product identity prefers the linked Shopify order's
  // primary line item (same catalog the stock is keyed on).
  // Sin tiendas no hay guías que cruzar, pero el inventario se ve igual: la
  // tabla de la página es la de demanda, que trae todos los renglones de stock.
  let demand: ReturnType<typeof buildFenixDemand> = buildFenixDemand(rows, []);
  if (storeIds.length) {
    const { data: pend } = await sb
      .from("shipments")
      .select("city,product,order_id")
      .in("store_id", storeIds)
      .eq("status_category", "pending");
    const pending = (pend as { city: string | null; product: string | null; order_id: string | null }[]) ?? [];

    const orderIds = Array.from(new Set(pending.map((p) => p.order_id).filter((v): v is string => !!v)));
    const primaryByOrder = new Map<string, { title: string | null; sku: string | null }>();
    for (let i = 0; i < orderIds.length; i += 300) {
      const { data: orders } = await sb
        .from("orders")
        .select("id,line_items")
        .in("id", orderIds.slice(i, i + 300));
      for (const o of (orders as { id: string; line_items: OrderLineItem[] | null }[]) ?? []) {
        const li = o.line_items?.[0];
        if (li) primaryByOrder.set(o.id, { title: li.title ?? null, sku: li.sku ?? null });
      }
    }

    const demandShipments: DemandShipment[] = pending.map((p) => ({
      city: p.city,
      product: p.product,
      orderProduct: p.order_id ? primaryByOrder.get(p.order_id) ?? null : null,
    }));
    demand = buildFenixDemand(rows, demandShipments);
  }

  const oportunidades = storeIds.length
    ? await cargarOportunidades(sb, storeIds, rows)
    : buildSwaypOportunidades(rows, [], new Map());

  // Qué bodegas ve la app en SWAYP_SENDERS. Sólo para admins: es la única
  // forma de leer una variable Secret de Vercel sin editarla a ciegas.
  const bodegas = canEdit
    ? resumenDeBodegas(parseSenders(env.swaypSenders()), FENIX_CITIES)
    : [];

  return (
    <FenixStockEditor
      rows={rows}
      canEdit={canEdit}
      stores={stores}
      demand={demand}
      oportunidades={oportunidades}
      bodegas={bodegas}
      syncResumen={await resumenDelSync(sb, canEdit)}
    />
  );
}

/**
 * LAS OPORTUNIDADES: pedidos de Repro Provincia y de Por confirmar que saldrían
 * por Swayp si su bodega tuviera el producto (`lib/swayp-oportunidades.ts`).
 * Se leen del Master con la sesión de quien mira, así que la RLS decide qué
 * tiendas entran, igual que en el resto de la página. Si una lectura falla
 * devuelve null y la pantalla lo dice: una lista a medias se leería como «no
 * hay nada que mandar».
 */
async function cargarOportunidades(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  stock: FenixStockRowDb[],
): Promise<Oportunidades | null> {
  const PAGE = 1000;
  const master: OportunidadMasterRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("order_master")
      .select("order_id,order_name,macro_stage,macro_substage,macro_since,coverage,address,district,province,region,order_total")
      .in("store_id", storeIds)
      .or("macro_substage.eq.gestion_reproprovincia,macro_stage.eq.por_confirmar")
      .order("order_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return null;
    const page = (data as OportunidadMasterRow[]) ?? [];
    master.push(...page);
    if (page.length < PAGE) break;
  }

  const itemsByOrder = new Map<string, OportunidadItem[]>();
  const ids = master.map((m) => m.order_id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await sb.from("orders").select("id,line_items").in("id", ids.slice(i, i + 300));
    if (error) return null;
    for (const o of (data as { id: string; line_items: OrderLineItem[] | null }[]) ?? []) {
      itemsByOrder.set(
        o.id,
        (o.line_items ?? []).map((li) => ({ title: li.title ?? null, sku: li.sku ?? null, quantity: li.quantity ?? 1 })),
      );
    }
  }
  return buildSwaypOportunidades(stock, master, itemsByOrder);
}

/**
 * QUÉ TAN FRESCOS SON LOS NÚMEROS, PARA CUALQUIERA QUE MIRE. El detalle del
 * sync (`swaypInventoryEstado`) es de administrador, pero cuándo fue la última
 * sincronización y si salió bien es lo primero que necesita quien prepara lo
 * que falta mandar. Aquí no viaja ninguna credencial: fecha, origen, si salió
 * bien, cuántas ciudades cambiaron y cuántas quedaron retenidas. Lo que falta
 * configurar (nombres de variables) solo se le dice al administrador. Si la
 * lectura falla se dice así: callar o decir «todavía sin sincronizaciones»
 * confundiría un error con otro estado.
 */
async function resumenDelSync(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  canEdit: boolean,
): Promise<SyncResumen | null> {
  const auto = fuenteAutomaticaDesdeEnv();
  const sinLeer = (automaticoActivo: boolean): SyncResumen => ({
    automaticoActivo,
    faltan: [],
    ultima: null,
    retenidas: 0,
    errorDeLectura: true,
  });
  const { data: mem, error: memError } = await sb.from("memberships").select("org_id");
  if (memError) return sinLeer(false);
  const orgIds = [...new Set(((mem as { org_id: string }[]) ?? []).map((m) => m.org_id))];
  if (!orgIds.length) return null;
  const orgId = auto.ok && orgIds.includes(auto.orgId) ? auto.orgId : orgIds[0]!;
  const automaticoActivo = auto.ok && auto.orgId === orgId;
  let data: unknown[] | null;
  try {
    const r = await createAdminSupabase()
      .from("swayp_inventory_sync_runs")
      .select("created_at,source,ok,resumen")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (r.error) return sinLeer(automaticoActivo);
    data = r.data;
  } catch {
    return sinLeer(automaticoActivo);
  }
  type Run = {
    created_at: string;
    source: "cron" | "manual";
    ok: boolean;
    resumen: { ciudades?: unknown[]; retenidas?: unknown[] } | null;
  };
  const runs = (data as Run[] | null) ?? [];
  const ultima = runs[0];
  const ultimaAuto = runs.find((r) => r.source === "cron");
  return {
    automaticoActivo,
    faltan: canEdit && !auto.ok ? auto.faltan : [],
    ultima: ultima
      ? { created_at: ultima.created_at, source: ultima.source, ok: ultima.ok, cambios: ultima.resumen?.ciudades?.length ?? 0 }
      : null,
    retenidas: ultimaAuto?.ok ? (ultimaAuto.resumen?.retenidas?.length ?? 0) : 0,
    errorDeLectura: false,
  };
}
