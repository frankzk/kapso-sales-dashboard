// Disponibilidad Swayp de cada pedido del Master (`order_master.swayp_availability`).
//
// POR QUÉ EXISTE (08-10-2026). Repro Provincia tiene el filtro «Swayp ok · con
// stock» sobre sus guías, y el Master no tenía cómo preguntar lo mismo sobre
// sus pedidos: «¿a cuáles de los que están por confirmar o por despachar podría
// llevarlos Swayp hoy?». El Master filtra en la BASE —pagina de a 100 y cuenta
// el total—, así que la respuesta tiene que estar en una columna, no calcularse
// en la página.
//
// LA REGLA NO SE REESCRIBE: es `evaluateFenix`, la misma que pinta el badge y
// el filtro de Repro Provincia, con los mismos tres valores. Dos reglas para la
// misma pregunta acabarían diciendo cosas distintas sobre el mismo pedido.
//
// CUÁNDO SE CALCULA. El stock cambia con cada sync de inventario y los pedidos
// cambian de etapa a cada rato, así que no se calcula en el recálculo del
// pedido —que no se entera de que cambió el stock— sino en una pasada por
// organización: al terminar el sync de inventario y cada hora en el cron
// `swayp-inventory`. Una hora de retraso es aceptable para un filtro de
// trabajo; un valor viejo de días, no.
//
// SOLO DONDE TIENE SENTIDO: Por confirmar, Preparación, Por despachar y En
// curso. En Por cerrar y Finalizado la columna queda vacía: allí el stock de
// hoy no decide nada, y un «ok» congelado de hace semanas confundiría.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { evaluateFenix, type FenixEligibility, type FenixStockRow } from "@/lib/fenix";

export type SwaypAvailability = FenixEligibility["reason"];

/** Etapas donde se calcula. Fuera de ellas la columna queda en null. */
export const SWAYP_AVAILABILITY_STAGES = ["por_confirmar", "preparacion", "por_despachar", "en_curso"] as const;

export interface MasterSwaypInput {
  macro_stage: string | null;
  district: string | null;
  /** Provincia del ubigeo. */
  province: string | null;
  /** Departamento (Shopify lo llama `province`). */
  region: string | null;
}

type LineItem = { title?: string | null; sku?: string | null };

/**
 * La disponibilidad de UN pedido, o null si su etapa no la usa.
 *
 * El destino entra como lo lee Repro: `coverageCityOf` deriva la ciudad del
 * distrito y su provincia. Si falta la provincia del ubigeo se usa el
 * departamento, que en provincia suele coincidir con la ciudad del almacén
 * (Piura, Arequipa, Cusco…).
 */
export function swaypAvailabilityFor(
  row: MasterSwaypInput,
  stockRows: FenixStockRow[],
  lineItems: LineItem[] | null | undefined,
): SwaypAvailability | null {
  if (!row.macro_stage || !(SWAYP_AVAILABILITY_STAGES as readonly string[]).includes(row.macro_stage)) return null;
  const products = (lineItems ?? []).map((item) => ({ title: item.title ?? null, sku: item.sku ?? null }));
  return evaluateFenix(
    { city: null, district: row.district, province: row.province ?? row.region },
    stockRows,
    products,
  ).reason;
}

const PAGE = 1000;

/**
 * La pasada de todas las organizaciones activas, para el cron horario. Una
 * organización que falla no frena a las demás; se devuelve qué pasó con cada una.
 */
export async function recalcularDisponibilidadSwaypMasterTodas(
  admin: SupabaseClient,
): Promise<{ orgId: string; cambiados?: number; error?: string }[]> {
  const { data, error } = await admin.from("stores").select("org_id").eq("status", "active");
  if (error) throw new Error(`leer las organizaciones: ${error.message}`);
  const orgIds = [...new Set(((data as { org_id: string | null }[]) ?? []).map((s) => s.org_id).filter((id): id is string => !!id))];
  const out: { orgId: string; cambiados?: number; error?: string }[] = [];
  for (const orgId of orgIds) {
    try {
      out.push({ orgId, cambiados: await recalcularDisponibilidadSwaypMaster(admin, orgId) });
    } catch (e) {
      out.push({ orgId, error: e instanceof Error ? e.message : "error desconocido" });
    }
  }
  return out;
}

/**
 * Recalcula la columna para los pedidos de las tiendas de `orgId` y escribe
 * solo las filas que cambian. Devuelve cuántas cambió. Lanza si una lectura o
 * escritura falla: quien llama decide si eso tumba su respuesta.
 */
export async function recalcularDisponibilidadSwaypMaster(
  admin: SupabaseClient,
  orgId: string,
): Promise<number> {
  const { data: stores, error: storesError } = await admin.from("stores").select("id").eq("org_id", orgId);
  if (storesError) throw new Error(`leer las tiendas: ${storesError.message}`);
  const storeIds = ((stores as { id: string }[]) ?? []).map((s) => s.id);
  if (!storeIds.length) return 0;

  const { data: stock, error: stockError } = await admin
    .from("fenix_stock")
    .select("city,product,sku,quantity,unlimited")
    .eq("org_id", orgId);
  if (stockError) throw new Error(`consultar el stock Swayp: ${stockError.message}`);
  const stockRows = (stock as FenixStockRow[]) ?? [];

  // Los de las etapas que la usan, y los que ya salieron de ellas con un valor
  // puesto: a esos hay que vaciarlos.
  type Row = MasterSwaypInput & { order_id: string; swayp_availability: string | null };
  const rows: Row[] = [];
  const stages = SWAYP_AVAILABILITY_STAGES.join(",");
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,macro_stage,district,province,region,swayp_availability")
      .in("store_id", storeIds)
      .or(`macro_stage.in.(${stages}),swayp_availability.not.is.null`)
      .order("order_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leer el Master: ${error.message}`);
    const page = (data as Row[]) ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const needItems = rows.filter((r) => swaypAvailabilityFor(r, [], []) !== null).map((r) => r.order_id);
  const itemsByOrder = new Map<string, LineItem[]>();
  for (const part of chunk(needItems, 300)) {
    const { data, error } = await admin.from("orders").select("id,line_items").in("id", part);
    if (error) throw new Error(`leer los pedidos: ${error.message}`);
    for (const o of (data as { id: string; line_items: LineItem[] | null }[]) ?? []) {
      itemsByOrder.set(o.id, o.line_items ?? []);
    }
  }

  // Agrupadas por el valor nuevo: tres o cuatro `update ... in (...)` en vez de
  // una escritura por pedido.
  const changes = new Map<SwaypAvailability | null, string[]>();
  for (const r of rows) {
    const next = swaypAvailabilityFor(r, stockRows, itemsByOrder.get(r.order_id));
    if (next === r.swayp_availability) continue;
    const list = changes.get(next) ?? [];
    list.push(r.order_id);
    changes.set(next, list);
  }

  let changed = 0;
  for (const [value, ids] of changes) {
    for (const part of chunk(ids, 300)) {
      const { error } = await admin.from("order_master").update({ swayp_availability: value }).in("order_id", part);
      if (error) throw new Error(`escribir la disponibilidad Swayp: ${error.message}`);
      changed += part.length;
    }
  }
  return changed;
}
