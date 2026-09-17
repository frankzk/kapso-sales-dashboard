// Liquidaciones 2 — lecturas y siembra. Server-only.
//
// Todo lo que toca order_master va con el service role: 0053 le quitó a
// `authenticated` la lectura directa de esa tabla, y aquí la tienda ya viene
// filtrada por getAccessibleStores() (RLS sobre stores). Las tablas de hojas
// sí tienen RLS propia (0168) y se leen con el cliente de sesión.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreSummary } from "@/lib/types";
import { districtKey, limaMonthRange } from "./resolver";
import {
  CATALOGO_ZONAS_KEY,
  DOMAIN_TEMPLATES,
  FIXED_SHEETS,
  perStoreSheetKey,
  slugify,
  type ColumnTemplate,
} from "./templates";
import { markForEffect, normalizeAlias } from "./statuses";
import seedZonas from "./seed-zonas.json";
import type {
  Contribution,
  DomainRow,
  DomainStatusRow,
  ObservationReason,
  ObservationRow,
  OrderFacts,
  SheetColumnRow,
  SheetRow,
  StatusAliasRow,
  StoredRow,
} from "./types";

export interface DomainWithStatuses extends DomainRow {
  statuses: DomainStatusRow[];
}

export interface SheetWithColumns extends SheetRow {
  columns: SheetColumnRow[];
}

export interface SheetWorkspace {
  domains: DomainWithStatuses[];
  sheets: SheetWithColumns[];
  reasons: ObservationReason[];
  openObservations: number;
}

export async function getSheetWorkspace(orgId: string): Promise<SheetWorkspace> {
  const sb = await createServerSupabase();
  const [domains, statuses, sheets, columns, reasons, open] = await Promise.all([
    sb.from("sheet_domains").select("*").eq("org_id", orgId).order("position"),
    sb
      .from("sheet_domain_statuses")
      .select("*, sheet_domains!inner(org_id)")
      .eq("sheet_domains.org_id", orgId)
      .order("position"),
    sb.from("sheets").select("*").eq("org_id", orgId).eq("active", true).order("position"),
    sb
      .from("sheet_columns")
      .select("*, sheets!inner(org_id)")
      .eq("sheets.org_id", orgId)
      .order("position"),
    sb.from("sheet_observation_reasons").select("*").order("position"),
    sb
      .from("sheet_observations")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "abierta"),
  ]);
  const statusRows = ((statuses.data ?? []) as (DomainStatusRow & { sheet_domains?: unknown })[]).map(
    ({ sheet_domains: _drop, ...row }) => row,
  );
  const columnRows = ((columns.data ?? []) as (SheetColumnRow & { sheets?: unknown })[]).map(
    ({ sheets: _drop, ...row }) => ({ ...row, options: Array.isArray(row.options) ? row.options : [] }),
  );
  return {
    domains: ((domains.data ?? []) as DomainRow[]).map((d) => ({
      ...d,
      statuses: statusRows.filter((s) => s.domain_id === d.id),
    })),
    sheets: ((sheets.data ?? []) as SheetRow[]).map((s) => ({
      ...s,
      columns: columnRows.filter((c) => c.sheet_id === s.id),
    })),
    reasons: (reasons.data ?? []) as ObservationReason[],
    openObservations: open.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Siembra
// ---------------------------------------------------------------------------

function columnInsert(sheetId: string, template: ColumnTemplate, position: number, fromTemplate = true) {
  return {
    sheet_id: sheetId,
    key: template.key,
    label: template.label,
    kind: template.kind,
    data_type: template.data_type ?? "text",
    source: template.source ?? {},
    options: template.options ?? [],
    position,
    width: template.width ?? null,
    visible: template.visible ?? true,
    pinned: template.pinned ?? false,
    required: template.required ?? false,
    from_template: fromTemplate,
  };
}

/**
 * Deja la organización con sus dominios, estados, catálogos y una hoja de
 * Pedidos y de Consolidado por tienda. Idempotente: lo que ya existe no se
 * toca, así que sirve también para crear las hojas de una tienda nueva.
 * Devuelve cuántas cosas creó, para decirlo en pantalla.
 */
export async function ensureSheetsInitialized(
  orgId: string,
  stores: readonly StoreSummary[],
  userId: string | null,
): Promise<{ domains: number; sheets: number }> {
  const admin = createAdminSupabase();
  let createdDomains = 0;
  let createdSheets = 0;

  const { data: existingDomains } = await admin.from("sheet_domains").select("id,key").eq("org_id", orgId);
  const domainIds = new Map((existingDomains ?? []).map((d: { id: string; key: string }) => [d.key, d.id]));

  for (const [position, tpl] of DOMAIN_TEMPLATES.entries()) {
    if (domainIds.has(tpl.key)) continue;
    const { data, error } = await admin
      .from("sheet_domains")
      .insert({ org_id: orgId, key: tpl.key, name: tpl.name, row_key: tpl.row_key, description: tpl.description, position })
      .select("id")
      .single();
    if (error || !data) throw new Error(`No se pudo crear el dominio ${tpl.key}: ${error?.message}`);
    domainIds.set(tpl.key, data.id);
    createdDomains += 1;
    if (tpl.statuses.length) {
      const { error: sErr } = await admin.from("sheet_domain_statuses").insert(
        tpl.statuses.map((s, i) => ({
          domain_id: data.id,
          code: s.code,
          label: s.label,
          operational_status: s.operational_status,
          effect: s.effect,
          position: i,
        })),
      );
      if (sErr) throw new Error(`No se pudieron sembrar los estados de ${tpl.key}: ${sErr.message}`);
    }
  }

  const { data: existingSheets } = await admin.from("sheets").select("id,key").eq("org_id", orgId);
  const sheetKeys = new Set((existingSheets ?? []).map((s: { key: string }) => s.key));

  const createSheet = async (
    key: string,
    name: string,
    domainKey: string,
    storeId: string | null,
    columns: readonly ColumnTemplate[],
    position: number,
  ): Promise<string | null> => {
    if (sheetKeys.has(key)) return null;
    const domainId = domainIds.get(domainKey);
    if (!domainId) return null;
    const { data, error } = await admin
      .from("sheets")
      .insert({ org_id: orgId, domain_id: domainId, store_id: storeId, key, name, position, created_by: userId })
      .select("id")
      .single();
    if (error || !data) throw new Error(`No se pudo crear la hoja ${key}: ${error?.message}`);
    sheetKeys.add(key);
    createdSheets += 1;
    if (columns.length) {
      const { error: cErr } = await admin
        .from("sheet_columns")
        .insert(columns.map((c, i) => columnInsert(data.id, c, i)));
      if (cErr) throw new Error(`No se pudieron crear las columnas de ${key}: ${cErr.message}`);
    }
    return data.id;
  };

  let position = 0;
  for (const fixed of FIXED_SHEETS) {
    const id = await createSheet(fixed.key, fixed.name, fixed.domain, null, fixed.columns, position++);
    if (id && fixed.key === CATALOGO_ZONAS_KEY) await seedZonasCatalog(admin, id, userId);
  }
  for (const store of stores) {
    if (store.org_id !== orgId) continue;
    for (const tpl of DOMAIN_TEMPLATES) {
      if (!tpl.perStore) continue;
      await createSheet(
        perStoreSheetKey(tpl.key, store.name),
        `${tpl.name} · ${store.name}`,
        tpl.key,
        store.id,
        tpl.columns,
        position++,
      );
    }
  }

  // Reparto propio: una hoja por motorizado. Los de la ficha de Kapta (riders)
  // más los históricos del Excel que ya no reparten, para que la historia y
  // los indicadores viejos cuadren. Alexis y Urpi NO van aquí: son couriers
  // externos (decisión del 16-09-2026).
  const repartoDomain = domainIds.get("reparto_propio");
  const repartoTpl = DOMAIN_TEMPLATES.find((d) => d.key === "reparto_propio");
  if (repartoDomain && repartoTpl) {
    const { data: riders } = await admin
      .from("riders")
      .select("id,full_name,active")
      .eq("org_id", orgId)
      .order("full_name");
    const riderRows = ((riders ?? []) as { id: string; full_name: string; active: boolean }[]).map((r) => ({
      id: r.id as string | null,
      name: r.full_name,
      active: r.active,
    }));
    const known = new Set(riderRows.map((r) => normalizeAlias(r.name)));
    for (const name of HISTORIC_RIDERS) {
      if (!known.has(normalizeAlias(name))) riderRows.push({ id: null, name, active: false });
    }
    for (const rider of riderRows) {
      const key = `reparto_${slugify(rider.name)}`;
      if (sheetKeys.has(key)) continue;
      const id = await createSheet(
        key,
        rider.active ? rider.name : `${rider.name} (histórico)`,
        "reparto_propio",
        null,
        repartoTpl.columns,
        position++,
      );
      if (id) {
        await admin
          .from("sheets")
          .update({ config: { rider_id: rider.id, rider_name: rider.name, historic: !rider.active } })
          .eq("id", id);
        await seedSheetAliases(id, "reparto_propio");
      }
    }
  }

  // Columnas y estados de plantilla que se añadieron después de crear la
  // hoja o el dominio: se agregan sin tocar lo que ya está (orden, ancho,
  // equivalencias corregidas a mano).
  await syncTemplateColumns(admin, orgId, domainIds);
  await syncTemplateStatuses(admin, domainIds);

  return { domains: createdDomains, sheets: createdSheets };
}

async function syncTemplateStatuses(admin: SupabaseClient, domainIds: Map<string, string>) {
  for (const tpl of DOMAIN_TEMPLATES) {
    const domainId = domainIds.get(tpl.key);
    if (!domainId || !tpl.statuses.length) continue;
    const { data: current } = await admin.from("sheet_domain_statuses").select("code,position").eq("domain_id", domainId);
    const have = new Set(((current ?? []) as { code: string }[]).map((s) => s.code));
    const max = Math.max(-1, ...((current ?? []) as { position: number }[]).map((s) => s.position));
    const missing = tpl.statuses.filter((s) => !have.has(s.code));
    if (!missing.length) continue;
    const { error } = await admin.from("sheet_domain_statuses").insert(
      missing.map((s, i) => ({
        domain_id: domainId,
        code: s.code,
        label: s.label,
        operational_status: s.operational_status,
        effect: s.effect,
        position: max + 1 + i,
      })),
    );
    if (error) throw new Error(`No se pudieron sincronizar los estados de ${tpl.key}: ${error.message}`);
  }
}

/** Motorizados que están en el Excel y ya no reparten: hoja histórica. */
const HISTORIC_RIDERS = ["Gera", "Marcos"] as const;

async function syncTemplateColumns(admin: SupabaseClient, orgId: string, domainIds: Map<string, string>) {
  const { data: sheets } = await admin.from("sheets").select("id,key,domain_id").eq("org_id", orgId);
  const { data: columns } = await admin
    .from("sheet_columns")
    .select("sheet_id,key,position,sheets!inner(org_id)")
    .eq("sheets.org_id", orgId);
  const bySheet = new Map<string, { keys: Set<string>; max: number }>();
  for (const c of (columns ?? []) as { sheet_id: string; key: string; position: number }[]) {
    const entry = bySheet.get(c.sheet_id) ?? { keys: new Set<string>(), max: -1 };
    entry.keys.add(c.key);
    entry.max = Math.max(entry.max, c.position);
    bySheet.set(c.sheet_id, entry);
  }
  const domainKeyById = new Map([...domainIds].map(([k, v]) => [v, k]));
  for (const sheet of (sheets ?? []) as { id: string; key: string; domain_id: string }[]) {
    const domainKey = domainKeyById.get(sheet.domain_id);
    const tpl = domainKey ? DOMAIN_TEMPLATES.find((d) => d.key === domainKey) : null;
    const fixed = FIXED_SHEETS.find((f) => f.key === sheet.key);
    const templateColumns = fixed?.columns ?? tpl?.columns ?? [];
    if (!templateColumns.length) continue;
    const entry = bySheet.get(sheet.id) ?? { keys: new Set<string>(), max: -1 };
    const missing = templateColumns.filter((c) => !entry.keys.has(c.key));
    if (!missing.length) continue;
    const { error } = await admin
      .from("sheet_columns")
      .insert(missing.map((c, i) => columnInsert(sheet.id, c, entry.max + 1 + i)));
    if (error) throw new Error(`No se pudieron sincronizar las columnas de ${sheet.key}: ${error.message}`);
  }
}

/** El catálogo de zonas del Excel: 979 distritos ya decididos por la operación. */
async function seedZonasCatalog(admin: SupabaseClient, sheetId: string, userId: string | null) {
  const rows = (seedZonas as { distrito: string; region: string; zona: string }[])
    .map((z) => ({
      sheet_id: sheetId,
      row_key: districtKey(z.distrito),
      values: { distrito: z.distrito, region: z.region, zona: normalizeZona(z.zona) },
      source: "importacion" as const,
      created_by: userId,
    }))
    .filter((r) => r.row_key);
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.row_key) ? false : (seen.add(r.row_key), true)));
  for (let i = 0; i < unique.length; i += 500) {
    const { error } = await admin
      .from("sheet_rows")
      .upsert(unique.slice(i, i + 500), { onConflict: "sheet_id,row_key", ignoreDuplicates: true });
    if (error) throw new Error(`No se pudo sembrar el catálogo de zonas: ${error.message}`);
  }
}

/** El Excel decía «Provincia» a secas; aquí se parte en COD / Sin COD y lo
 *  que no se sabe queda como «Provincia COD» hasta que alguien lo corrija. */
function normalizeZona(raw: string): string {
  const z = normalizeAlias(raw);
  if (z === "LIMA CENTRICO") return "Lima Centrico";
  if (z === "LIMA PERIFERICA") return "Lima Periferica";
  if (z === "PROVINCIA SIN COD") return "Provincia Sin COD";
  return "Provincia COD";
}

/**
 * Siembra los alias de plantilla de una hoja de Reparto propio o Courier
 * externo. Se llama al crear la hoja (iteraciones 2 y 3) y desde la
 * configuración para «volver a la plantilla».
 */
export async function seedSheetAliases(sheetId: string, domainKey: string): Promise<number> {
  const tpl = DOMAIN_TEMPLATES.find((d) => d.key === domainKey);
  if (!tpl) return 0;
  const admin = createAdminSupabase();
  const rows = tpl.statuses.flatMap((s) =>
    s.aliases.map((alias) => ({ sheet_id: sheetId, alias: normalizeAlias(alias), status_code: s.code, updated_at: new Date().toISOString() })),
  );
  if (!rows.length) return 0;
  // Un alias que alguien asignó a mano desde la pantalla gana sobre la
  // plantilla; uno que quedó «sin equivalente» tras una importación se rellena.
  const { data: current } = await admin.from("sheet_status_aliases").select("alias,status_code").eq("sheet_id", sheetId);
  const manual = new Set(
    ((current ?? []) as { alias: string; status_code: string | null }[]).filter((a) => a.status_code).map((a) => a.alias),
  );
  const toWrite = rows.filter((r) => !manual.has(r.alias));
  if (!toWrite.length) return 0;
  const { error } = await admin.from("sheet_status_aliases").upsert(toWrite, { onConflict: "sheet_id,alias" });
  if (error) throw new Error(error.message);
  return toWrite.length;
}

// ---------------------------------------------------------------------------
// Lecturas de filas
// ---------------------------------------------------------------------------

export interface FactsQuery {
  storeId: string;
  /** `2026/9` (clave de mes en hora de Lima) o null para no filtrar por mes. */
  month: string | null;
  /** Búsqueda por nº de pedido o nombre; anula el mes. */
  search: string | null;
  limit?: number;
}

const FACT_COLUMNS =
  "order_id,store_id,order_name,customer_name,customer_phone,district,province,region,coverage,shipping_mode,order_created_at,order_total,general_status,operational_status,current_courier,delivered_courier,attempt_count,delivered_at,returned_at,guide_code,orders(cancelled_at,cancel_reason)";

export async function loadOrderFacts(q: FactsQuery): Promise<OrderFacts[]> {
  const admin = createAdminSupabase();
  const limit = q.limit ?? 3000;
  let query = admin.from("order_master").select(FACT_COLUMNS).eq("store_id", q.storeId);
  const search = q.search?.trim();
  if (search) {
    const term = search.replace(/[%,]/g, "").trim();
    const withHash = term.startsWith("#") ? term : `#${term}`;
    query = query.or(`order_name.ilike.%${term}%,order_name.ilike.%${withHash}%,customer_name.ilike.%${term}%`);
  } else if (q.month) {
    const range = limaMonthRange(q.month);
    if (range) query = query.gte("order_created_at", range.from).lt("order_created_at", range.to);
  }
  const { data, error } = await query.order("order_created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`No se pudieron leer los pedidos: ${error.message}`);
  return ((data ?? []) as unknown as (Omit<OrderFacts, "cancelled_at" | "cancel_reason"> & {
    orders: { cancelled_at: string | null; cancel_reason: string | null } | null;
  })[]).map(({ orders, ...rest }) => ({
    ...rest,
    attempt_count: rest.attempt_count ?? 0,
    cancelled_at: orders?.cancelled_at ?? null,
    cancel_reason: orders?.cancel_reason ?? null,
  }));
}

export async function loadStoredRows(sheetId: string, limit = 5000): Promise<StoredRow[]> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("sheet_rows")
    .select("id,sheet_id,order_id,row_key,values,source,updated_at")
    .eq("sheet_id", sheetId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`No se pudieron leer las filas: ${error.message}`);
  return (data ?? []) as StoredRow[];
}

/** Filas guardadas de una hoja PARA los pedidos que se van a pintar: evita
 *  traer las 5.000 de una hoja grande cuando se mira un mes. */
export async function loadStoredRowsFor(sheetId: string, rowKeys: readonly string[]): Promise<StoredRow[]> {
  if (!rowKeys.length) return [];
  const sb = await createServerSupabase();
  const out: StoredRow[] = [];
  for (let i = 0; i < rowKeys.length; i += 300) {
    const { data, error } = await sb
      .from("sheet_rows")
      .select("id,sheet_id,order_id,row_key,values,source,updated_at")
      .eq("sheet_id", sheetId)
      .in("row_key", rowKeys.slice(i, i + 300));
    if (error) throw new Error(`No se pudieron leer las filas: ${error.message}`);
    out.push(...((data ?? []) as StoredRow[]));
  }
  return out;
}

export async function loadAliases(sheetId: string): Promise<StatusAliasRow[]> {
  const sb = await createServerSupabase();
  const { data } = await sb.from("sheet_status_aliases").select("*").eq("sheet_id", sheetId).order("alias");
  return (data ?? []) as StatusAliasRow[];
}

export async function loadObservations(orgId: string, sheetId: string | null, status: "abierta" | "resuelta" | null = "abierta"): Promise<ObservationRow[]> {
  const sb = await createServerSupabase();
  let q = sb.from("sheet_observations").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(300);
  if (sheetId) q = q.eq("sheet_id", sheetId);
  if (status) q = q.eq("status", status);
  const { data } = await q;
  return (data ?? []) as ObservationRow[];
}

/** Filas de una hoja con clave «punto» (o cualquier hoja con columna `fecha`)
 *  de un mes de Lima: `2026/9` → fechas que empiezan por `2026-09`. */
export async function loadStoredRowsByMonth(sheetId: string, month: string, limit = 5000): Promise<StoredRow[]> {
  const m = /^(\d{4})\/(\d{1,2})$/.exec(month);
  if (!m) return loadStoredRows(sheetId, limit);
  const prefix = `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("sheet_rows")
    .select("id,sheet_id,order_id,row_key,values,source,updated_at")
    .eq("sheet_id", sheetId)
    .like("values->>fecha", `${prefix}%`)
    .order("row_key", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`No se pudieron leer las filas: ${error.message}`);
  return (data ?? []) as StoredRow[];
}

/**
 * Aportes de las hojas de Reparto propio y Courier externo a los pedidos
 * dados (MOM §30.4): por cada fila vinculada al pedido, la marca que sale del
 * efecto de su estado. Un estado sin equivalente cuenta como T: la fila
 * existe, luego el pedido salió a ruta. Devuelve por `order_id`.
 */
export async function loadContributions(orgId: string, orderIds: readonly string[]): Promise<Map<string, Contribution[]>> {
  const out = new Map<string, Contribution[]>();
  if (!orderIds.length) return out;
  const sb = await createServerSupabase();
  const { data: statuses } = await sb
    .from("sheet_domain_statuses")
    .select("domain_id,code,effect,sheet_domains!inner(org_id)")
    .eq("sheet_domains.org_id", orgId);
  const effectByDomainCode = new Map<string, Contribution["mark"]>();
  for (const s of (statuses ?? []) as { domain_id: string; code: string; effect: "informa" | "entrega" | "devolucion" | "anulacion" }[]) {
    effectByDomainCode.set(`${s.domain_id}:${s.code}`, markForEffect(s.effect));
  }
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data, error } = await sb
      .from("sheet_rows")
      .select("order_id,values,sheet:sheets!inner(key,name,domain_id,domain:sheet_domains!inner(key))")
      .in("order_id", orderIds.slice(i, i + 300))
      .in("sheet.domain.key", ["reparto_propio", "courier_externo"]);
    if (error) throw new Error(`No se pudieron leer los aportes: ${error.message}`);
    for (const row of (data ?? []) as unknown as {
      order_id: string;
      values: Record<string, unknown>;
      sheet: { key: string; name: string; domain_id: string } | null;
    }[]) {
      if (!row.sheet || !row.order_id) continue;
      const estado = typeof row.values.estado === "string" ? row.values.estado : null;
      const mark = estado ? (effectByDomainCode.get(`${row.sheet.domain_id}:${estado}`) ?? "T") : "T";
      const list = out.get(row.order_id) ?? [];
      list.push({ sheet_key: row.sheet.name, mark });
      out.set(row.order_id, list);
    }
  }
  return out;
}
