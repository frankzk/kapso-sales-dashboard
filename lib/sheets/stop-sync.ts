// Liquidaciones 2 — sincronización parada → fila de cuaderno (MOM §29.12).
// Server-only; recibe el cliente admin para poder llamarse desde el reporte
// del motorizado, el cierre de ruta, la pantalla de Liquidaciones 2 y scripts.
//
// La parada (`delivery_stops`) es la verdad. Esta función hace que la hoja de
// Reparto propio del motorizado la refleje: una fila por parada, atada por
// `stop_id`. Reglas:
//   * Una fila `source = manual` no se pisa: solo se le rellena `stop_id` si
//     le faltaba (misma fecha y mismo pedido).
//   * Una fila importada o sincronizada se actualiza con lo que dice la parada.
//   * Sin parada no se inventa fila; sin hoja del motorizado no se hace nada.
//   * Tras escribir, se contrasta con Kapta (observaciones de monto y estado)
//     igual que tras una importación.

import type { SupabaseClient } from "@supabase/supabase-js";
import { puntoRowKey } from "./reparto-import";
import { reconcileSheetRows, type SheetRef } from "./reparto-import-db";
import { nextPuntoLabel } from "./rider-cuaderno";
import { stopToSheetValues, type BridgeOrder, type BridgeStop } from "./stop-bridge";
import type { CellValue } from "./types";

export interface StopSyncSummary {
  sheet: string | null;
  stops: number;
  created: number;
  updated: number;
  linked: number;
  keptManual: number;
  reconciled: Record<string, number>;
}

const EMPTY: StopSyncSummary = { sheet: null, stops: 0, created: 0, updated: 0, linked: 0, keptManual: 0, reconciled: {} };

interface StopRow extends BridgeStop {
  route_id: string;
  order_id: string;
  seq: number;
}

interface SheetRowLite {
  id: string;
  row_key: string;
  order_id: string | null;
  stop_id: string | null;
  source: string;
  values: Record<string, CellValue>;
}

/** La hoja de Reparto propio cuya ficha es este motorizado, si existe. */
export async function riderSheetFor(admin: SupabaseClient, orgId: string, riderId: string): Promise<SheetRef | null> {
  const { data } = await admin
    .from("sheets")
    .select("id,org_id,domain_id,key,name")
    .eq("org_id", orgId)
    .eq("active", true)
    .filter("config->>rider_id", "eq", riderId)
    .limit(1)
    .maybeSingle();
  return (data as SheetRef | null) ?? null;
}

async function loadStops(admin: SupabaseClient, orgId: string, riderId: string, date: string, stopIds?: readonly string[]): Promise<StopRow[]> {
  const { data: routes } = await admin
    .from("delivery_routes")
    .select("id")
    .eq("org_id", orgId)
    .eq("rider_id", riderId)
    .eq("route_date", date);
  const routeIds = ((routes ?? []) as { id: string }[]).map((r) => r.id);
  if (!routeIds.length) return [];
  let q = admin
    .from("delivery_stops")
    .select("id,route_id,order_id,seq,status,payment_method,collected_amount,outcome_reason,note,voucher_path,written_status,written_status_code,written_payment")
    .in("route_id", routeIds)
    .order("seq");
  if (stopIds?.length) q = q.in("id", [...stopIds]);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer las paradas: ${error.message}`);
  return (data ?? []) as StopRow[];
}

async function loadOrders(admin: SupabaseClient, orderIds: readonly string[]): Promise<Map<string, BridgeOrder>> {
  const out = new Map<string, BridgeOrder>();
  const ids = [...new Set(orderIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin
      .from("order_master")
      .select("order_id,order_name,customer_name,order_total,stores(name)")
      .in("order_id", ids.slice(i, i + 200));
    for (const m of (data ?? []) as unknown as { order_id: string; order_name: string | null; customer_name: string | null; order_total: number | string | null; stores: { name: string } | null }[]) {
      out.set(m.order_id, {
        order_name: m.order_name,
        customer_name: m.customer_name,
        order_total: m.order_total === null ? null : Number(m.order_total),
        store_name: m.stores?.name ?? null,
      });
    }
  }
  return out;
}

/** Campos que la parada decide; el resto de la fila (observación 2,
 *  reprogramar para, columnas manuales añadidas) se conserva. */
const STOP_OWNED = ["fecha", "punto", "tienda", "cliente", "pedido", "estado", "estado_reportado", "efectivo", "a_cobrar", "metodo_pago", "metodo_pago_reportado", "observacion_1", "comprobante_path", "revision"] as const;

/**
 * Sincroniza las paradas del motorizado en una fecha con su hoja. Devuelve
 * un resumen; nunca lanza por una hoja ausente (devuelve `sheet: null`).
 */
export async function syncStopsToSheet(
  admin: SupabaseClient,
  opts: { orgId: string; riderId: string; date: string; stopIds?: readonly string[]; actor?: string | null },
): Promise<StopSyncSummary> {
  const sheet = await riderSheetFor(admin, opts.orgId, opts.riderId);
  if (!sheet) return EMPTY;
  const stops = await loadStops(admin, opts.orgId, opts.riderId, opts.date, opts.stopIds);
  const summary: StopSyncSummary = { ...EMPTY, sheet: sheet.name, stops: stops.length, reconciled: {} };
  if (!stops.length) return summary;

  const orders = await loadOrders(admin, stops.map((s) => s.order_id));
  const [{ data: byStop }, { data: byDay }] = await Promise.all([
    admin
      .from("sheet_rows")
      .select("id,row_key,order_id,stop_id,source,values")
      .eq("sheet_id", sheet.id)
      .in("stop_id", stops.map((s) => s.id)),
    admin
      .from("sheet_rows")
      .select("id,row_key,order_id,stop_id,source,values")
      .eq("sheet_id", sheet.id)
      .filter("values->>fecha", "eq", opts.date)
      .limit(1000),
  ]);
  const rowsByStop = new Map(((byStop ?? []) as SheetRowLite[]).map((r) => [r.stop_id as string, r]));
  const dayRows = (byDay ?? []) as SheetRowLite[];
  const keys = new Set(dayRows.map((r) => r.row_key));
  const puntos = dayRows.map((r) => (typeof r.values.punto === "string" ? r.values.punto : null));
  const touched: string[] = [];
  const now = new Date().toISOString();

  for (const stop of stops) {
    const order = orders.get(stop.order_id) ?? null;
    let row = rowsByStop.get(stop.id) ?? null;
    if (!row) {
      // Fila del mismo día y pedido que todavía no conoce su parada: se ata.
      row = dayRows.find((r) => !r.stop_id && r.order_id === stop.order_id) ?? null;
      if (row) {
        const { error } = await admin.from("sheet_rows").update({ stop_id: stop.id, updated_at: now }).eq("id", row.id);
        if (error) throw new Error(`No se pudo atar la fila a su parada: ${error.message}`);
        row.stop_id = stop.id;
        summary.linked += 1;
      }
    }
    if (row && row.source === "manual") {
      summary.keptManual += 1;
      touched.push(row.row_key);
      continue;
    }
    const punto = row && typeof row.values.punto === "string" && row.values.punto ? row.values.punto : stop.seq > 0 ? `Punto ${String(stop.seq).padStart(2, "0")}` : nextPuntoLabel(puntos);
    const fresh = stopToSheetValues(stop, order, { fecha: opts.date, punto });
    if (row) {
      const merged: Record<string, CellValue> = { ...row.values };
      for (const key of STOP_OWNED) merged[key] = fresh[key] ?? null;
      const { error } = await admin
        .from("sheet_rows")
        .update({ values: merged, order_id: stop.order_id, source: "sincronizacion", updated_at: now })
        .eq("id", row.id);
      if (error) throw new Error(`No se pudo actualizar la fila de la parada: ${error.message}`);
      summary.updated += 1;
      touched.push(row.row_key);
      continue;
    }
    const base = puntoRowKey(opts.date, order?.order_name ?? null, order?.customer_name ?? null, keys.size + 1);
    let key = base;
    let n = 2;
    while (keys.has(key)) key = `${base}#${n++}`;
    const { error } = await admin.from("sheet_rows").insert({
      sheet_id: sheet.id,
      row_key: key,
      order_id: stop.order_id,
      stop_id: stop.id,
      values: fresh,
      source: "sincronizacion",
      created_by: opts.actor ?? null,
    });
    if (error) throw new Error(`No se pudo crear la fila de la parada: ${error.message}`);
    keys.add(key);
    puntos.push(punto);
    summary.created += 1;
    touched.push(key);
  }

  if (touched.length) {
    summary.reconciled = await reconcileSheetRows(admin, sheet, touched, `Sincronización ${opts.date} · ${sheet.name}`);
  }
  return summary;
}

/** La misma sincronización, pero solo para las paradas del mes que todavía
 *  no tienen fila. Barata: una consulta de paradas y otra de filas. */
export async function syncRiderMonthStops(
  admin: SupabaseClient,
  opts: { orgId: string; riderId: string; month: string; actor?: string | null },
): Promise<StopSyncSummary> {
  const m = /^(\d{4})\/(\d{1,2})$/.exec(opts.month);
  if (!m) return EMPTY;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = `${y}-${String(mo).padStart(2, "0")}-01`;
  const to = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-01`;
  const sheet = await riderSheetFor(admin, opts.orgId, opts.riderId);
  if (!sheet) return EMPTY;
  const { data: routes } = await admin
    .from("delivery_routes")
    .select("id,route_date")
    .eq("org_id", opts.orgId)
    .eq("rider_id", opts.riderId)
    .gte("route_date", from)
    .lt("route_date", to);
  const routeList = (routes ?? []) as { id: string; route_date: string }[];
  if (!routeList.length) return { ...EMPTY, sheet: sheet.name };
  const { data: stops } = await admin
    .from("delivery_stops")
    .select("id,route_id")
    .in("route_id", routeList.map((r) => r.id));
  const stopList = (stops ?? []) as { id: string; route_id: string }[];
  if (!stopList.length) return { ...EMPTY, sheet: sheet.name };
  const { data: rows } = await admin
    .from("sheet_rows")
    .select("stop_id")
    .eq("sheet_id", sheet.id)
    .in("stop_id", stopList.map((s) => s.id));
  const have = new Set(((rows ?? []) as { stop_id: string }[]).map((r) => r.stop_id));
  const dateOf = new Map(routeList.map((r) => [r.id, r.route_date]));
  const pending = new Map<string, string[]>();
  for (const s of stopList) {
    if (have.has(s.id)) continue;
    const date = dateOf.get(s.route_id);
    if (!date) continue;
    pending.set(date, [...(pending.get(date) ?? []), s.id]);
  }
  const total: StopSyncSummary = { ...EMPTY, sheet: sheet.name, reconciled: {} };
  for (const [date, ids] of pending) {
    const part = await syncStopsToSheet(admin, { ...opts, date, stopIds: ids });
    total.stops += part.stops;
    total.created += part.created;
    total.updated += part.updated;
    total.linked += part.linked;
    total.keptManual += part.keptManual;
    for (const [k, v] of Object.entries(part.reconciled)) total.reconciled[k] = (total.reconciled[k] ?? 0) + v;
  }
  return total;
}
