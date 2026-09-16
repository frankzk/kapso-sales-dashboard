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
    .select("id,values")
    .eq("sheet_id", input.sheetId)
    .eq("row_key", rowKey)
    .maybeSingle();
  const previous = (existing?.values as Record<string, CellValue> | undefined)?.[input.columnKey] ?? null;
  if (existing && previous === value) return { ok: true };

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
  revalidatePath(PATH);
  return { ok: true };
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

/** Fila nueva en una hoja de catálogo (clave «valor»). */
export async function addCatalogRow(sheetId: string, values: Record<string, CellValue>): Promise<SheetActionResult> {
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
  const clean: Record<string, CellValue> = {};
  for (const c of (columns ?? []) as { key: string; data_type: ColumnDataType; options: string[]; required: boolean }[]) {
    const v = coerce(values[c.key] ?? null, c.data_type, c.options ?? []);
    if (v === undefined) return { ok: false, error: `Valor no válido en «${c.key}».` };
    if (c.required && (v === null || v === "")) return { ok: false, error: `Falta «${c.key}».` };
    clean[c.key] = v;
  }
  const first = (columns ?? [])[0] as { key: string } | undefined;
  const rowKey = districtKey(String(clean[first?.key ?? ""] ?? ""));
  if (!rowKey) return { ok: false, error: "La primera columna identifica la fila y no puede ir vacía." };
  const { data, error } = await g.admin
    .from("sheet_rows")
    .upsert(
      { sheet_id: sheetId, row_key: rowKey, values: clean, source: "manual", created_by: g.user.id, updated_at: new Date().toISOString() },
      { onConflict: "sheet_id,row_key" },
    )
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "No se pudo guardar." };
  await g.admin.from("sheet_cell_history").insert(
    Object.entries(clean).map(([column_key, new_value]) => ({ row_id: data.id, column_key, previous_value: null, new_value, actor: g.user.id })),
  );
  revalidatePath(PATH);
  return { ok: true, message: "Fila guardada." };
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
  if (!["informa", "entrega", "devolucion", "anulacion"].includes(input.effect)) {
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
