"use server";

// Liquidaciones 2 — acciones de la pantalla del motorizado (MOM §30.9).
//
// Guarda: el usuario debe tener ficha de motorizado (`riders.user_id`) y la
// hoja debe ser la suya (`sheets.config.rider_id`). No se mira el rol: un
// coordinador con ficha también puede usarla, y un motorizado sin ficha no
// tiene hoja que tocar. Todo escribe con el service role tras esa comprobación
// y deja historial por celda; la RLS de 0171 es la red de seguridad de lectura.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMyRider } from "@/lib/routes-access";
import { statusLookupForSheet } from "@/lib/sheets/reparto-import-db";
import { getRiderSheet, loadRiderManifestPackages, loadRiderOrders, searchRiderOrders, type RiderOrderCandidate } from "@/lib/sheets/rider-access";
import { syncStopsToSheet } from "@/lib/sheets/stop-sync";
import {
  buildNewPoint,
  buildRiderPointChanges,
  diffChanges,
  needsReason,
  type RiderPointInput,
} from "@/lib/sheets/rider-cuaderno";
import { normalizeAlias } from "@/lib/sheets/statuses";
import { normalizeOrderCode } from "@/lib/sheets/reparto-import";
import type { CellValue, StatusEffect, StoredRow } from "@/lib/sheets/types";

export interface RiderActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const PATH = "/reparto/cuaderno";

async function guard() {
  const user = await getCurrentUser();
  if (!user) return { error: "No autenticado." as const };
  const rider = await getMyRider();
  if (!rider) return { error: "Tu usuario no tiene ficha de motorizado." as const };
  const sheet = await getRiderSheet(rider.id);
  if (!sheet) return { error: "Todavía no tienes hoja de reparto. Pide que la creen desde Liquidaciones 2." as const };
  return { user, rider, sheet, admin: createAdminSupabase() };
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function loadRow(admin: ReturnType<typeof createAdminSupabase>, sheetId: string, rowKey: string): Promise<StoredRow | null> {
  const { data } = await admin
    .from("sheet_rows")
    .select("id,sheet_id,order_id,row_key,values,source,updated_at")
    .eq("sheet_id", sheetId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return (data as StoredRow | null) ?? null;
}

async function writeHistory(
  admin: ReturnType<typeof createAdminSupabase>,
  rowId: string,
  diff: Record<string, { previous: CellValue; next: CellValue }>,
  actor: string,
  reason: string | null,
) {
  const entries = Object.entries(diff).map(([column_key, d]) => ({
    row_id: rowId,
    column_key,
    previous_value: d.previous,
    new_value: d.next,
    reason,
    actor,
  }));
  if (!entries.length) return;
  const { error } = await admin.from("sheet_cell_history").insert(entries);
  if (error) throw new Error(`Se guardó pero no el historial: ${error.message}`);
}

/**
 * Guarda lo que tecleó el motorizado en un punto. Si cobró distinto a lo que
 * dice Kapta en una entrega, exige motivo y abre (o actualiza) la observación
 * de monto de esa fila.
 */
export async function saveRiderPoint(input: {
  rowKey: string;
  estado: string | null;
  efectivo: unknown;
  a_cobrar: unknown;
  metodo_pago: string | null;
  observacion_1: string | null;
  comprobante_path?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
}): Promise<RiderActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  const row = await loadRow(g.admin, g.sheet.id, input.rowKey);
  if (!row) return { ok: false, error: "Ese punto no está en tu cuaderno." };

  const lookup = await statusLookupForSheet(g.admin, g.sheet);
  const point: RiderPointInput = {
    estado: input.estado,
    efectivo: num(input.efectivo),
    a_cobrar: num(input.a_cobrar),
    metodo_pago: input.metodo_pago?.trim() || null,
    observacion_1: input.observacion_1,
    comprobante_path: input.comprobante_path,
  };
  const built = buildRiderPointChanges(row.values, point, lookup);
  const nextValues = { ...row.values, ...built.changes };

  // ¿Hace falta motivo? Depende del efecto del estado resuelto y del monto de Kapta.
  let kaptaTotal: number | null = null;
  if (row.order_id) {
    const info = await loadRiderOrders([row.order_id]);
    kaptaTotal = info[row.order_id]?.order_total ?? null;
  }
  const estado = typeof nextValues.estado === "string" ? nextValues.estado : null;
  let effect: StatusEffect | null = null;
  if (estado) {
    const { data: st } = await g.admin
      .from("sheet_domain_statuses")
      .select("effect")
      .eq("domain_id", g.sheet.domain_id)
      .eq("code", estado)
      .maybeSingle();
    effect = (st?.effect as StatusEffect | undefined) ?? null;
  }
  const mustExplain = needsReason({ aCobrar: point.a_cobrar, kaptaTotal, effect });
  const reasonCode = input.reason_code?.trim() || null;
  const reasonNote = input.reason_note?.trim() || null;
  if (mustExplain && !reasonCode) {
    return { ok: false, error: `Cobraste S/ ${point.a_cobrar?.toFixed(2)} y Kapta dice S/ ${kaptaTotal?.toFixed(2)}. Explica por qué antes de guardar.` };
  }
  if (mustExplain && reasonCode === "otro" && (reasonNote?.length ?? 0) < 3) {
    return { ok: false, error: "Con motivo «Otro», escribe una nota." };
  }

  const diff = diffChanges(row.values, built.changes);
  if (Object.keys(diff).length) {
    const { error } = await g.admin
      .from("sheet_rows")
      .update({ values: nextValues, source: "manual", updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) return { ok: false, error: error.message };
    await writeHistory(g.admin, row.id, diff, g.user.id, reasonCode ? `motivo: ${reasonCode}` : null);
  }

  if (built.unknownAlias) {
    await g.admin
      .from("sheet_status_aliases")
      .upsert({ sheet_id: g.sheet.id, alias: normalizeAlias(built.unknownAlias), status_code: null, seen_count: 1 }, { onConflict: "sheet_id,alias", ignoreDuplicates: true });
  }

  if (mustExplain) {
    const { data: open } = await g.admin
      .from("sheet_observations")
      .select("id")
      .eq("sheet_id", g.sheet.id)
      .eq("row_id", row.id)
      .eq("field", "monto")
      .eq("status", "abierta")
      .maybeSingle();
    const payload = {
      external_value: point.a_cobrar === null ? null : point.a_cobrar.toFixed(2),
      kapta_value: kaptaTotal === null ? null : kaptaTotal.toFixed(2),
      difference: point.a_cobrar !== null && kaptaTotal !== null ? Math.round((point.a_cobrar - kaptaTotal) * 100) / 100 : null,
      reason_code: reasonCode,
      note: reasonNote ? `${g.rider.full_name}: ${reasonNote}` : `${g.rider.full_name} explicó desde su cuaderno`,
    };
    const { error } = open
      ? await g.admin.from("sheet_observations").update(payload).eq("id", open.id)
      : await g.admin.from("sheet_observations").insert({
          org_id: g.sheet.org_id,
          sheet_id: g.sheet.id,
          row_id: row.id,
          order_id: row.order_id,
          field: "monto",
          created_by: g.user.id,
          ...payload,
        });
    if (error) return { ok: false, error: `Se guardó el punto pero no la explicación: ${error.message}` };
  }

  revalidatePath(PATH);
  return { ok: true, message: mustExplain ? "Guardado con tu explicación. Alguien la revisará antes de cerrar el pedido." : "Guardado." };
}

export async function searchOrdersForRider(query: string): Promise<{ ok: boolean; error?: string; results: RiderOrderCandidate[] }> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error, results: [] };
  try {
    return { ok: true, results: await searchRiderOrders(g.sheet.org_id, query) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), results: [] };
  }
}

async function dayRows(admin: ReturnType<typeof createAdminSupabase>, sheetId: string, fecha: string): Promise<StoredRow[]> {
  const { data } = await admin
    .from("sheet_rows")
    .select("id,sheet_id,order_id,row_key,values,source,updated_at")
    .eq("sheet_id", sheetId)
    .filter("values->>fecha", "eq", fecha)
    .limit(500);
  return (data ?? []) as StoredRow[];
}

/** Punto nuevo del día: de un pedido de Kapta (por id) o escrito a mano. */
export async function addRiderPoint(input: {
  fecha: string;
  orderId?: string | null;
  pedido?: string | null;
  cliente?: string | null;
  tienda?: string | null;
}): Promise<RiderActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  if (!isDate(input.fecha)) return { ok: false, error: "Fecha no válida." };

  let orderId: string | null = null;
  let pedido = input.pedido?.trim() || null;
  let cliente = input.cliente?.trim() || null;
  let tienda = input.tienda?.trim() || null;
  let aCobrar: number | null = null;
  if (input.orderId) {
    const info = (await loadRiderOrders([input.orderId]))[input.orderId];
    if (!info) return { ok: false, error: "Ese pedido no existe." };
    orderId = info.order_id;
    pedido = info.order_name;
    cliente = info.customer_name;
    aCobrar = info.order_total;
    tienda = info.store_name?.toLowerCase().startsWith("aur") ? "Aurela" : info.store_name?.toLowerCase().startsWith("kenk") ? "Kenku" : tienda;
  } else if (pedido && normalizeOrderCode(pedido)) {
    const code = normalizeOrderCode(pedido)!;
    const { data: stores } = await g.admin.from("stores").select("id").eq("org_id", g.sheet.org_id);
    const { data: order } = await g.admin
      .from("orders")
      .select("id")
      .in("store_id", ((stores ?? []) as { id: string }[]).map((s) => s.id))
      .eq("name", code)
      .limit(1)
      .maybeSingle();
    if (order) {
      const info = (await loadRiderOrders([order.id]))[order.id];
      orderId = order.id;
      pedido = code;
      cliente = cliente ?? info?.customer_name ?? null;
      aCobrar = info?.order_total ?? null;
      tienda = tienda ?? (info?.store_name?.toLowerCase().startsWith("aur") ? "Aurela" : info?.store_name?.toLowerCase().startsWith("kenk") ? "Kenku" : null);
    }
  }
  if (!pedido && !cliente) return { ok: false, error: "Escribe el número de pedido o el nombre del cliente." };

  const existing = await dayRows(g.admin, g.sheet.id, input.fecha);
  const built = buildNewPoint({
    fecha: input.fecha,
    pedido,
    cliente,
    tienda,
    a_cobrar: aCobrar,
    existingPuntos: existing.map((r) => r.values.punto as string | null),
    existingKeys: new Set(existing.map((r) => r.row_key)),
  });
  const { data, error } = await g.admin
    .from("sheet_rows")
    .insert({ sheet_id: g.sheet.id, row_key: built.row_key, order_id: orderId, values: built.values, source: "manual", created_by: g.user.id })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "No se pudo crear el punto." };
  await writeHistory(
    g.admin,
    data.id,
    Object.fromEntries(Object.entries(built.values).filter(([, v]) => v !== null).map(([k, v]) => [k, { previous: null, next: v }])),
    g.user.id,
    "punto añadido desde el cuaderno",
  );
  revalidatePath(PATH);
  return { ok: true, message: `${built.values.punto} añadido.` };
}

/**
 * Trae a la hoja las PARADAS del día (la verdad de Rutas, MOM §29.12). Si no
 * hay paradas pero sí una carga de despacho que aún no se recibió, lo dice:
 * las paradas nacen al recibir la carga, no antes.
 */
export async function pullManifestPackages(fecha: string): Promise<RiderActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  if (!isDate(fecha)) return { ok: false, error: "Fecha no válida." };
  let synced;
  try {
    synced = await syncStopsToSheet(g.admin, { orgId: g.sheet.org_id, riderId: g.rider.id, date: fecha, actor: g.user.id });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!synced.stops) {
    const packages = await loadRiderManifestPackages(g.sheet.org_id, g.rider.id, fecha);
    if (packages.length) {
      return { ok: false, error: `Tu carga de ese día tiene ${packages.length} paquetes pero todavía no la recibiste. Recíbela primero en «Cargas de Grupo GF»: las paradas nacen ahí.` };
    }
    return { ok: true, message: "No hay ruta ese día." };
  }
  revalidatePath(PATH);
  revalidatePath("/reparto");
  const created = synced.created + synced.linked;
  return {
    ok: true,
    message: created
      ? `${created} paradas traídas de tu ruta${synced.updated ? `, ${synced.updated} actualizadas` : ""}.`
      : "Tu cuaderno ya tenía todas las paradas de la ruta.",
  };
}
