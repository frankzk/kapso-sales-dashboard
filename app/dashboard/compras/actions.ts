"use server";

// «Compras»: importaciones (MOM §45, 14-11-2026). Cada acción vuelve a pedir
// el permiso EN la organización de la importación (MOM §16) y escribe con
// service role: las tablas de la 0340 no tienen políticas de RLS.
//
//   - `purchases.manage`: crear y editar la importación, sus productos,
//     documentos, estados, aviso a la bodega y recepción.
//   - `purchases.money`: costos por unidad, precios de venta, tipo de cambio,
//     costos repartidos, pagos y los documentos con montos (proforma y
//     comprobante). Sin él esos campos NO se leen ni se escriben: no basta con
//     esconderlos en la pantalla (`cleanItem(…, canMoney)`).
//   - «Pasar a Costos»: `purchases.money` y `costs.manage`.
//
// Cada hecho queda en `import_events` (append-only). Los de dinero van con
// `kind = 'dinero'` y solo los ve quien tiene `purchases.money`.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { ITEM_COLS, ITEM_MONEY_COLS, loadImportAccess, normalizeItem, type ImportRow } from "@/lib/compras-server";
import {
  IMPORT_FILES_BUCKET,
  IMPORT_STATUS_LABEL,
  allocationLabel,
  checkImportFile,
  cleanCost,
  cleanFx,
  cleanHeader,
  cleanItem,
  cleanPayment,
  cleanReception,
  cleanStatusChange,
  cleanSupplier,
  costKindLabel,
  costPushNote,
  costPushPlan,
  docKindLabel,
  formatDmy,
  importFileExt,
  isBeforeReceived,
  isImportFilePath,
  isMoneyDoc,
  isUuid,
  landedCosts,
  limaToday,
  limaYear,
  nextImportCode,
  paymentMethodLabel,
  receptionEventNote,
  receptionSummary,
  type DocKind,
  type HeaderInput,
  type HeaderValue,
  type ImportEventKind,
  type ImportStatus,
  type ItemInput,
  type ReceptionLineInput,
  type CostInput,
  type PaymentInput,
  type SupplierInput,
  DOC_KINDS,
} from "@/lib/compras";
import { insertProductCostPeriod } from "@/lib/product-cost-periods";

export interface ComprasActionState {
  error?: string;
  notice?: string;
  /** La fila creada (importación, proveedor, documento). */
  id?: string;
}

const LIST_PATH = "/dashboard/compras";

function revalidate(importId?: string) {
  revalidatePath(LIST_PATH);
  if (importId) revalidatePath(`${LIST_PATH}/${importId}`);
}

const usd = (n: number) => `US$ ${n.toFixed(2)}`;

type Need = { manage?: boolean; money?: boolean };

type Access = { userId: string; imp: ImportRow; canMoney: boolean; canPushCosts: boolean };

async function authorize(admin: SupabaseClient, importId: string, need: Need): Promise<Access | { error: string }> {
  const a = await loadImportAccess(importId, admin);
  if (!a) return { error: "Sin acceso a esta importación." };
  if (need.manage && !a.perms.canManage) return { error: "Tu rol no permite editar compras." };
  if (need.money && !a.perms.canMoney) return { error: "Hace falta el permiso «Montos de compras»." };
  return { userId: a.userId, imp: a.imp, canMoney: a.perms.canMoney, canPushCosts: a.perms.canPushCosts };
}

async function addEvent(
  admin: SupabaseClient,
  imp: Pick<ImportRow, "id" | "org_id">,
  userId: string,
  kind: ImportEventKind,
  note: string | null,
  status: ImportStatus | null = null,
): Promise<void> {
  await admin.from("import_events").insert({
    org_id: imp.org_id,
    import_id: imp.id,
    kind,
    status,
    note: note ? note.slice(0, 1000) : null,
    by_user: userId,
  });
}

async function supplierInOrg(admin: SupabaseClient, orgId: string, supplierId: string | null): Promise<boolean> {
  if (!supplierId) return true;
  const { data } = await admin.from("import_suppliers").select("id").eq("id", supplierId).eq("org_id", orgId).maybeSingle();
  return Boolean(data);
}

async function storeInOrg(admin: SupabaseClient, orgId: string, storeId: string | null): Promise<boolean> {
  if (!storeId) return true;
  const { data } = await admin.from("stores").select("id").eq("id", storeId).eq("org_id", orgId).maybeSingle();
  return Boolean(data);
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

/** Alta rápida de un proveedor desde el formulario de la importación. */
export async function createSupplier(orgId: string, input: SupplierInput): Promise<ComprasActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión otra vez." };
  if (!isUuid(orgId) || !(await hasOrgPermission(orgId, "purchases.manage"))) {
    return { error: "Tu rol no permite editar compras." };
  }
  const clean = cleanSupplier(input);
  if ("error" in clean) return clean;
  const admin = createAdminSupabase();
  const { data: same } = await admin.from("import_suppliers").select("id,name").eq("org_id", orgId).ilike("name", clean.value.name);
  if ((same ?? []).length) return { error: "Ya existe un proveedor con ese nombre." };
  const id = randomUUID();
  const { error } = await admin.from("import_suppliers").insert({ id, org_id: orgId, ...clean.value, created_by: user.id });
  if (error) return { error: error.code === "23505" ? "Ya existe un proveedor con ese nombre." : error.message };
  revalidate();
  return { id, notice: `Proveedor «${clean.value.name}» creado.` };
}

// ---------------------------------------------------------------------------
// La importación
// ---------------------------------------------------------------------------

/** Crea la importación en Cotización con el siguiente código `IMP-<año de Lima>-NNN`. */
export async function createImport(orgId: string, input: HeaderInput): Promise<ComprasActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión otra vez." };
  if (!isUuid(orgId) || !(await hasOrgPermission(orgId, "purchases.manage"))) {
    return { error: "Tu rol no permite crear importaciones." };
  }
  const clean = cleanHeader(input);
  if ("error" in clean) return clean;
  const admin = createAdminSupabase();
  if (!(await supplierInOrg(admin, orgId, clean.value.supplier_id))) return { error: "Ese proveedor no es de esta organización." };
  const header: HeaderValue = { ...clean.value, ordered_on: clean.value.ordered_on ?? limaToday() };

  const year = limaYear();
  const id = randomUUID();
  // Dos altas a la vez pueden elegir el mismo número: el índice único decide y
  // se reintenta con el siguiente.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: codes } = await admin.from("imports").select("code").eq("org_id", orgId).like("code", `IMP-${year}-%`);
    const code = nextImportCode(((codes ?? []) as { code: string }[]).map((c) => c.code), year);
    const { error } = await admin
      .from("imports")
      .insert({ id, org_id: orgId, code, status: "cotizacion", ...header, created_by: user.id });
    if (!error) {
      await addEvent(admin, { id, org_id: orgId }, user.id, "status", "Importación creada", "cotizacion");
      revalidate(id);
      return { id, notice: `Importación ${code} creada en Cotización.` };
    }
    if (error.code !== "23505") return { error: error.message };
  }
  return { error: "No se pudo asignar el código. Vuelve a intentarlo." };
}

const HEADER_LABEL: Record<keyof HeaderValue, string> = {
  supplier_id: "proveedor",
  origin: "origen",
  platform_order: "n.º de orden",
  transport: "transporte",
  carrier: "paquetera",
  tracking_number: "guía",
  tracking_url: "enlace de seguimiento",
  ordered_on: "fecha del pedido",
  eta: "llegada estimada",
  arrived_on: "llegada",
  notes: "notas",
};

export async function updateImportHeader(importId: string, input: HeaderInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true });
  if ("error" in a) return a;
  const clean = cleanHeader(input);
  if ("error" in clean) return clean;
  if (!(await supplierInOrg(admin, a.imp.org_id, clean.value.supplier_id))) return { error: "Ese proveedor no es de esta organización." };
  const changed = (Object.keys(clean.value) as (keyof HeaderValue)[]).filter(
    (k) => (clean.value[k] ?? null) !== ((a.imp as unknown as Record<string, unknown>)[k] ?? null),
  );
  if (!changed.length) return { notice: "Sin cambios." };
  const { error } = await admin.from("imports").update(clean.value).eq("id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "datos", `Datos actualizados: ${changed.map((k) => HEADER_LABEL[k]).join(", ")}.`);
  revalidate(a.imp.id);
  return { notice: "Datos guardados." };
}

/** El tipo de cambio de la importación (soles por 1 USD). Es dinero. */
export async function setImportFx(importId: string, raw: string): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: true });
  if ("error" in a) return a;
  const fx = cleanFx(raw);
  if ("error" in fx) return fx;
  const { error } = await admin.from("imports").update({ fx_pen_per_usd: fx.value }).eq("id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", fx.value ? `Tipo de cambio: S/ ${fx.value} por 1 USD.` : "Se quitó el tipo de cambio.");
  revalidate(a.imp.id);
  return { notice: "Tipo de cambio guardado." };
}

/** Cambio de estado manual con nota opcional; el mismo estado con nota es una novedad. */
export async function setImportStatus(importId: string, status: string, note: string): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true });
  if ("error" in a) return a;
  const clean = cleanStatusChange(a.imp.status, status, note);
  if ("error" in clean) return clean;
  if (clean.value.changed) {
    const { error } = await admin.from("imports").update({ status: clean.value.status }).eq("id", a.imp.id);
    if (error) return { error: error.message };
    await addEvent(admin, a.imp, a.userId, "status", clean.value.note, clean.value.status);
  } else {
    await addEvent(admin, a.imp, a.userId, "nota", clean.value.note);
  }
  revalidate(a.imp.id);
  return { notice: clean.value.changed ? `Estado: ${IMPORT_STATUS_LABEL[clean.value.status]}.` : "Nota registrada." };
}

/** «Reportada»: ya se avisó a la bodega de Kapta en Lima. */
export async function setWarehouseReported(importId: string, reported: boolean): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true });
  if ("error" in a) return a;
  const { error } = await admin
    .from("imports")
    .update(reported ? { reported_to_warehouse_at: new Date().toISOString(), reported_by: a.userId } : { reported_to_warehouse_at: null, reported_by: null })
    .eq("id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "bodega", reported ? "Aviso a la bodega: reportada." : "Se quitó la marca de reportada a la bodega.");
  revalidate(a.imp.id);
  return { notice: reported ? "Marcada como reportada a la bodega." : "Marca quitada." };
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

async function checkUploadedFile(
  admin: SupabaseClient,
  path: string,
  kind: DocKind | "item_photo",
  filename: string | null,
): Promise<{ mime: string; size: number } | { error: string }> {
  const { data, error } = await admin.storage.from(IMPORT_FILES_BUCKET).info(path);
  if (error || !data) return { error: "No encontramos el archivo subido. Vuelve a subirlo." };
  const size = Number(data.size ?? 0);
  // Tipo y tamaño REALES de Storage, no lo que dijo el navegador.
  const check = checkImportFile(kind, { contentType: data.contentType ?? null, filename, size });
  if ("error" in check) {
    await admin.storage.from(IMPORT_FILES_BUCKET).remove([path]).catch(() => {});
    return check;
  }
  return { mime: check.mime, size };
}

export async function addImportItem(importId: string, input: ItemInput & { imagePath?: string | null }): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  const clean = cleanItem(input, a.canMoney);
  if ("error" in clean) return clean;
  if (!(await storeInOrg(admin, a.imp.org_id, clean.value.store_id))) return { error: "Esa tienda no es de esta organización." };
  const imagePath = (input.imagePath ?? "").trim() || null;
  if (imagePath) {
    if (!isImportFilePath(imagePath, a.imp.org_id, a.imp.id, "items")) return { error: "La foto no es de esta importación." };
    const file = await checkUploadedFile(admin, imagePath, "item_photo", null);
    if ("error" in file) return file;
  }
  const { data: existing } = await admin.from("import_items").select("position").eq("import_id", a.imp.id);
  const position = ((existing ?? []) as { position: number }[]).reduce((m, r) => Math.max(m, Number(r.position) || 0), 0) + 1;
  const { error } = await admin.from("import_items").insert({
    id: randomUUID(),
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    ...clean.value,
    image_path: imagePath,
    position,
  });
  if (error) return { error: error.message };
  const v = clean.value;
  await addEvent(admin, a.imp, a.userId, "producto", `Producto agregado: ${v.qty} × ${v.name}${v.sku ? ` (SKU ${v.sku})` : ""}.`);
  revalidate(a.imp.id);
  return { notice: "Producto agregado." };
}

async function itemImport(admin: SupabaseClient, itemId: string): Promise<{ import_id: string; name: string; image_path: string | null } | null> {
  if (!isUuid(itemId)) return null;
  const { data } = await admin.from("import_items").select("import_id,name,image_path").eq("id", itemId).maybeSingle();
  return (data as { import_id: string; name: string; image_path: string | null } | null) ?? null;
}

export async function updateImportItem(itemId: string, input: ItemInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const item = await itemImport(admin, itemId);
  if (!item) return { error: "Ese producto ya no está." };
  const a = await authorize(admin, item.import_id, { manage: true });
  if ("error" in a) return a;
  // Sin «Montos de compras», `cleanItem` no devuelve costo ni precio: la
  // edición no los lee ni los toca.
  const clean = cleanItem(input, a.canMoney);
  if ("error" in clean) return clean;
  if (!(await storeInOrg(admin, a.imp.org_id, clean.value.store_id))) return { error: "Esa tienda no es de esta organización." };
  const { error } = await admin.from("import_items").update(clean.value).eq("id", itemId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "producto", `Producto editado: ${clean.value.name}.`);
  revalidate(a.imp.id);
  return { notice: "Producto guardado." };
}

/**
 * Quita un producto. Un costo «todo a un producto» que iba a él NO se borra
 * (la 0340 lo deja con `item_id` nulo): pasa a repartirse por valor, con aviso
 * en el cálculo y un hecho de dinero en el historial.
 */
export async function removeImportItem(itemId: string): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const item = await itemImport(admin, itemId);
  if (!item) return { error: "Ese producto ya no está." };
  const a = await authorize(admin, item.import_id, { manage: true });
  if ("error" in a) return a;
  const { data: assigned } = await admin.from("import_costs").select("id,label").eq("item_id", itemId).eq("import_id", a.imp.id);
  const orphaned = (assigned ?? []) as { id: string; label: string }[];
  if (orphaned.length) {
    await admin.from("import_costs").update({ item_id: null }).in("id", orphaned.map((c) => c.id));
  }
  const { error } = await admin.from("import_items").delete().eq("id", itemId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  if (item.image_path) await admin.storage.from(IMPORT_FILES_BUCKET).remove([item.image_path]).catch(() => {});
  await addEvent(admin, a.imp, a.userId, "producto", `Producto quitado: ${item.name}.`);
  for (const c of orphaned) {
    await addEvent(admin, a.imp, a.userId, "dinero", `«${c.label}» estaba asignado a «${item.name}»: ahora se reparte por valor.`);
  }
  revalidate(a.imp.id);
  return {
    notice: orphaned.length
      ? `Producto quitado. ${orphaned.length === 1 ? "Un costo que iba a él se reparte" : `${orphaned.length} costos que iban a él se reparten`} ahora por valor.`
      : "Producto quitado.",
  };
}

// ---------------------------------------------------------------------------
// Recepción en la bodega de Lima
// ---------------------------------------------------------------------------

/**
 * Lo que contó la bodega. Si la importación estaba antes de «Recibido», pasa a
 * «Recibido» y, sin fecha de llegada, se anota hoy (Lima).
 */
export async function saveReception(importId: string, lines: ReceptionLineInput[]): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  const { data: rows } = await admin.from("import_items").select("id,name,qty").eq("import_id", a.imp.id);
  const items = (rows ?? []) as { id: string; name: string; qty: number }[];
  const clean = cleanReception(items.map((i) => i.id), lines);
  if ("error" in clean) return clean;
  const now = new Date().toISOString();
  for (const line of clean.value) {
    const { error } = await admin
      .from("import_items")
      .update({
        received_qty: line.received_qty,
        damaged_qty: line.damaged_qty,
        reception_note: line.reception_note,
        received_at: line.received_qty === null ? null : now,
        received_by: line.received_qty === null ? null : a.userId,
      })
      .eq("id", line.itemId)
      .eq("import_id", a.imp.id);
    if (error) return { error: error.message };
  }
  const byId = new Map(clean.value.map((l) => [l.itemId, l]));
  const summary = receptionSummary(
    items.map((i) => ({
      id: i.id,
      qty: Number(i.qty),
      receivedQty: byId.get(i.id)?.received_qty ?? null,
      damagedQty: byId.get(i.id)?.damaged_qty ?? null,
    })),
  );
  await addEvent(admin, a.imp, a.userId, "recepcion", receptionEventNote(summary));
  let moved = false;
  if (isBeforeReceived(a.imp.status)) {
    const patch: Record<string, unknown> = { status: "recibido" };
    if (!a.imp.arrived_on) patch.arrived_on = limaToday();
    const { error } = await admin.from("imports").update(patch).eq("id", a.imp.id);
    if (error) return { error: error.message };
    await addEvent(admin, a.imp, a.userId, "status", "Al guardar la recepción en la bodega de Lima.", "recibido");
    moved = true;
  }
  revalidate(a.imp.id);
  return { notice: moved ? "Recepción guardada. La importación pasó a Recibido." : "Recepción guardada." };
}

// ---------------------------------------------------------------------------
// Dinero: costos y pagos (solo con «Montos de compras»)
// ---------------------------------------------------------------------------

export async function addImportCost(importId: string, input: CostInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: true });
  if ("error" in a) return a;
  const { data: rows } = await admin.from("import_items").select("id").eq("import_id", a.imp.id);
  const clean = cleanCost(input, ((rows ?? []) as { id: string }[]).map((r) => r.id));
  if ("error" in clean) return clean;
  const { error } = await admin.from("import_costs").insert({
    id: randomUUID(),
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    ...clean.value,
    created_by: a.userId,
  });
  if (error) return { error: error.message };
  const v = clean.value;
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "dinero",
    `Costo agregado: ${costKindLabel(v.kind)} · ${v.label} · ${usd(v.amount_usd)} · ${allocationLabel(v.allocation).toLowerCase()}.`,
  );
  revalidate(a.imp.id);
  return { notice: "Costo agregado." };
}

export async function removeImportCost(costId: string): Promise<ComprasActionState> {
  if (!isUuid(costId)) return { error: "Ese costo ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_costs").select("import_id,label,amount_usd").eq("id", costId).maybeSingle();
  const cost = data as { import_id: string; label: string; amount_usd: number } | null;
  if (!cost) return { error: "Ese costo ya no está." };
  const a = await authorize(admin, cost.import_id, { manage: true, money: true });
  if ("error" in a) return a;
  const { error } = await admin.from("import_costs").delete().eq("id", costId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", `Costo quitado: ${cost.label} · ${usd(Number(cost.amount_usd))}.`);
  revalidate(a.imp.id);
  return { notice: "Costo quitado." };
}

export async function addImportPayment(importId: string, input: PaymentInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: true });
  if ("error" in a) return a;
  const { data: docs } = await admin.from("import_documents").select("id").eq("import_id", a.imp.id).eq("kind", "payment");
  const clean = cleanPayment(input, ((docs ?? []) as { id: string }[]).map((d) => d.id));
  if ("error" in clean) return clean;
  const { error } = await admin.from("import_payments").insert({
    id: randomUUID(),
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    ...clean.value,
    created_by: a.userId,
  });
  if (error) return { error: error.message };
  const v = clean.value;
  await addEvent(admin, a.imp, a.userId, "dinero", `Pago registrado: ${usd(v.amount_usd)} · ${paymentMethodLabel(v.method)} · ${formatDmy(v.paid_on)}.`);
  revalidate(a.imp.id);
  return { notice: "Pago registrado." };
}

export async function removeImportPayment(paymentId: string): Promise<ComprasActionState> {
  if (!isUuid(paymentId)) return { error: "Ese pago ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_payments").select("import_id,amount_usd,paid_on").eq("id", paymentId).maybeSingle();
  const pay = data as { import_id: string; amount_usd: number; paid_on: string } | null;
  if (!pay) return { error: "Ese pago ya no está." };
  const a = await authorize(admin, pay.import_id, { manage: true, money: true });
  if ("error" in a) return a;
  const { error } = await admin.from("import_payments").delete().eq("id", paymentId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", `Pago quitado: ${usd(Number(pay.amount_usd))} del ${formatDmy(pay.paid_on)}.`);
  revalidate(a.imp.id);
  return { notice: "Pago quitado." };
}

// ---------------------------------------------------------------------------
// Documentos y fotos (bucket privado `import-files`)
// ---------------------------------------------------------------------------

function isDocKind(kind: string): kind is DocKind {
  return DOC_KINDS.some((k) => k.id === kind);
}

/**
 * Prepara la subida: el servidor decide la ruta (`<org>/<importación>/docs|items/<uuid>.<ext>`)
 * y devuelve un enlace firmado; el navegador sube directo a Storage.
 */
export async function startImportUpload(
  importId: string,
  input: { kind: string; contentType: string; filename: string; size: number },
): Promise<{ path: string; token: string } | { error: string }> {
  const kind = input.kind === "item_photo" ? "item_photo" : isDocKind(input.kind) ? input.kind : null;
  if (!kind) return { error: "Tipo de documento inválido." };
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: kind !== "item_photo" && isMoneyDoc(kind) });
  if ("error" in a) return a;
  const check = checkImportFile(kind, { contentType: input.contentType, filename: input.filename, size: Number(input.size) });
  if ("error" in check) return check;
  await admin.storage.createBucket(IMPORT_FILES_BUCKET, { public: false }).catch(() => {});
  const folder = kind === "item_photo" ? "items" : "docs";
  const path = `${a.imp.org_id}/${a.imp.id}/${folder}/${randomUUID()}.${importFileExt(check.mime)}`;
  const { data, error } = await admin.storage.from(IMPORT_FILES_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: error?.message ?? "No se pudo preparar la subida." };
  return { path: data.path, token: data.token };
}

/** Registra el documento ya subido, con el tipo y tamaño que dice Storage. */
export async function registerImportDocument(
  importId: string,
  input: { kind: string; path: string; filename: string },
): Promise<ComprasActionState> {
  if (!isDocKind(input.kind)) return { error: "Tipo de documento inválido." };
  const kind = input.kind;
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: isMoneyDoc(kind) });
  if ("error" in a) return a;
  if (!isImportFilePath(input.path, a.imp.org_id, a.imp.id, "docs")) return { error: "El archivo no es de esta importación." };
  const filename = String(input.filename ?? "").replace(/[\u0000-\u001f/\\]/g, "_").trim().slice(0, 200) || null;
  const file = await checkUploadedFile(admin, input.path, kind, filename);
  if ("error" in file) return file;
  const id = randomUUID();
  const { error } = await admin.from("import_documents").insert({
    id,
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    kind,
    storage_path: input.path,
    filename,
    mime: file.mime,
    size_bytes: file.size,
    uploaded_by: a.userId,
  });
  if (error) return { error: error.message };
  await addEvent(
    admin,
    a.imp,
    a.userId,
    isMoneyDoc(kind) ? "dinero" : "documento",
    `Documento subido: ${docKindLabel(kind)}${filename ? ` (${filename})` : ""}.`,
  );
  revalidate(a.imp.id);
  return { id, notice: "Documento subido." };
}

export async function removeImportDocument(documentId: string): Promise<ComprasActionState> {
  if (!isUuid(documentId)) return { error: "Ese documento ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_documents").select("import_id,kind,storage_path,filename").eq("id", documentId).maybeSingle();
  const doc = data as { import_id: string; kind: string; storage_path: string; filename: string | null } | null;
  if (!doc) return { error: "Ese documento ya no está." };
  const a = await authorize(admin, doc.import_id, { manage: true, money: isMoneyDoc(doc.kind) });
  if ("error" in a) return a;
  if (doc.kind === "payment") {
    await admin.from("import_payments").update({ document_id: null }).eq("document_id", documentId).eq("import_id", a.imp.id);
  }
  const { error } = await admin.from("import_documents").delete().eq("id", documentId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await admin.storage.from(IMPORT_FILES_BUCKET).remove([doc.storage_path]).catch(() => {});
  await addEvent(
    admin,
    a.imp,
    a.userId,
    isMoneyDoc(doc.kind) ? "dinero" : "documento",
    `Documento quitado: ${docKindLabel(doc.kind)}${doc.filename ? ` (${doc.filename})` : ""}.`,
  );
  revalidate(a.imp.id);
  return { notice: "Documento quitado." };
}

// ---------------------------------------------------------------------------
// «Pasar a Costos» (MOM §45)
// ---------------------------------------------------------------------------

/**
 * Lleva el costo aterrizado por unidad (en soles, a 2 decimales) de cada línea
 * con SKU a Costos de productos, con la misma vigencia que Costos
 * (`insertProductCostPeriod`): desde la llegada (o hoy en Lima), lote = el
 * código de la importación, proveedor = su nombre. Cada línea se pasa una sola
 * vez: se marca ANTES de escribir el costo y, si la escritura falla, se
 * desmarca, así que dos clics a la vez no crean dos periodos.
 */
export async function pushImportCosts(importId: string): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { money: true });
  if ("error" in a) return a;
  if (!a.canPushCosts) return { error: "Pasar a Costos pide «Montos de compras» y «Editar costos»." };

  const [{ data: itemRows }, { data: costRows }, { data: supplier }] = await Promise.all([
    admin.from("import_items").select(`${ITEM_COLS}${ITEM_MONEY_COLS}`).eq("import_id", a.imp.id),
    admin.from("import_costs").select("id,kind,label,amount_usd,allocation,item_id").eq("import_id", a.imp.id),
    a.imp.supplier_id
      ? admin.from("import_suppliers").select("name").eq("id", a.imp.supplier_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const items = ((itemRows ?? []) as unknown as Record<string, unknown>[]).map((r) => normalizeItem(r, true));
  const landed = landedCosts(
    items.map((it) => ({
      id: it.id,
      name: it.name,
      qty: it.qty,
      unitCostUsd: it.unit_cost_usd ?? 0,
      unitWeightKg: it.unit_weight_kg,
      receivedQty: it.received_qty,
      damagedQty: it.damaged_qty,
    })),
    ((costRows ?? []) as { id: string; kind: "envio" | "importacion" | "adicional"; label: string; amount_usd: unknown; allocation: "value" | "units" | "weight" | "item"; item_id: string | null }[]).map(
      (c) => ({ id: c.id, kind: c.kind, label: c.label, amountUsd: Number(c.amount_usd) || 0, allocation: c.allocation, itemId: c.item_id }),
    ),
  );
  const plan = costPushPlan({
    status: a.imp.status,
    fxPenPerUsd: a.imp.fx_pen_per_usd ?? null,
    items: items.map((it) => ({
      id: it.id,
      name: it.name,
      sku: it.sku,
      storeId: it.store_id,
      receivedQty: it.received_qty,
      costPushedAt: it.cost_pushed_at,
    })),
    landed,
  });
  if (plan.alreadyDone) return { notice: "Ya se pasó a Costos." };
  if (!plan.ready) return { error: plan.blockers.join(" ") || "No hay productos para pasar a Costos." };

  const effectiveFrom = a.imp.arrived_on ?? limaToday();
  const supplierName = (supplier as { name?: string } | null)?.name ?? null;
  const pushed: string[] = [];
  const failed: string[] = [];
  // Un costo cargado en Costos desde la llegada o después no se borra (14-11-2026).
  const kept: string[] = [];
  for (const line of plan.lines) {
    if (line.state !== "push") continue;
    // El candado: solo la primera marca gana.
    const { data: claimed } = await admin
      .from("import_items")
      .update({ cost_pushed_at: new Date().toISOString(), cost_pushed_by: a.userId })
      .eq("id", line.itemId)
      .eq("import_id", a.imp.id)
      .is("cost_pushed_at", null)
      .select("id");
    if (!((claimed ?? []) as unknown[]).length) continue;
    const res = await insertProductCostPeriod(admin, {
      org_id: a.imp.org_id,
      store_id: line.storeId,
      sku: line.sku,
      product_name: line.name,
      supplier: supplierName,
      batch: a.imp.code,
      unit_cost: line.unitCostPen,
      currency: "PEN",
      effective_from: effectiveFrom,
      note: costPushNote(a.imp.code),
      created_by: a.userId,
    }, { laterOpen: "keep" });
    if (res.error) {
      await admin.from("import_items").update({ cost_pushed_at: null, cost_pushed_by: null }).eq("id", line.itemId);
      if (res.laterFrom) kept.push(`${line.sku} (desde el ${formatDmy(res.laterFrom)})`);
      else failed.push(line.sku);
    } else {
      pushed.push(line.sku);
    }
  }
  if (pushed.length) {
    await addEvent(
      admin,
      a.imp,
      a.userId,
      "costos",
      `Pasó a Costos: ${pushed.length} producto${pushed.length === 1 ? "" : "s"} (SKU ${pushed.join(", ")}), vigente desde ${formatDmy(effectiveFrom)}.`,
    );
  }
  revalidate(a.imp.id);
  revalidatePath("/dashboard/costos");
  const keptNote = kept.length
    ? ` Costos ya tiene un costo más reciente para ${kept.join(", ")}: no se tocó; revísalo en Costos.`
    : "";
  if (failed.length) return { error: `No se pudo pasar el SKU ${failed.join(", ")}. Lo demás quedó en Costos.${keptNote}` };
  if (kept.length) return pushed.length
    ? { notice: `Listo: ${pushed.length} costo${pushed.length === 1 ? "" : "s"} en Costos desde el ${formatDmy(effectiveFrom)}.${keptNote}` }
    : { error: keptNote.trim() };
  if (!pushed.length) return { notice: "Ya se pasó a Costos." };
  return { notice: `Listo: ${pushed.length} costo${pushed.length === 1 ? "" : "s"} en Costos de productos desde el ${formatDmy(effectiveFrom)}.` };
}
