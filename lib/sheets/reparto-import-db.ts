// Liquidaciones 2 — aplica a la base lo que leyó el parser de una hoja de
// motorizado (lib/sheets/reparto-import.ts). Server-only; recibe el cliente
// admin para poder usarse desde la ruta de subida y desde scripts.
//
// Reglas de la importación:
//   * Una fila importada dos veces (misma clave fecha#pedido) se ACTUALIZA si
//     sigue siendo importada; si alguien la editó a mano (`source = manual`),
//     no se pisa: lo tecleado gana sobre lo re-importado.
//   * El vínculo con el pedido de Kapta se resuelve por nº de pedido dentro de
//     las tiendas de la organización. Sin pedido en Kapta la fila igual se
//     guarda (la historia de Aurela anterior a junio 2026 no está en Kapta).
//   * Los estados sin equivalente se registran como alias de la hoja con
//     `status_code = null` para que aparezcan en la configuración.
//   * Tras guardar, cada fila vinculada que declara ENTREGA se contrasta con
//     Kapta y las diferencias abren observaciones (lib/sheets/reconcile.ts):
//     monto distinto al del pedido, o pedido anulado/devuelto en Kapta. Nunca
//     se corrige nada en silencio; el resumen dice cuántas se abrieron.

import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupFromTemplates, normalizeAlias, type StatusLookup } from "./statuses";
import { parseRepartoMatrix, puntoRowValues, type ParsedReparto } from "./reparto-import";
import { countByField, planObservations, type ExistingObservation, type ReconcileOrder, type ReconcileRow } from "./reconcile";
import type { CellValue, DomainStatusRow, StatusAliasRow, StatusEffect } from "./types";

export interface RepartoImportSummary {
  sheet: string;
  blocks: number;
  rows: number;
  inserted: number;
  updated: number;
  keptManual: number;
  linked: number;
  unlinked: number;
  review: Record<string, number>;
  unknownStatuses: [string, number][];
  unknownPayments: [string, number][];
  skipped: number;
  /** Observaciones de cuadre abiertas por esta carga, por campo. */
  observations: Record<string, number>;
}

export interface SheetRef {
  id: string;
  org_id: string;
  domain_id: string;
  key: string;
  name: string;
}

export async function statusLookupForSheet(
  admin: SupabaseClient,
  sheet: { id: string; domain_id: string },
): Promise<StatusLookup> {
  const [{ data: statuses }, { data: aliases }] = await Promise.all([
    admin.from("sheet_domain_statuses").select("code,active").eq("domain_id", sheet.domain_id),
    admin.from("sheet_status_aliases").select("alias,status_code").eq("sheet_id", sheet.id),
  ]);
  const codes = new Set(
    ((statuses ?? []) as Pick<DomainStatusRow, "code" | "active">[]).filter((s) => s.active).map((s) => s.code),
  );
  const aliasMap = new Map<string, string | null>();
  for (const a of (aliases ?? []) as Pick<StatusAliasRow, "alias" | "status_code">[]) {
    aliasMap.set(normalizeAlias(a.alias), a.status_code && codes.has(a.status_code) ? a.status_code : null);
  }
  // Los códigos del dominio también valen como alias de sí mismos.
  if (!codes.size) return lookupFromTemplates([]);
  return { codes, aliases: aliasMap };
}

/** Efecto de cada estado del dominio de la hoja: qué aporta al Consolidado. */
export async function effectsForDomain(admin: SupabaseClient, domainId: string): Promise<Map<string, StatusEffect>> {
  const { data } = await admin.from("sheet_domain_statuses").select("code,effect").eq("domain_id", domainId);
  return new Map(((data ?? []) as { code: string; effect: StatusEffect }[]).map((s) => [s.code, s.effect]));
}

async function resolveOrderIds(
  admin: SupabaseClient,
  orgId: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!names.length) return out;
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
  const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
  if (!storeIds.length) return out;
  for (let i = 0; i < names.length; i += 200) {
    const { data, error } = await admin
      .from("orders")
      .select("id,name")
      .in("store_id", storeIds)
      .in("name", names.slice(i, i + 200));
    if (error) throw new Error(`No se pudieron vincular los pedidos: ${error.message}`);
    for (const o of (data ?? []) as { id: string; name: string }[]) if (!out.has(o.name)) out.set(o.name, o.id);
  }
  return out;
}

/**
 * Contrasta filas guardadas de una hoja cuaderno con Kapta y abre las
 * observaciones que falten (MOM §30.5). Se llama tras importar y tras editar
 * a mano el estado o el monto de una fila. Devuelve cuántas abrió por campo.
 */
export async function reconcileSheetRows(
  admin: SupabaseClient,
  sheet: SheetRef,
  rowKeys: readonly string[],
  note: string,
): Promise<Record<string, number>> {
  if (!rowKeys.length) return {};
  const rows: ReconcileRow[] = [];
  for (let i = 0; i < rowKeys.length; i += 250) {
    const { data, error } = await admin
      .from("sheet_rows")
      .select("id,row_key,order_id,values")
      .eq("sheet_id", sheet.id)
      .in("row_key", rowKeys.slice(i, i + 250))
      .not("order_id", "is", null);
    if (error) throw new Error(`No se pudieron leer las filas para el cuadre: ${error.message}`);
    for (const r of (data ?? []) as { id: string; row_key: string; order_id: string | null; values: Record<string, CellValue> }[]) {
      rows.push({ row_id: r.id, row_key: r.row_key, order_id: r.order_id, values: r.values ?? {} });
    }
  }
  if (!rows.length) return {};

  const orderIds = [...new Set(rows.map((r) => r.order_id!).filter(Boolean))];
  const orders = new Map<string, ReconcileOrder>();
  // Comprobantes validados: la prueba de un cobro digital (0170).
  const validated = new Set<string>();
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await admin
      .from("order_payments")
      .select("order_id")
      .eq("validation_status", "validado")
      .in("order_id", orderIds.slice(i, i + 200));
    if (error) throw new Error(`No se pudieron leer los comprobantes para el cuadre: ${error.message}`);
    for (const p of (data ?? []) as { order_id: string }[]) validated.add(p.order_id);
  }
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,general_status,order_total,orders(total_amount,cancelled_at,financial_status)")
      .in("order_id", orderIds.slice(i, i + 200));
    if (error) throw new Error(`No se pudieron leer los pedidos para el cuadre: ${error.message}`);
    for (const o of (data ?? []) as unknown as {
      order_id: string;
      general_status: string;
      order_total: number | null;
      orders: { total_amount: number | string | null; cancelled_at: string | null; financial_status: string | null } | null;
    }[]) {
      const total = o.orders?.total_amount ?? o.order_total;
      orders.set(o.order_id, {
        order_id: o.order_id,
        total_amount: total === null || total === undefined ? null : Number(total),
        general_status: o.general_status,
        cancelled_at: o.orders?.cancelled_at ?? null,
        paid: validated.has(o.order_id) || o.orders?.financial_status === "paid",
      });
    }
  }

  const rowIds = rows.map((r) => r.row_id);
  const existing: ExistingObservation[] = [];
  for (let i = 0; i < rowIds.length; i += 250) {
    const { data, error } = await admin
      .from("sheet_observations")
      .select("row_id,field,status,external_value")
      .eq("sheet_id", sheet.id)
      .in("row_id", rowIds.slice(i, i + 250));
    if (error) throw new Error(`No se pudieron leer las observaciones: ${error.message}`);
    existing.push(...((data ?? []) as ExistingObservation[]));
  }

  const effects = await effectsForDomain(admin, sheet.domain_id);
  const plans = planObservations(rows, orders, effects, existing, note);
  for (let i = 0; i < plans.length; i += 400) {
    const { error } = await admin.from("sheet_observations").insert(
      plans.slice(i, i + 400).map((p) => ({
        org_id: sheet.org_id,
        sheet_id: sheet.id,
        row_id: p.row_id,
        order_id: p.order_id,
        field: p.field,
        external_value: p.external_value,
        kapta_value: p.kapta_value,
        difference: p.difference,
        reason_code: p.reason_code,
        note: p.note,
      })),
    );
    if (error) throw new Error(`No se pudieron abrir las observaciones: ${error.message}`);
  }
  return countByField(plans);
}

export async function applyRepartoImport(
  admin: SupabaseClient,
  sheet: SheetRef,
  parsed: ParsedReparto,
  opts: { userId: string | null; filename: string | null },
): Promise<RepartoImportSummary> {
  const batchId = crypto.randomUUID();
  const names = [...new Set(parsed.rows.filter((r) => r.pedido_shopify && r.pedido).map((r) => r.pedido!))];
  const orderIds = await resolveOrderIds(admin, sheet.org_id, names);

  // Por lotes: miles de claves en una sola URL revientan la petición.
  const existingSource = new Map<string, string>();
  const keys = parsed.rows.map((r) => r.row_key);
  for (let i = 0; i < keys.length; i += 250) {
    const { data: existing, error: exErr } = await admin
      .from("sheet_rows")
      .select("row_key,source")
      .eq("sheet_id", sheet.id)
      .in("row_key", keys.slice(i, i + 250));
    if (exErr) throw new Error(`No se pudieron leer las filas existentes: ${exErr.message}`);
    for (const r of (existing ?? []) as { row_key: string; source: string }[]) existingSource.set(r.row_key, r.source);
  }

  let inserted = 0;
  let updated = 0;
  let keptManual = 0;
  let linked = 0;
  const review: Record<string, number> = {};
  const toUpsert: Record<string, unknown>[] = [];
  const writtenKeys: string[] = [];
  for (const row of parsed.rows) {
    const source = existingSource.get(row.row_key);
    if (source === "manual") {
      keptManual += 1;
      continue;
    }
    const orderId = row.pedido && row.pedido_shopify ? (orderIds.get(row.pedido) ?? null) : null;
    if (orderId) linked += 1;
    for (const reason of row.review) review[reason] = (review[reason] ?? 0) + 1;
    if (source) updated += 1;
    else inserted += 1;
    writtenKeys.push(row.row_key);
    toUpsert.push({
      sheet_id: sheet.id,
      row_key: row.row_key,
      order_id: orderId,
      values: puntoRowValues(row),
      source: "importacion",
      import_batch_id: batchId,
      created_by: opts.userId,
      updated_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < toUpsert.length; i += 400) {
    const { error } = await admin.from("sheet_rows").upsert(toUpsert.slice(i, i + 400), { onConflict: "sheet_id,row_key" });
    if (error) throw new Error(`No se pudieron guardar las filas: ${error.message}`);
  }

  if (parsed.unknownStatuses.size) {
    const rows = [...parsed.unknownStatuses].map(([alias, seen]) => ({ sheet_id: sheet.id, alias, status_code: null, seen_count: seen }));
    const { error } = await admin.from("sheet_status_aliases").upsert(rows, { onConflict: "sheet_id,alias", ignoreDuplicates: true });
    if (error) throw new Error(`No se pudieron registrar los alias: ${error.message}`);
  }

  const observations = await reconcileSheetRows(
    admin,
    sheet,
    writtenKeys,
    `Importación ${new Date().toISOString().slice(0, 10)} · ${sheet.name}`,
  );

  const summary: RepartoImportSummary = {
    sheet: sheet.name,
    blocks: parsed.blocks,
    rows: parsed.rows.length,
    inserted,
    updated,
    keptManual,
    linked,
    unlinked: parsed.rows.length - keptManual - linked,
    review,
    unknownStatuses: [...parsed.unknownStatuses].sort((a, b) => b[1] - a[1]),
    unknownPayments: [...parsed.unknownPayments].sort((a, b) => b[1] - a[1]),
    skipped: parsed.skipped,
    observations,
  };

  const { data: current } = await admin.from("sheets").select("config").eq("id", sheet.id).maybeSingle();
  await admin
    .from("sheets")
    .update({
      config: {
        ...((current?.config as Record<string, unknown>) ?? {}),
        last_import: { at: new Date().toISOString(), batch: batchId, filename: opts.filename, ...summary },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", sheet.id);
  return summary;
}

/** Lee y aplica en un paso: lo que usan la ruta de subida y el script. */
export async function importRepartoMatrix(
  admin: SupabaseClient,
  sheet: SheetRef,
  matrix: readonly (readonly string[])[],
  opts: { userId: string | null; filename: string | null },
): Promise<RepartoImportSummary> {
  const lookup = await statusLookupForSheet(admin, sheet);
  const parsed = parseRepartoMatrix(matrix, lookup);
  return applyRepartoImport(admin, sheet, parsed, opts);
}
