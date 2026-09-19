"use server";

// Liquidaciones 2 — acciones de servidor. Dos permisos (lib/permissions.ts):
// `sheets.edit` escribe celdas y observaciones; `sheets.manage` configura.
// Todo va con el service role tras comprobar el permiso y que la hoja
// pertenece a una organización del usuario: la RLS de 0168 es la red de
// seguridad, no la única puerta.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import type { Permission } from "@/lib/permissions";
import { isOperationalCode, normalizeAlias } from "@/lib/sheets/statuses";
import { ensureSheetsInitialized, seedSheetAliases } from "@/lib/sheets/access";
import { districtKey } from "@/lib/sheets/resolver";
import { normalizeOrderCode, puntoRowKey } from "@/lib/sheets/reparto-import";
import { isCuadernoSheet } from "@/lib/sheets/templates";
import { statusLookupForSheet } from "@/lib/sheets/reparto-import-db";
import { applyWrittenPayment, applyWrittenStatus } from "@/lib/sheets/written-status";
import { effectsForDomain, reconcileSheetRows, type SheetRef } from "@/lib/sheets/reparto-import-db";
import { applyDeliveriesToMaster, type MasterDoorItem } from "@/lib/master-door";
import { writeStopReport } from "@/lib/stop-report";
import { domainStatusToStop, sheetPaymentToStop } from "@/lib/sheets/stop-bridge";
import type { CellValue, ColumnDataType, StatusEffect } from "@/lib/sheets/types";

export interface SheetActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const PATH = "/dashboard/liquidaciones-2";

async function guard(permission: Permission) {
  const user = await getCurrentUser();
  if (!user) return { error: "No autenticado." as const };
  const perms = await getMasterPermissions();
  if (!perms.can(permission)) {
    return {
      error: (permission === "sheets.manage"
        ? "Tu rol no permite configurar Liquidaciones 2."
        : "Tu rol no permite editar Liquidaciones 2.") as string,
    };
  }
  const stores = await getAccessibleStores();
  const orgIds = new Set(stores.map((s) => s.org_id));
  return { user, admin: createAdminSupabase(), orgIds, stores };
}

async function sheetOrg(admin: ReturnType<typeof createAdminSupabase>, sheetId: string) {
  const { data } = await admin.from("sheets").select("id,org_id,domain_id,key").eq("id", sheetId).maybeSingle();
  return (data as { id: string; org_id: string; domain_id: string; key: string } | null) ?? null;
}

/** La hoja con nombre, config y clave de fila del dominio: lo que piden el cuadre y el cierre. */
async function sheetFull(admin: ReturnType<typeof createAdminSupabase>, sheetId: string) {
  const { data } = await admin
    .from("sheets")
    .select("id,org_id,domain_id,key,name,config,sheet_domains!inner(key,row_key)")
    .eq("id", sheetId)
    .maybeSingle();
  if (!data) return null;
  const d = data as unknown as {
    id: string; org_id: string; domain_id: string; key: string; name: string;
    config: Record<string, unknown> | null;
    sheet_domains: { key: string; row_key: "pedido" | "guia" | "punto" | "valor" | "periodo" };
  };
  return {
    ref: { id: d.id, org_id: d.org_id, domain_id: d.domain_id, key: d.key, name: d.name } satisfies SheetRef,
    config: d.config ?? {},
    domainKey: d.sheet_domains.key,
    cuaderno: isCuadernoSheet({ config: d.config }, { row_key: d.sheet_domains.row_key }),
  };
}

/** Columnas de una fila cuaderno que, al cambiar, obligan a contrastar con Kapta. */
const RECONCILE_COLUMNS = new Set(["estado", "a_cobrar", "pedido", "metodo_pago"]);

/** Columnas de una fila atada a una parada que se escriben TAMBIÉN en la parada. */
const STOP_COLUMNS = new Set(["estado", "a_cobrar", "efectivo", "metodo_pago", "observacion_1"]);

/**
 * La parada es la verdad (MOM §29.12): una edición de la hoja sobre una fila
 * con `stop_id` se escribe primero en la parada por el MISMO camino que
 * /reparto (`writeStopReport`: ruta en curso, saldo real, evidencia,
 * catálogo). Si Rutas rechaza, la edición falla con ese mensaje y la fila no
 * se toca. Un estado sin equivalente no mueve la parada (queda a revisión).
 */
async function pushRowToStop(
  admin: ReturnType<typeof createAdminSupabase>,
  sheet: { id: string; domain_id: string },
  stopId: string,
  merged: Record<string, CellValue>,
  actor: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const estado = typeof merged.estado === "string" ? merged.estado : null;
  const effects = await effectsForDomain(admin, sheet.domain_id);
  const target = domainStatusToStop(estado, estado ? (effects.get(estado) ?? null) : null);
  const { data: current } = await admin
    .from("delivery_stops")
    .select("id,order_id,route_id,status,payment_method,collected_amount,outcome_reason,photo_path,voucher_path")
    .eq("id", stopId)
    .maybeSingle();
  if (!current) return { ok: false, error: "La parada de esta fila ya no existe." };
  const { data: route } = await admin.from("delivery_routes").select("status").eq("id", current.route_id as string).maybeSingle();
  const status = target?.status ?? ((current?.status as "pendiente" | "entregado" | "no_entregado" | undefined) ?? "pendiente");
  const metodo = typeof merged.metodo_pago === "string" ? merged.metodo_pago : null;
  const method = sheetPaymentToStop(metodo) ?? (current?.payment_method as string | null) ?? null;
  const aCobrar = typeof merged.a_cobrar === "number" ? merged.a_cobrar : null;
  const efectivo = typeof merged.efectivo === "number" ? merged.efectivo : null;
  const collected = method === "efectivo" ? (efectivo ?? aCobrar) : aCobrar;
  const res = await writeStopReport(admin, {
    stopId,
    status,
    paymentMethod: status === "entregado" ? method : null,
    collectedAmount: status === "entregado" ? collected : null,
    outcomeReason: target?.outcome_reason ?? (current?.outcome_reason as string | null) ?? null,
    note: typeof merged.observacion_1 === "string" ? merged.observacion_1 : null,
    actor,
    writtenStatus: typeof merged.estado_reportado === "string" ? merged.estado_reportado : null,
    writtenStatusCode: estado,
    writtenPayment: typeof merged.metodo_pago_reportado === "string" ? merged.metodo_pago_reportado : null,
    delegated: true,
  }, {
    stop: { id: current.id as string, order_id: current.order_id as string, route_id: current.route_id as string, photo_path: (current.photo_path as string | null) ?? null, voucher_path: (current.voucher_path as string | null) ?? null },
    routeStatus: (route as { status?: string } | null)?.status,
  });
  if (!res.ok) return { ok: false, error: `Rutas no acepta el cambio: ${res.error}` };
  return { ok: true };
}

/**
 * Tras editar una fila de cuaderno: si el cambio toca estado, monto o
 * pedido, se contrasta con Kapta y se abren las observaciones que falten
 * (MOM §30.5). Devuelve un texto para la pantalla o null si no abrió nada.
 */
async function reconcileAfterEdit(
  admin: ReturnType<typeof createAdminSupabase>,
  sheetId: string,
  rowKey: string,
  columnKey: string,
): Promise<string | null> {
  if (!RECONCILE_COLUMNS.has(columnKey)) return null;
  const full = await sheetFull(admin, sheetId);
  if (!full || !full.cuaderno) return null;
  const opened = await reconcileSheetRows(admin, full.ref, [rowKey], `Edición ${new Date().toISOString().slice(0, 10)} · ${full.ref.name}`);
  const parts = Object.entries(opened).map(([field, n]) => `${n} de ${field}`);
  return parts.length ? `Se abrió una observación (${parts.join(", ")}): el valor no coincide con Kapta.` : null;
}

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------
export async function initializeSheets(orgId: string): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  if (!g.orgIds.has(orgId)) return { ok: false, error: "Organización fuera de tu acceso." };
  try {
    const created = await ensureSheetsInitialized(orgId, g.stores, g.user.id);
    revalidatePath(PATH);
    return {
      ok: true,
      message:
        created.domains + created.sheets === 0
          ? "No había nada que crear: la organización ya estaba inicializada."
          : `Creados ${created.domains} dominios y ${created.sheets} hojas.`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Configuración de columnas
// ---------------------------------------------------------------------------
export interface ColumnLayoutItem {
  key: string;
  visible: boolean;
  pinned: boolean;
  width: number | null;
  position: number;
}

export async function saveColumnLayout(sheetId: string, layout: ColumnLayoutItem[]): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  for (const item of layout) {
    const { error } = await g.admin
      .from("sheet_columns")
      .update({
        visible: item.visible,
        pinned: item.pinned,
        width: item.width && item.width > 40 ? Math.min(item.width, 800) : null,
        position: item.position,
        updated_at: new Date().toISOString(),
      })
      .eq("sheet_id", sheetId)
      .eq("key", item.key);
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath(PATH);
  return { ok: true, message: "Columnas guardadas." };
}

export async function addManualColumn(
  sheetId: string,
  input: { label: string; data_type: ColumnDataType; options?: string[] },
): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  const label = input.label.trim();
  if (label.length < 2) return { ok: false, error: "La columna necesita un nombre." };
  const base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const { data: existing } = await g.admin.from("sheet_columns").select("key,position").eq("sheet_id", sheetId);
  const keys = new Set((existing ?? []).map((c: { key: string }) => c.key));
  let key = base || "columna";
  let n = 2;
  while (keys.has(key)) key = `${base}_${n++}`;
  const position = Math.max(-1, ...(existing ?? []).map((c: { position: number }) => c.position)) + 1;
  const allowed: ColumnDataType[] = ["text", "number", "date", "select", "boolean"];
  if (!allowed.includes(input.data_type)) return { ok: false, error: "Tipo de columna no válido." };
  const options = input.data_type === "select" ? (input.options ?? []).map((o) => o.trim()).filter(Boolean) : [];
  if (input.data_type === "select" && !options.length) return { ok: false, error: "Una lista necesita opciones." };
  const { error } = await g.admin.from("sheet_columns").insert({
    sheet_id: sheetId,
    key,
    label,
    kind: "manual",
    data_type: input.data_type,
    source: {},
    options,
    position,
    from_template: false,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, message: `Columna «${label}» añadida.` };
}

// ---------------------------------------------------------------------------
// Celdas
// ---------------------------------------------------------------------------
export async function setCell(input: {
  sheetId: string;
  rowKey: string;
  orderId: string | null;
  columnKey: string;
  value: CellValue;
  reason?: string;
}): Promise<SheetActionResult> {
  const g = await guard("sheets.edit");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, input.sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };

  // En una hoja cuaderno, «Estado» y «Método de pago» se escriben libres: lo
  // tecleado se guarda tal cual y el grupo se deriva por alias (MOM §30.7).
  if (input.columnKey === "estado" || input.columnKey === "metodo_pago") {
    const { data: meta } = await g.admin
      .from("sheets")
      .select("config, sheet_domains!inner(row_key)")
      .eq("id", input.sheetId)
      .maybeSingle();
    const domainRowKey = (meta as { sheet_domains?: { row_key?: string } } | null)?.sheet_domains?.row_key;
    if (isCuadernoSheet({ config: (meta?.config as Record<string, unknown>) ?? null }, domainRowKey ? { row_key: domainRowKey as "punto" } : null)) {
      return setWrittenCell(g, sheet, input);
    }
  }

  const { data: column } = await g.admin
    .from("sheet_columns")
    .select("kind,data_type,options,required")
    .eq("sheet_id", input.sheetId)
    .eq("key", input.columnKey)
    .maybeSingle();
  if (!column) return { ok: false, error: "La columna no existe." };
  if (column.kind !== "manual") return { ok: false, error: "Solo se editan columnas manuales." };
  const value = coerce(input.value, column.data_type as ColumnDataType, (column.options as string[]) ?? []);
  if (value === undefined) return { ok: false, error: "Valor no válido para esta columna." };
  if (column.required && (value === null || value === "")) return { ok: false, error: "Esta columna es obligatoria." };

  const rowKey = input.rowKey.trim();
  if (!rowKey) return { ok: false, error: "Fila sin clave." };
  const { data: existing } = await g.admin
    .from("sheet_rows")
    .select("id,values,stop_id")
    .eq("sheet_id", input.sheetId)
    .eq("row_key", rowKey)
    .maybeSingle();
  const previous = (existing?.values as Record<string, CellValue> | undefined)?.[input.columnKey] ?? null;
  if (existing && previous === value) return { ok: true };

  if (existing?.stop_id && STOP_COLUMNS.has(input.columnKey)) {
    const pushed = await pushRowToStop(g.admin, sheet, existing.stop_id as string, { ...(existing.values as Record<string, CellValue>), [input.columnKey]: value }, g.user.id);
    if (!pushed.ok) return { ok: false, error: pushed.error };
  }

  let rowId = existing?.id as string | undefined;
  if (existing) {
    const { error } = await g.admin
      .from("sheet_rows")
      .update({
        values: { ...(existing.values as Record<string, CellValue>), [input.columnKey]: value },
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await g.admin
      .from("sheet_rows")
      .insert({
        sheet_id: input.sheetId,
        row_key: rowKey,
        order_id: input.orderId,
        values: { [input.columnKey]: value },
        source: "manual",
        created_by: g.user.id,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "No se pudo crear la fila." };
    rowId = data.id;
  }
  const { error: hErr } = await g.admin.from("sheet_cell_history").insert({
    row_id: rowId,
    column_key: input.columnKey,
    previous_value: previous,
    new_value: value,
    reason: input.reason?.trim() || null,
    actor: g.user.id,
  });
  if (hErr) return { ok: false, error: `Se guardó la celda pero no el historial: ${hErr.message}` };
  const opened = await reconcileAfterEdit(g.admin, input.sheetId, rowKey, input.columnKey);
  revalidatePath(PATH);
  return opened ? { ok: true, message: opened } : { ok: true };
}

/**
 * Estado o método de pago tecleado en una hoja cuaderno. Guarda el texto
 * literal, deriva el grupo, deja historial de cada celda que cambia y, si el
 * estado no resuelve, registra el alias sin equivalente en la hoja.
 */
async function setWrittenCell(
  g: { user: { id: string }; admin: ReturnType<typeof createAdminSupabase> },
  sheet: { id: string; domain_id: string },
  input: { sheetId: string; rowKey: string; orderId: string | null; columnKey: string; value: CellValue; reason?: string },
): Promise<SheetActionResult> {
  const rowKey = input.rowKey.trim();
  if (!rowKey) return { ok: false, error: "Fila sin clave." };
  const text = input.value === null || input.value === undefined ? "" : String(input.value);
  const { data: existing } = await g.admin
    .from("sheet_rows")
    .select("id,values,stop_id")
    .eq("sheet_id", input.sheetId)
    .eq("row_key", rowKey)
    .maybeSingle();
  const current = ((existing?.values as Record<string, CellValue> | undefined) ?? {});

  let changes: Record<string, CellValue>;
  let unknownAlias: string | null = null;
  if (input.columnKey === "estado") {
    const lookup = await statusLookupForSheet(g.admin, sheet);
    const res = applyWrittenStatus(current, text, lookup);
    changes = res.changes;
    unknownAlias = res.unknownAlias;
  } else {
    changes = applyWrittenPayment(text);
  }
  const changed = Object.entries(changes).filter(([k, v]) => (current[k] ?? null) !== v);
  if (existing && !changed.length) return { ok: true };

  if (existing?.stop_id && !unknownAlias) {
    const pushed = await pushRowToStop(g.admin, sheet, existing.stop_id as string, { ...current, ...changes }, g.user.id);
    if (!pushed.ok) return { ok: false, error: pushed.error };
  }

  let rowId = existing?.id as string | undefined;
  const merged = { ...current, ...changes };
  if (existing) {
    const { error } = await g.admin
      .from("sheet_rows")
      .update({ values: merged, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await g.admin
      .from("sheet_rows")
      .insert({ sheet_id: input.sheetId, row_key: rowKey, order_id: input.orderId, values: merged, source: "manual", created_by: g.user.id })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "No se pudo crear la fila." };
    rowId = data.id;
  }
  if (changed.length) {
    const { error: hErr } = await g.admin.from("sheet_cell_history").insert(
      changed.map(([column_key, new_value]) => ({
        row_id: rowId,
        column_key,
        previous_value: current[column_key] ?? null,
        new_value,
        reason: input.reason?.trim() || null,
        actor: g.user.id,
      })),
    );
    if (hErr) return { ok: false, error: `Se guardó la celda pero no el historial: ${hErr.message}` };
  }
  if (unknownAlias) {
    await g.admin
      .from("sheet_status_aliases")
      .upsert({ sheet_id: input.sheetId, alias: unknownAlias, status_code: null, seen_count: 1 }, { onConflict: "sheet_id,alias", ignoreDuplicates: true });
  }
  const opened = await reconcileAfterEdit(g.admin, input.sheetId, rowKey, input.columnKey);
  revalidatePath(PATH);
  if (unknownAlias) {
    return { ok: true, message: `«${text}» no tiene equivalente todavía: la fila queda a revisión. Asígnalo en «Estados y alias».` };
  }
  return opened ? { ok: true, message: opened } : { ok: true };
}

/** Convierte lo tecleado al tipo de la columna. `undefined` = inválido. */
function coerce(value: CellValue, type: ColumnDataType, options: string[]): CellValue | undefined {
  if (value === null || value === "") return null;
  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return ["1", "true", "si", "sí", "x"].includes(String(value).toLowerCase()) ? true : false;
    case "date": {
      const s = String(value).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
    }
    case "select": {
      const s = String(value).trim();
      const hit = options.find((o) => normalizeAlias(o) === normalizeAlias(s));
      return hit ?? undefined;
    }
    case "status":
      return String(value).trim();
    default:
      return String(value).trim().slice(0, 2000);
  }
}

/**
 * Fila nueva tecleada en una hoja de catálogo (clave «valor»: la primera
 * columna identifica la fila) o de reparto (clave «punto»: fecha#pedido).
 */
export async function addSheetRow(sheetId: string, values: Record<string, CellValue>): Promise<SheetActionResult> {
  const g = await guard("sheets.edit");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  const { data: columns } = await g.admin
    .from("sheet_columns")
    .select("key,kind,data_type,options,required,position")
    .eq("sheet_id", sheetId)
    .eq("kind", "manual")
    .order("position");
  const [{ data: domain }, { data: sheetCfg }] = await Promise.all([
    g.admin.from("sheet_domains").select("row_key").eq("id", sheet.domain_id).maybeSingle(),
    g.admin.from("sheets").select("config").eq("id", sheetId).maybeSingle(),
  ]);
  const cuaderno = Boolean(domain && isCuadernoSheet({ config: (sheetCfg?.config as Record<string, unknown>) ?? null }, { row_key: domain.row_key }));
  const clean: Record<string, CellValue> = {};
  for (const c of (columns ?? []) as { key: string; data_type: ColumnDataType; options: string[]; required: boolean }[]) {
    // En cuaderno, Estado y Método son texto libre: se resuelven más abajo.
    const free = cuaderno && (c.key === "estado" || c.key === "metodo_pago");
    const raw = values[c.key] ?? null;
    const v = free ? (typeof raw === "string" && raw.trim() ? raw.trim() : null) : coerce(raw, c.data_type, c.options ?? []);
    if (v === undefined) return { ok: false, error: `Valor no válido en «${c.key}».` };
    if (c.required && (v === null || v === "")) return { ok: false, error: `Falta «${c.key}».` };
    clean[c.key] = v;
  }
  let rowKey: string;
  let orderId: string | null = null;
  if (cuaderno) {
    const fecha = typeof clean.fecha === "string" ? clean.fecha : null;
    const pedido = normalizeOrderCode(typeof clean.pedido === "string" ? clean.pedido : null);
    if (!fecha) return { ok: false, error: "La fila de reparto necesita fecha." };
    if (pedido) {
      clean.pedido = pedido;
      const { data: order } = await g.admin.from("orders").select("id").eq("name", pedido).limit(1).maybeSingle();
      orderId = order?.id ?? null;
    }
    rowKey = puntoRowKey(fecha, pedido ?? (typeof clean.pedido === "string" ? clean.pedido.toLowerCase() : null), typeof clean.cliente === "string" ? clean.cliente : null, 0);
    // Estado y método se escriben libres: lo tecleado queda tal cual y el
    // grupo se deriva por alias (MOM §30.7), igual que al editar una celda.
    const lookup = await statusLookupForSheet(g.admin, sheet);
    const written = applyWrittenStatus(clean, typeof clean.estado === "string" ? clean.estado : null, lookup);
    Object.assign(clean, written.changes, applyWrittenPayment(typeof clean.metodo_pago === "string" ? clean.metodo_pago : null));
    if (written.unknownAlias) {
      await g.admin
        .from("sheet_status_aliases")
        .upsert({ sheet_id: sheetId, alias: written.unknownAlias, status_code: null, seen_count: 1 }, { onConflict: "sheet_id,alias", ignoreDuplicates: true });
    }
  } else {
    const first = (columns ?? [])[0] as { key: string } | undefined;
    rowKey = districtKey(String(clean[first?.key ?? ""] ?? ""));
    if (!rowKey) return { ok: false, error: "La primera columna identifica la fila y no puede ir vacía." };
  }
  const { data, error } = await g.admin
    .from("sheet_rows")
    .upsert(
      { sheet_id: sheetId, row_key: rowKey, order_id: orderId, values: clean, source: "manual", created_by: g.user.id, updated_at: new Date().toISOString() },
      { onConflict: "sheet_id,row_key" },
    )
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "No se pudo guardar." };
  await g.admin.from("sheet_cell_history").insert(
    Object.entries(clean).map(([column_key, new_value]) => ({ row_id: data.id, column_key, previous_value: null, new_value, actor: g.user.id })),
  );
  const opened = cuaderno ? await reconcileAfterEdit(g.admin, sheetId, rowKey, "estado") : null;
  revalidatePath(PATH);
  return { ok: true, message: opened ? `Fila guardada. ${opened}` : "Fila guardada." };
}

// ---------------------------------------------------------------------------
// Estados del dominio y alias
// ---------------------------------------------------------------------------
export async function upsertDomainStatus(input: {
  domainId: string;
  code: string;
  label: string;
  operational_status: string;
  effect: StatusEffect;
  active?: boolean;
}): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  const { data: domain } = await g.admin.from("sheet_domains").select("org_id").eq("id", input.domainId).maybeSingle();
  if (!domain || !g.orgIds.has(domain.org_id)) return { ok: false, error: "Dominio fuera de tu acceso." };
  const code = input.code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!code) return { ok: false, error: "El estado necesita un código." };
  if (!isOperationalCode(input.operational_status)) {
    return { ok: false, error: "El equivalente debe ser un estado operativo de Kapta." };
  }
  if (!["informa", "entrega", "devolucion", "anulacion", "sin_salida"].includes(input.effect)) {
    return { ok: false, error: "Efecto no válido." };
  }
  const { data: existing } = await g.admin
    .from("sheet_domain_statuses")
    .select("id,position")
    .eq("domain_id", input.domainId)
    .eq("code", code)
    .maybeSingle();
  const { data: all } = await g.admin.from("sheet_domain_statuses").select("position").eq("domain_id", input.domainId);
  const position = existing?.position ?? Math.max(-1, ...(all ?? []).map((s: { position: number }) => s.position)) + 1;
  const { error } = await g.admin.from("sheet_domain_statuses").upsert(
    {
      domain_id: input.domainId,
      code,
      label: input.label.trim() || code,
      operational_status: input.operational_status,
      effect: input.effect,
      active: input.active ?? true,
      position,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "domain_id,code" },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, message: `Estado «${code}» guardado.` };
}

export async function setStatusAlias(sheetId: string, alias: string, statusCode: string | null): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  const normalized = normalizeAlias(alias);
  if (!normalized) return { ok: false, error: "Alias vacío." };
  if (statusCode) {
    const { data: status } = await g.admin
      .from("sheet_domain_statuses")
      .select("id")
      .eq("domain_id", sheet.domain_id)
      .eq("code", statusCode)
      .maybeSingle();
    if (!status) return { ok: false, error: "Ese estado no existe en el dominio de la hoja." };
  }
  const { error } = await g.admin
    .from("sheet_status_aliases")
    .upsert({ sheet_id: sheetId, alias: normalized, status_code: statusCode, updated_at: new Date().toISOString() }, { onConflict: "sheet_id,alias" });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, message: statusCode ? `«${normalized}» → ${statusCode}.` : `«${normalized}» queda sin equivalente.` };
}

export async function removeStatusAlias(sheetId: string, alias: string): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  const { error } = await g.admin.from("sheet_status_aliases").delete().eq("sheet_id", sheetId).eq("alias", normalizeAlias(alias));
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function seedAliasesFromTemplate(sheetId: string): Promise<SheetActionResult> {
  const g = await guard("sheets.manage");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  const { data: domain } = await g.admin.from("sheet_domains").select("key").eq("id", sheet.domain_id).maybeSingle();
  if (!domain) return { ok: false, error: "Dominio no encontrado." };
  try {
    const n = await seedSheetAliases(sheetId, domain.key);
    revalidatePath(PATH);
    return { ok: true, message: n ? `${n} alias de plantilla cargados.` : "Este dominio no tiene alias de plantilla." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Observaciones de cuadre
// ---------------------------------------------------------------------------
export async function createObservation(input: {
  sheetId: string;
  rowKey: string | null;
  orderId: string | null;
  field: string;
  externalValue: string | null;
  kaptaValue: string | null;
  difference: number | null;
  reasonCode: string | null;
  note: string | null;
}): Promise<SheetActionResult> {
  const g = await guard("sheets.edit");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, input.sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  const field = input.field.trim();
  if (!field) return { ok: false, error: "Indica qué se comparó (monto, estado, pedido…)." };
  let rowId: string | null = null;
  if (input.rowKey) {
    const { data } = await g.admin.from("sheet_rows").select("id").eq("sheet_id", input.sheetId).eq("row_key", input.rowKey).maybeSingle();
    rowId = data?.id ?? null;
  }
  const { error } = await g.admin.from("sheet_observations").insert({
    org_id: sheet.org_id,
    sheet_id: input.sheetId,
    row_id: rowId,
    order_id: input.orderId,
    field,
    external_value: input.externalValue?.trim() || null,
    kapta_value: input.kaptaValue?.trim() || null,
    difference: input.difference,
    reason_code: input.reasonCode || null,
    note: input.note?.trim() || null,
    created_by: g.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, message: "Observación abierta." };
}

export async function resolveObservation(id: string, reasonCode: string, resolutionNote: string): Promise<SheetActionResult> {
  const g = await guard("sheets.edit");
  if ("error" in g) return { ok: false, error: g.error };
  const { data: obs } = await g.admin.from("sheet_observations").select("org_id,status").eq("id", id).maybeSingle();
  if (!obs || !g.orgIds.has(obs.org_id)) return { ok: false, error: "Observación fuera de tu acceso." };
  if (obs.status === "resuelta") return { ok: true, message: "Ya estaba resuelta." };
  if (!reasonCode) return { ok: false, error: "Resolver exige un motivo." };
  const note = resolutionNote.trim();
  if (reasonCode === "otro" && note.length < 3) return { ok: false, error: "Con motivo «Otro», explica en la nota." };
  const { error } = await g.admin
    .from("sheet_observations")
    .update({
      status: "resuelta",
      reason_code: reasonCode,
      resolution_note: note || null,
      resolved_by: g.user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, message: "Observación resuelta." };
}

// ---------------------------------------------------------------------------
// Cierre por pedido desde la hoja (MOM §30.8)
// ---------------------------------------------------------------------------
export interface ApplyMasterSummary {
  aplicados: number;
  yaEstaban: number;
  saltadosAnulado: number;
  sinVinculo: number;
  sinEfecto: number;
  /** Filas con efecto devolución: no hay camino al Master para devolver desde una hoja. */
  devolucionesSinCamino: number;
  /** Filas con una observación abierta: alguien tiene que leer y aceptar el motivo antes (§30.8). */
  conObservacionAbierta: number;
  /** Filas atadas a una parada que Rutas no tiene como entregada con evidencia (MOM §29.12). */
  paradaNoEntregada: number;
}

/**
 * Marca como entregados en el Master los pedidos de filas de una hoja
 * cuaderno cuyo estado declara entrega. Es EL MISMO camino que usa
 * Liquidaciones (`applySettlementToMaster`): un `order_events` de tipo
 * `status_override` con `source = "liquidacion"` y el operativo por defecto,
 * seguido del recálculo del Master. No hay otro camino, a propósito (§11.4).
 *
 * Nunca toca un pedido anulado: ese caso vive como observación. Y no existe
 * camino de devolución desde una hoja (ni en Liquidaciones ni en Rutas), así
 * que las filas con efecto devolución se cuentan y se dejan como están.
 *
 * Una fila con observación ABIERTA tampoco cruza: el motivo lo escribe quien
 * repartió, lo acepta quien liquida (resuelve la observación) y solo entonces
 * la fila puede ir al Master (§30.8).
 */
export async function applyCuadernoRowsToMaster(sheetId: string, rowKeys: string[]): Promise<SheetActionResult & { summary?: ApplyMasterSummary }> {
  const g = await guard("master.edit");
  if ("error" in g) return { ok: false, error: g.error };
  const full = await sheetFull(g.admin, sheetId);
  if (!full || !g.orgIds.has(full.ref.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  if (!full.cuaderno) return { ok: false, error: "Solo se aplica al Master desde una hoja cuaderno." };
  const keys = [...new Set(rowKeys.map((k) => k.trim()).filter(Boolean))];
  if (!keys.length) return { ok: false, error: "No hay filas que aplicar." };

  const effects = await effectsForDomain(g.admin, full.ref.domain_id);
  type Row = { id: string; row_key: string; order_id: string | null; stop_id: string | null; values: Record<string, CellValue> };
  const rows: Row[] = [];
  for (let i = 0; i < keys.length; i += 250) {
    const { data, error } = await g.admin
      .from("sheet_rows")
      .select("id,row_key,order_id,stop_id,values")
      .eq("sheet_id", sheetId)
      .in("row_key", keys.slice(i, i + 250));
    if (error) return { ok: false, error: error.message };
    rows.push(...((data ?? []) as Row[]));
  }

  // La parada es la verdad (MOM §29.12): para las filas atadas, la puerta
  // exige parada entregada con evidencia. Las filas del Excel histórico no
  // tienen parada y pasan con la guarda de observaciones, como hasta ahora.
  const stopIds = rows.map((r) => r.stop_id).filter((id): id is string => Boolean(id));
  const stops = new Map<string, { status: string; photo_path: string | null; voucher_path: string | null; reported_by: string | null }>();
  for (let i = 0; i < stopIds.length; i += 250) {
    const { data, error } = await g.admin.from("delivery_stops").select("id,status,photo_path,voucher_path,reported_by").in("id", stopIds.slice(i, i + 250));
    if (error) return { ok: false, error: error.message };
    for (const st of (data ?? []) as { id: string; status: string; photo_path: string | null; voucher_path: string | null; reported_by: string | null }[]) stops.set(st.id, st);
  }

  const summary: ApplyMasterSummary = { aplicados: 0, yaEstaban: 0, saltadosAnulado: 0, sinVinculo: 0, sinEfecto: 0, devolucionesSinCamino: 0, conObservacionAbierta: 0, paradaNoEntregada: 0 };
  const withOpen = new Set<string>();
  const rowIds = rows.map((r) => r.id);
  for (let i = 0; i < rowIds.length; i += 250) {
    const { data, error } = await g.admin
      .from("sheet_observations")
      .select("row_id")
      .eq("sheet_id", sheetId)
      .eq("status", "abierta")
      .in("row_id", rowIds.slice(i, i + 250));
    if (error) return { ok: false, error: error.message };
    for (const o of (data ?? []) as { row_id: string | null }[]) if (o.row_id) withOpen.add(o.row_id);
  }
  const candidates: Row[] = [];
  for (const row of rows) {
    if (!row.order_id) {
      summary.sinVinculo += 1;
      continue;
    }
    if (withOpen.has(row.id)) {
      summary.conObservacionAbierta += 1;
      continue;
    }
    const estado = typeof row.values.estado === "string" ? row.values.estado : null;
    const effect = estado ? effects.get(estado) : undefined;
    if (effect === "devolucion") {
      summary.devolucionesSinCamino += 1;
      continue;
    }
    if (effect !== "entrega") {
      summary.sinEfecto += 1;
      continue;
    }
    candidates.push(row);
  }

  const orderIds = [...new Set(candidates.map((r) => r.order_id!))];
  const master = new Map<string, { store_id: string; general_status: string; cancelled_at: string | null }>();
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await g.admin
      .from("order_master")
      .select("order_id,store_id,general_status,orders(cancelled_at)")
      .in("order_id", orderIds.slice(i, i + 200));
    if (error) return { ok: false, error: error.message };
    for (const m of (data ?? []) as unknown as { order_id: string; store_id: string; general_status: string; orders: { cancelled_at: string | null } | null }[]) {
      master.set(m.order_id, { store_id: m.store_id, general_status: m.general_status, cancelled_at: m.orders?.cancelled_at ?? null });
    }
  }

  const courier = typeof full.config.courier === "string" && full.config.courier ? full.config.courier : "propio";
  const riderName = typeof full.config.rider_name === "string" ? full.config.rider_name : full.ref.name;
  const who = courier === "propio" ? `${riderName} (Grupo GF Courier)` : full.ref.name;
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const items: MasterDoorItem[] = [];
  for (const row of candidates) {
    const orderId = row.order_id!;
    if (seen.has(orderId)) continue;
    const m = master.get(orderId);
    if (!m) {
      summary.sinVinculo += 1;
      continue;
    }
    if (m.general_status === "anulado" || m.cancelled_at) {
      summary.saltadosAnulado += 1;
      continue;
    }
    if (m.general_status === "entregado") {
      summary.yaEstaban += 1;
      continue;
    }
    seen.add(orderId);
    const fecha = typeof row.values.fecha === "string" ? row.values.fecha : null;
    const written = typeof row.values.estado_reportado === "string" && row.values.estado_reportado ? row.values.estado_reportado : "entregado";
    const stop = row.stop_id ? stops.get(row.stop_id) ?? null : null;
    items.push({
      orderId,
      storeId: m.store_id,
      target: "entregado",
      source: "liquidacion",
      courier,
      // Mediodía de Lima del día de la ruta: la hora exacta no se anotó en el cuaderno.
      occurredAt: fecha ? `${fecha}T17:00:00.000Z` : now,
      actor: g.user.id,
      reason: `Entregado según el cuaderno de ${who} (${written}).`,
      payload: { sheet_id: sheetId, sheet_key: full.ref.key, row_key: row.row_key, row_id: row.id, stop_id: row.stop_id },
      guard: stop ? { stop, requireEvidence: true, openObservations: 0 } : { openObservations: 0 },
    });
  }

  if (items.length) {
    const door = await applyDeliveriesToMaster(g.admin, items);
    if (door.error) return { ok: false, error: `No se pudo registrar la entrega: ${door.error}` };
    summary.aplicados = door.applied.length;
    summary.paradaNoEntregada = door.rejected.length;
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard/pedidos");
  const parts = [
    `${summary.aplicados} aplicado(s)`,
    summary.yaEstaban ? `${summary.yaEstaban} ya estaban entregados` : null,
    summary.saltadosAnulado ? `${summary.saltadosAnulado} anulados en Kapta, no se tocan` : null,
    summary.sinVinculo ? `${summary.sinVinculo} sin pedido en Kapta` : null,
    summary.sinEfecto ? `${summary.sinEfecto} sin entrega declarada` : null,
    summary.devolucionesSinCamino ? `${summary.devolucionesSinCamino} devoluciones sin camino al Master` : null,
    summary.conObservacionAbierta ? `${summary.conObservacionAbierta} con observación pendiente de aceptar` : null,
    summary.paradaNoEntregada ? `${summary.paradaNoEntregada} cuya parada en Rutas no está entregada con evidencia` : null,
  ].filter(Boolean);
  return { ok: true, message: `Master: ${parts.join(" · ")}.`, summary };
}

/**
 * Pone motivo y nota a la observación abierta de una fila y campo (la que
 * abrió el cuadre automático al editar). Si no había ninguna, la crea con el
 * motivo. Es lo que confirma el mini-formulario en línea tras editar un monto.
 */
export async function setObservationReason(input: {
  sheetId: string;
  rowKey: string;
  field: string;
  reasonCode: string;
  note: string;
  externalValue?: string | null;
  kaptaValue?: string | null;
  difference?: number | null;
}): Promise<SheetActionResult> {
  const g = await guard("sheets.edit");
  if ("error" in g) return { ok: false, error: g.error };
  const sheet = await sheetOrg(g.admin, input.sheetId);
  if (!sheet || !g.orgIds.has(sheet.org_id)) return { ok: false, error: "Hoja fuera de tu acceso." };
  if (!input.reasonCode) return { ok: false, error: "Elige un motivo." };
  const { data: row } = await g.admin.from("sheet_rows").select("id,order_id").eq("sheet_id", input.sheetId).eq("row_key", input.rowKey).maybeSingle();
  if (!row) return { ok: false, error: "La fila no existe." };
  const { data: open } = await g.admin
    .from("sheet_observations")
    .select("id")
    .eq("sheet_id", input.sheetId)
    .eq("row_id", row.id)
    .eq("field", input.field)
    .eq("status", "abierta")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const note = input.note.trim() || null;
  if (open) {
    const { error } = await g.admin.from("sheet_observations").update({ reason_code: input.reasonCode, note }).eq("id", open.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await g.admin.from("sheet_observations").insert({
      org_id: sheet.org_id,
      sheet_id: input.sheetId,
      row_id: row.id,
      order_id: row.order_id,
      field: input.field,
      external_value: input.externalValue ?? null,
      kapta_value: input.kaptaValue ?? null,
      difference: input.difference ?? null,
      reason_code: input.reasonCode,
      note,
      created_by: g.user.id,
    });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath(PATH);
  return { ok: true, message: "Motivo guardado en la observación." };
}
