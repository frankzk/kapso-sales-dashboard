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
//     esconderlos en la pantalla (`cleanItem(…, canMoney)`). Cada costo y cada
//     pago se guarda en SU moneda (USD o soles, 0342), sin convertir; con
//     «Incluye IGV» el costo guarda el monto con IGV y entra ÷ 1,18.
//   - «Pasar a Costos»: `purchases.money` y `costs.manage`.
//   - `purchases.receive` («Recepción de compras», MOM §45.11): SOLO registrar
//     entregas (MOM §45.14) y subir fotos (tipo «Foto»). Esas dos aceptan
//     `purchases.manage` o `purchases.receive`; corregir o quitar una entrega y
//     todo lo demás sigue pidiendo `purchases.manage` (y `purchases.money` lo
//     de dinero).
//   - Compras locales (MOM §45.12, 0343): el mismo flujo, en soles. Cada
//     entrega de una compra local lleva al menos una foto y cada pago, la
//     captura del comprobante; transporte, guía y «Avisar a la bodega» no
//     aplican.
//   - «Leer con IA» (MOM §45.10): lee y PROPONE; nada se guarda hasta
//     «Agregar seleccionados», que pasa por las mismas reglas y los mismos
//     hechos que agregar un producto o un costo a mano.
//
// Cada hecho queda en `import_events` (append-only). Los de dinero van con
// `kind = 'dinero'` y solo los ve quien tiene `purchases.money`.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import {
  COST_COLS,
  PAYMENT_COLS,
  DELIVERY_LINE_COLS,
  ITEM_COLS,
  ITEM_MONEY_COLS,
  comprasVisionCreds,
  loadImportAccess,
  loadSkuCatalog,
  normalizeCost,
  normalizeItem,
  normalizePayment,
  type ComprasPerms,
  type ImportRow,
} from "@/lib/compras-server";
import {
  DELIVERY_PHOTO_REQUIRED,
  IMPORT_CODE_PREFIX,
  IMPORT_FILES_BUCKET,
  IMPORT_STATUS_LABEL,
  allocationLabel,
  baseCurrencyOf,
  canUploadDocKind,
  checkImportFile,
  cleanCost,
  cleanDelivery,
  cleanFx,
  cleanHeader,
  cleanItem,
  cleanPayment,
  cleanStatusChange,
  cleanSupplier,
  costAmountText,
  costChangeNote,
  costKindLabel,
  costSnapshotOf,
  costPushNote,
  costPushPlan,
  defaultItemCostColumns,
  deliveryEventNote,
  deliveryNeedsPhoto,
  docKindLabel,
  formatDmy,
  hasShipping,
  importFileExt,
  importKindLabel,
  isImportFilePath,
  isImportKind,
  isMoneyDoc,
  isUuid,
  landedCostOf,
  landedCosts,
  landedItemOf,
  limaToday,
  limaYear,
  moneyText,
  nextImportCode,
  paymentChangeNote,
  paymentMethodLabel,
  paymentNeedsVoucher,
  paymentSnapshotOf,
  statusAfterDelivery,
  statusTraceBlocker,
  traceCodes,
  type DeliveryInput,
  type DeliveryLineValue,
  type DocKind,
  type HeaderInput,
  type HeaderValue,
  type ImportEventKind,
  type ImportKind,
  type ImportStatus,
  type ItemInput,
  type CostInput,
  type PaymentInput,
  type SupplierInput,
  type ItemValue,
  type CostKind,
  type CostValue,
  DOC_KINDS,
} from "@/lib/compras";
import { insertProductCostPeriod } from "@/lib/product-cost-periods";
import {
  aiConfirmToInputs,
  aiReadEventNote,
  buildCatalog,
  canReadWithAi,
  checkAiFile,
  matchCatalog,
  stripAiMoney,
  type AiConfirmInput,
  type AiLine,
} from "@/lib/compras-ia";
import { readPurchaseDocument } from "@/lib/compras-ia-vision";

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

/**
 * `manage`: «Compras». `money`: «Montos de compras». `receive`: «Compras» o
 * «Recepción de compras» (solo la recepción y las fotos, MOM §45.11).
 */
type Need = { manage?: boolean; money?: boolean; receive?: boolean };

type Access = { userId: string; imp: ImportRow; canMoney: boolean; canPushCosts: boolean; perms: ComprasPerms };

async function authorize(admin: SupabaseClient, importId: string, need: Need): Promise<Access | { error: string }> {
  const a = await loadImportAccess(importId, admin);
  if (!a) return { error: "Sin acceso a esta importación." };
  if (need.manage && !a.perms.canManage) return { error: "Tu rol no permite editar compras." };
  if (need.receive && !a.perms.canManage && !a.perms.canReceive) return { error: "Tu rol no permite registrar la recepción ni las entregas." };
  if (need.money && !a.perms.canMoney) return { error: "Hace falta el permiso «Montos de compras»." };
  return { userId: a.userId, imp: a.imp, canMoney: a.perms.canMoney, canPushCosts: a.perms.canPushCosts, perms: a.perms };
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
  revalidatePath(SUPPLIERS_PATH);
  return { id, notice: `Proveedor «${clean.value.name}» creado.` };
}

const SUPPLIERS_PATH = `${LIST_PATH}/proveedores`;

/** El proveedor y su organización, solo con «Compras» allí. */
async function authorizeSupplier(
  admin: SupabaseClient,
  supplierId: string,
): Promise<{ userId: string; supplier: { id: string; org_id: string; name: string } } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión otra vez." };
  if (!isUuid(supplierId)) return { error: "No encontramos ese proveedor." };
  const { data } = await admin.from("import_suppliers").select("id,org_id,name").eq("id", supplierId).maybeSingle();
  const supplier = data as { id: string; org_id: string; name: string } | null;
  if (!supplier) return { error: "No encontramos ese proveedor." };
  if (!(await hasOrgPermission(supplier.org_id, "purchases.manage"))) return { error: "Tu rol no permite editar compras." };
  return { userId: user.id, supplier };
}

/**
 * Editar un proveedor (MOM §45.7). Cambiarle el nombre no toca las
 * importaciones: apuntan al proveedor por su id.
 */
export async function updateSupplier(supplierId: string, input: SupplierInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorizeSupplier(admin, supplierId);
  if ("error" in a) return a;
  const clean = cleanSupplier(input);
  if ("error" in clean) return clean;
  const { data: same } = await admin
    .from("import_suppliers")
    .select("id,name")
    .eq("org_id", a.supplier.org_id)
    .ilike("name", clean.value.name);
  if (((same ?? []) as { id: string }[]).some((s) => s.id !== a.supplier.id)) return { error: "Ya existe un proveedor con ese nombre." };
  const { error } = await admin.from("import_suppliers").update(clean.value).eq("id", a.supplier.id).eq("org_id", a.supplier.org_id);
  if (error) return { error: error.code === "23505" ? "Ya existe un proveedor con ese nombre." : error.message };
  revalidate();
  revalidatePath(SUPPLIERS_PATH);
  return { id: a.supplier.id, notice: `Proveedor «${clean.value.name}» guardado.` };
}

/**
 * Borrar un proveedor (MOM §45.7): solo si no tiene NINGUNA importación (de
 * cualquier estado, también cancelada). Con importaciones, se edita.
 */
export async function deleteSupplier(supplierId: string): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorizeSupplier(admin, supplierId);
  if ("error" in a) return a;
  const { data: used, error: readError } = await admin
    .from("imports")
    .select("id")
    .eq("org_id", a.supplier.org_id)
    .eq("supplier_id", a.supplier.id)
    .limit(1);
  if (readError) return { error: readError.message };
  if ((used ?? []).length) return { error: `«${a.supplier.name}» tiene importaciones: no se puede borrar.` };
  const { error } = await admin.from("import_suppliers").delete().eq("id", a.supplier.id).eq("org_id", a.supplier.org_id);
  if (error) return { error: error.message };
  revalidate();
  revalidatePath(SUPPLIERS_PATH);
  return { notice: `Proveedor «${a.supplier.name}» borrado.` };
}

// ---------------------------------------------------------------------------
// La importación
// ---------------------------------------------------------------------------

/**
 * Crea la compra en Cotización con el siguiente código de su serie:
 * `IMP-<año de Lima>-NNN` una importación y `LOC-<año de Lima>-NNN` una compra
 * local a un laboratorio o maquila (MOM §45.12). El tipo no cambia después.
 */
export async function createImport(orgId: string, input: HeaderInput & { kind?: string | null }): Promise<ComprasActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión otra vez." };
  if (!isUuid(orgId) || !(await hasOrgPermission(orgId, "purchases.manage"))) {
    return { error: "Tu rol no permite crear importaciones." };
  }
  const rawKind = String(input.kind ?? "").trim() || "importacion";
  if (!isImportKind(rawKind)) return { error: "Tipo de compra inválido." };
  const kind: ImportKind = rawKind;
  const clean = cleanHeader(input, kind);
  if ("error" in clean) return clean;
  const admin = createAdminSupabase();
  if (!(await supplierInOrg(admin, orgId, clean.value.supplier_id))) return { error: "Ese proveedor no es de esta organización." };
  const header: HeaderValue = { ...clean.value, ordered_on: clean.value.ordered_on ?? limaToday() };

  const year = limaYear();
  const id = randomUUID();
  const prefix = IMPORT_CODE_PREFIX[kind];
  // Dos altas a la vez pueden elegir el mismo número: el índice único decide y
  // se reintenta con el siguiente.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: codes } = await admin.from("imports").select("code").eq("org_id", orgId).like("code", `${prefix}-${year}-%`);
    const code = nextImportCode(((codes ?? []) as { code: string }[]).map((c) => c.code), year, kind);
    const { error } = await admin
      .from("imports")
      .insert({ id, org_id: orgId, code, kind, status: "cotizacion", ...header, created_by: user.id });
    if (!error) {
      await addEvent(admin, { id, org_id: orgId }, user.id, "status", kind === "local" ? "Compra local creada" : "Importación creada", "cotizacion");
      revalidate(id);
      return { id, notice: `${importKindLabel(kind)} ${code} creada en Cotización.` };
    }
    if (error.code !== "23505") return { error: error.message };
  }
  return { error: "No se pudo asignar el código. Vuelve a intentarlo." };
}

const HEADER_LABEL: Record<keyof HeaderValue, string> = {
  supplier_id: "proveedor",
  origin: "origen",
  platform_order: "orden de Alibaba",
  proforma_number: "código de la proforma",
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
  // En una compra local no hay transporte ni guía (MOM §45.12): se ignoran.
  const clean = cleanHeader(input, a.imp.kind);
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
  // Los códigos de trazabilidad de una importación (MOM §45.15), de forma
  // progresiva: desde «Pagado» la proforma y la orden de Alibaba; desde «En
  // tránsito», también la guía. Cancelar nunca los pide; una nota tampoco.
  if (clean.value.changed) {
    const blocked = statusTraceBlocker(a.imp, clean.value.status);
    if (blocked) return { error: `${blocked.message} Complétalos en «Datos».` };
  }
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
  if (!hasShipping(a.imp.kind)) return { error: "El aviso a la bodega es de las importaciones: una compra local no lo lleva." };
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
  const clean = cleanItem(input, a.canMoney, baseCurrencyOf(a.imp.kind));
  if ("error" in clean) return clean;
  if (!(await storeInOrg(admin, a.imp.org_id, clean.value.store_id))) return { error: "Esa tienda no es de esta organización." };
  const imagePath = (input.imagePath ?? "").trim() || null;
  if (imagePath) {
    if (!isImportFilePath(imagePath, a.imp.org_id, a.imp.id, "items")) return { error: "La foto no es de esta importación." };
    const file = await checkUploadedFile(admin, imagePath, "item_photo", null);
    if ("error" in file) return file;
  }
  const inserted = await insertImportItem(admin, a, clean.value, imagePath);
  if ("error" in inserted) return inserted;
  revalidate(a.imp.id);
  return { notice: "Producto agregado." };
}

/** La siguiente posición de la lista de productos. */
async function nextItemPosition(admin: SupabaseClient, importId: string): Promise<number> {
  const { data: existing } = await admin.from("import_items").select("position").eq("import_id", importId);
  return ((existing ?? []) as { position: number }[]).reduce((m, r) => Math.max(m, Number(r.position) || 0), 0) + 1;
}

/**
 * Inserta un producto YA validado (`cleanItem`) y deja su hecho en el
 * historial. Lo usan «Agregar producto» y «Leer con IA».
 */
async function insertImportItem(
  admin: SupabaseClient,
  a: Access,
  v: ItemValue,
  imagePath: string | null,
  position?: number,
): Promise<{ id: string } | { error: string }> {
  const id = randomUUID();
  const { error } = await admin.from("import_items").insert({
    id,
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    // La moneda base de la compra con costo 0 si no se escribió (sin «Montos»):
    // en una compra local, soles (CHECK de la 0343).
    ...defaultItemCostColumns(baseCurrencyOf(a.imp.kind)),
    ...v,
    image_path: imagePath,
    position: position ?? (await nextItemPosition(admin, a.imp.id)),
  });
  if (error) return { error: error.message };
  const courtesy = v.courtesy_qty ? ` (+${v.courtesy_qty} de cortesía)` : "";
  await addEvent(admin, a.imp, a.userId, "producto", `Producto agregado: ${v.qty} × ${v.name}${courtesy}${v.sku ? ` (SKU ${v.sku})` : ""}.`);
  return { id };
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
  const clean = cleanItem(input, a.canMoney, baseCurrencyOf(a.imp.kind));
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
  // Lo que llegó de él es evidencia (MOM §45.14): con entregas, no se quita.
  const { data: delivered } = await admin.from("import_delivery_lines").select("id").eq("item_id", itemId).eq("import_id", a.imp.id).limit(1);
  if (((delivered ?? []) as unknown[]).length) {
    return { error: `«${item.name}» tiene entregas registradas: corrige o quita esas entregas antes de quitar el producto.` };
  }
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

/**
 * Agregar, cambiar o quitar la foto de un producto ya creado (MOM §45.1). La
 * foto nueva se sube antes con `startImportUpload(…, "item_photo")`; aquí se
 * comprueba que la ruta sea de esta importación y que el archivo sea una
 * imagen (tipo y tamaño de Storage), y la anterior se borra del bucket.
 * `imagePath` null = quitarla.
 */
export async function setImportItemPhoto(itemId: string, imagePath: string | null): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const item = await itemImport(admin, itemId);
  if (!item) return { error: "Ese producto ya no está." };
  const a = await authorize(admin, item.import_id, { manage: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  const next = (imagePath ?? "").trim() || null;
  if (!next && !item.image_path) return { notice: "El producto no tiene foto." };
  if (next) {
    if (next === item.image_path) return { notice: "Sin cambios." };
    if (!isImportFilePath(next, a.imp.org_id, a.imp.id, "items")) return { error: "La foto no es de esta importación." };
    const { data: used } = await admin.from("import_items").select("id").eq("import_id", a.imp.id).eq("image_path", next).limit(1);
    if (((used ?? []) as unknown[]).length) return { error: "Esa foto ya es de otro producto." };
    const file = await checkUploadedFile(admin, next, "item_photo", null);
    if ("error" in file) return file;
  }
  const { error } = await admin.from("import_items").update({ image_path: next }).eq("id", itemId).eq("import_id", a.imp.id);
  if (error) {
    if (next) await admin.storage.from(IMPORT_FILES_BUCKET).remove([next]).catch(() => {});
    return { error: error.message };
  }
  // La anterior ya no la usa nadie: fuera del bucket.
  if (item.image_path) await admin.storage.from(IMPORT_FILES_BUCKET).remove([item.image_path]).catch(() => {});
  const what = next ? (item.image_path ? "Foto cambiada" : "Foto agregada") : "Foto quitada";
  await addEvent(admin, a.imp, a.userId, "producto", `${what}: ${item.name}.`);
  revalidate(a.imp.id);
  return { notice: `${what}.` };
}

// ---------------------------------------------------------------------------
// Entregas parciales con evidencia (MOM §45.14, 0343)
// ---------------------------------------------------------------------------

/** Una foto ya subida (`startImportUpload(…, "photo")`) para una entrega. */
export interface DeliveryPhotoInput {
  path: string;
  filename?: string | null;
}

export interface DeliveryActionInput extends DeliveryInput {
  /** Fotos nuevas de lo que llegó (en una compra local, al menos una entre todas). */
  photos?: DeliveryPhotoInput[];
}

/** Tope de fotos por vez. */
const MAX_DELIVERY_PHOTOS = 10;

type CheckedPhoto = { path: string; filename: string | null; mime: string; size: number };

function cleanFilename(raw: unknown): string | null {
  return String(raw ?? "").replace(/[\u0000-\u001f/\\]/g, "_").trim().slice(0, 200) || null;
}

/** Las fotos nuevas: rutas de ESTA compra, imágenes de verdad (tipo y tamaño de Storage). */
async function checkDeliveryPhotos(admin: SupabaseClient, a: Access, photos: readonly DeliveryPhotoInput[]): Promise<CheckedPhoto[] | { error: string }> {
  if (photos.length > MAX_DELIVERY_PHOTOS) return { error: `Como máximo ${MAX_DELIVERY_PHOTOS} fotos por vez.` };
  const out: CheckedPhoto[] = [];
  for (const p of photos) {
    const path = String(p?.path ?? "").trim();
    if (!isImportFilePath(path, a.imp.org_id, a.imp.id, "docs")) return { error: "Una foto no es de esta compra." };
    if (out.some((x) => x.path === path)) continue;
    const filename = cleanFilename(p.filename);
    const file = await checkUploadedFile(admin, path, "photo", filename);
    if ("error" in file) return file;
    out.push({ path, filename, mime: file.mime, size: file.size });
  }
  return out;
}

/** Inserta las fotos de una entrega como documentos «Foto» ligados a ella, todas en una sola escritura. */
async function insertDeliveryPhotos(admin: SupabaseClient, a: Access, deliveryId: string, photos: readonly CheckedPhoto[]): Promise<{ error?: string }> {
  if (!photos.length) return {};
  const { error } = await admin.from("import_documents").insert(
    photos.map((p) => ({
      id: randomUUID(),
      org_id: a.imp.org_id,
      import_id: a.imp.id,
      kind: "photo",
      storage_path: p.path,
      filename: p.filename,
      mime: p.mime,
      size_bytes: p.size,
      uploaded_by: a.userId,
      delivery_id: deliveryId,
    })),
  );
  return error ? { error: error.message } : {};
}

type DeliveryItem = { id: string; name: string; qty: number; courtesy_qty: number };

async function loadDeliveryItems(admin: SupabaseClient, importId: string): Promise<DeliveryItem[]> {
  const { data } = await admin.from("import_items").select("id,name,qty,courtesy_qty").eq("import_id", importId);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), name: String(r.name), qty: Number(r.qty) || 0, courtesy_qty: Number(r.courtesy_qty) || 0 }));
}

function linesWithNames(lines: readonly DeliveryLineValue[], items: readonly DeliveryItem[]) {
  const name = new Map(items.map((i) => [i.id, i.name]));
  return lines.map((l) => ({ name: name.get(l.itemId) ?? "producto", received: l.received, damaged: l.damaged }));
}

/**
 * Después de una entrega (o de corregirla), el estado AVANZA solo si toca
 * (`statusAfterDelivery`, MOM §45.14): todo lo esperado llegó → «Recibido» con
 * la llegada del día de la última entrega; si no, «Recibido parcial». Los
 * totales del producto los dejó el trigger de la 0343 (Σ entregas): se leen de
 * la base, no se calculan aquí. Devuelve el estado nuevo o null.
 */
async function advanceAfterDelivery(admin: SupabaseClient, a: Access): Promise<ImportStatus | null | { error: string }> {
  const [{ data: rows }, { data: ds }] = await Promise.all([
    admin.from("import_items").select("id,qty,courtesy_qty,received_qty").eq("import_id", a.imp.id),
    admin.from("import_deliveries").select("delivered_on").eq("import_id", a.imp.id),
  ]);
  const items = ((rows ?? []) as Record<string, unknown>[]).map((r) => ({
    qty: Number(r.qty) || 0,
    courtesyQty: Number(r.courtesy_qty) || 0,
    receivedQty: r.received_qty == null ? null : Number(r.received_qty),
  }));
  const last = ((ds ?? []) as { delivered_on: string }[]).map((d) => d.delivered_on).sort().pop() ?? null;
  const next = statusAfterDelivery({ status: a.imp.status, items, lastDeliveredOn: last });
  if (!next) return null;
  const patch: Record<string, unknown> = { status: next.status };
  if (next.arrivedOn) patch.arrived_on = next.arrivedOn;
  const { error } = await admin.from("imports").update(patch).eq("id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "status",
    next.status === "recibido"
      ? `Al registrar las entregas: llegó todo lo esperado${next.arrivedOn ? ` (última entrega del ${formatDmy(next.arrivedOn)})` : ""}.`
      : "Al registrar una entrega: llegó una parte, falta lo demás.",
    next.status,
  );
  return next.status;
}

const movedNotice = (s: ImportStatus | null) =>
  s === "recibido" ? " Llegó todo lo esperado: pasó a Recibido." : s === "recibido_parcial" ? " Pasó a Recibido parcial." : "";

/**
 * «Registrar entrega» (MOM §45.14): la fecha (Lima), una nota, lo que llegó
 * por producto y sus fotos. «Compras» o «Recepción de compras» (la bodega). En
 * una compra local, al menos una foto. Los totales del producto los suma el
 * trigger de la 0343 en la misma transacción de cada línea; después, el estado
 * avanza solo si toca.
 */
export async function registerDelivery(importId: string, input: DeliveryActionInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { receive: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La compra está cancelada." };
  const items = await loadDeliveryItems(admin, a.imp.id);
  if (!items.length) return { error: "La compra todavía no tiene productos." };
  const clean = cleanDelivery(input, items.map((i) => i.id), limaToday());
  if ("error" in clean) return clean;
  const photos = await checkDeliveryPhotos(admin, a, input.photos ?? []);
  if ("error" in photos) return photos;
  if (deliveryNeedsPhoto(a.imp.kind) && !photos.length) return { error: DELIVERY_PHOTO_REQUIRED };

  const id = randomUUID();
  const { error } = await admin.from("import_deliveries").insert({
    id,
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    delivered_on: clean.value.delivered_on,
    note: clean.value.note,
    by_user: a.userId,
  });
  if (error) return { error: error.message };
  const undo = async () => {
    await admin.from("import_delivery_lines").delete().eq("delivery_id", id).eq("import_id", a.imp.id);
    await admin.from("import_deliveries").delete().eq("id", id).eq("import_id", a.imp.id);
  };
  const { error: linesError } = await admin.from("import_delivery_lines").insert(
    clean.value.lines.map((l) => ({
      id: randomUUID(),
      org_id: a.imp.org_id,
      import_id: a.imp.id,
      delivery_id: id,
      item_id: l.itemId,
      received: l.received,
      damaged: l.damaged,
      note: l.note,
    })),
  );
  if (linesError) {
    await undo();
    return { error: linesError.message };
  }
  const photoRes = await insertDeliveryPhotos(admin, a, id, photos);
  if (photoRes.error) {
    await undo();
    return { error: `No se pudieron guardar las fotos: ${photoRes.error}` };
  }
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "recepcion",
    deliveryEventNote("Entrega registrada", { delivered_on: clean.value.delivered_on, lines: linesWithNames(clean.value.lines, items), photos: photos.length }),
  );
  const moved = await advanceAfterDelivery(admin, a);
  if (moved && typeof moved === "object") return { error: moved.error };
  revalidate(a.imp.id);
  return { id, notice: `Entrega registrada.${movedNotice(moved)}` };
}

type DeliveryRecord = { id: string; import_id: string; delivered_on: string; note: string | null; legacy: boolean };

async function loadDelivery(admin: SupabaseClient, deliveryId: string): Promise<DeliveryRecord | null> {
  if (!isUuid(deliveryId)) return null;
  const { data } = await admin.from("import_deliveries").select("id,import_id,delivered_on,note,legacy").eq("id", deliveryId).maybeSingle();
  return (data as DeliveryRecord | null) ?? null;
}

async function deliveryLines(admin: SupabaseClient, d: DeliveryRecord): Promise<{ id: string; item_id: string; received: number; damaged: number; note: string | null }[]> {
  const { data } = await admin.from("import_delivery_lines").select(DELIVERY_LINE_COLS).eq("delivery_id", d.id).eq("import_id", d.import_id);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((l) => ({
    id: String(l.id),
    item_id: String(l.item_id),
    received: Number(l.received) || 0,
    damaged: Number(l.damaged) || 0,
    note: (l.note as string | null) ?? null,
  }));
}

/**
 * Corregir una entrega (MOM §45.14): fecha, nota, lo que llegó por producto y
 * fotos nuevas. Solo «Compras». Queda el antes y el después en el historial;
 * el estado solo avanza (nunca retrocede solo: si hace falta, se cambia a mano).
 */
export async function updateDelivery(deliveryId: string, input: DeliveryActionInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const d = await loadDelivery(admin, deliveryId);
  if (!d) return { error: "Esa entrega ya no está." };
  const a = await authorize(admin, d.import_id, { manage: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La compra está cancelada." };
  const items = await loadDeliveryItems(admin, a.imp.id);
  const clean = cleanDelivery(input, items.map((i) => i.id), limaToday());
  if ("error" in clean) return clean;
  const photos = await checkDeliveryPhotos(admin, a, input.photos ?? []);
  if ("error" in photos) return photos;
  if (deliveryNeedsPhoto(a.imp.kind) && !photos.length) {
    const { data: kept } = await admin.from("import_documents").select("id").eq("delivery_id", d.id).eq("import_id", a.imp.id).limit(1);
    if (!((kept ?? []) as unknown[]).length) return { error: DELIVERY_PHOTO_REQUIRED };
  }

  const before = await deliveryLines(admin, d);
  const { error } = await admin
    .from("import_deliveries")
    .update({ delivered_on: clean.value.delivered_on, note: clean.value.note })
    .eq("id", d.id)
    .eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  // Primero lo que se agrega o cambia, después lo que se quita: si algo falla
  // a la mitad, ningún producto queda con menos de lo que tenía.
  const byItem = new Map(before.map((l) => [l.item_id, l]));
  for (const l of clean.value.lines) {
    const old = byItem.get(l.itemId);
    if (old) {
      if (old.received === l.received && old.damaged === l.damaged && (old.note ?? null) === l.note) continue;
      const { error: e } = await admin
        .from("import_delivery_lines")
        .update({ received: l.received, damaged: l.damaged, note: l.note })
        .eq("id", old.id)
        .eq("import_id", a.imp.id);
      if (e) return { error: e.message };
    } else {
      const { error: e } = await admin.from("import_delivery_lines").insert({
        id: randomUUID(),
        org_id: a.imp.org_id,
        import_id: a.imp.id,
        delivery_id: d.id,
        item_id: l.itemId,
        received: l.received,
        damaged: l.damaged,
        note: l.note,
      });
      if (e) return { error: e.message };
    }
  }
  const keep = new Set(clean.value.lines.map((l) => l.itemId));
  const gone = before.filter((l) => !keep.has(l.item_id));
  if (gone.length) {
    const { error: e } = await admin.from("import_delivery_lines").delete().in("id", gone.map((l) => l.id)).eq("import_id", a.imp.id);
    if (e) return { error: e.message };
  }
  const photoRes = await insertDeliveryPhotos(admin, a, d.id, photos);
  if (photoRes.error) return { error: `La entrega se corrigió, pero no las fotos: ${photoRes.error}` };

  const name = new Map(items.map((i) => [i.id, i.name]));
  const beforeText = before.map((l) => `${l.received} × ${name.get(l.item_id) ?? "producto"}${l.damaged ? ` (${l.damaged} dañada${l.damaged === 1 ? "" : "s"})` : ""}`).join(" · ");
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "recepcion",
    `${deliveryEventNote("Entrega corregida", { delivered_on: clean.value.delivered_on, lines: linesWithNames(clean.value.lines, items), photos: photos.length })} Antes${d.delivered_on !== clean.value.delivered_on ? ` (del ${formatDmy(d.delivered_on)})` : ""}: ${beforeText || "nada"}.`,
  );
  const moved = await advanceAfterDelivery(admin, a);
  if (moved && typeof moved === "object") return { error: moved.error };
  revalidate(a.imp.id);
  return { notice: `Entrega corregida.${movedNotice(moved)}` };
}

/**
 * Quitar una entrega (MOM §45.14): sus unidades salen de los totales (trigger
 * de la 0343) y sus fotos se quedan en Documentos (la evidencia no se borra).
 * Solo «Compras». El estado no retrocede solo.
 */
export async function removeDelivery(deliveryId: string): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const d = await loadDelivery(admin, deliveryId);
  if (!d) return { error: "Esa entrega ya no está." };
  const a = await authorize(admin, d.import_id, { manage: true });
  if ("error" in a) return a;
  const [lines, items] = await Promise.all([deliveryLines(admin, d), loadDeliveryItems(admin, a.imp.id)]);
  const { data: photoRows } = await admin.from("import_documents").select("id").eq("delivery_id", d.id).eq("import_id", a.imp.id);
  const photos = ((photoRows ?? []) as unknown[]).length;
  // Las fotos quedan sueltas en Documentos (la 0343 también lo hace sola: `on delete set null`).
  if (photos) {
    const { error } = await admin.from("import_documents").update({ delivery_id: null }).eq("delivery_id", d.id).eq("import_id", a.imp.id);
    if (error) return { error: error.message };
  }
  const { error: linesError } = await admin.from("import_delivery_lines").delete().eq("delivery_id", d.id).eq("import_id", a.imp.id);
  if (linesError) return { error: linesError.message };
  const { error } = await admin.from("import_deliveries").delete().eq("id", d.id).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  const name = new Map(items.map((i) => [i.id, i.name]));
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "recepcion",
    `${deliveryEventNote("Entrega quitada", {
      delivered_on: d.delivered_on,
      lines: lines.map((l) => ({ name: name.get(l.item_id) ?? "producto", received: l.received, damaged: l.damaged })),
    })}${photos ? ` ${photos === 1 ? "Su foto queda" : `Sus ${photos} fotos quedan`} en Documentos.` : ""}`,
  );
  revalidate(a.imp.id);
  return { notice: "Entrega quitada: sus unidades ya no cuentan." };
}

// ---------------------------------------------------------------------------
// Dinero: costos y pagos (solo con «Montos de compras»)
// ---------------------------------------------------------------------------

export async function addImportCost(importId: string, input: CostInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: true });
  if ("error" in a) return a;
  const { data: rows } = await admin.from("import_items").select("id").eq("import_id", a.imp.id);
  const clean = cleanCost(input, ((rows ?? []) as { id: string }[]).map((r) => r.id), baseCurrencyOf(a.imp.kind));
  if ("error" in clean) return clean;
  const inserted = await insertImportCost(admin, a, clean.value);
  if ("error" in inserted) return inserted;
  revalidate(a.imp.id);
  return { notice: "Costo agregado." };
}

/**
 * Inserta un costo YA validado (`cleanCost`) con su hecho de dinero. Lo usan
 * «Agregar costo» y «Leer con IA». Quien llama ya pidió `money: true`.
 */
async function insertImportCost(admin: SupabaseClient, a: Access, v: CostValue): Promise<{ id: string } | { error: string }> {
  if (!a.canMoney) return { error: "Hace falta el permiso «Montos de compras»." };
  const id = randomUUID();
  const { error } = await admin.from("import_costs").insert({
    id,
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    ...v,
    created_by: a.userId,
  });
  if (error) return { error: error.message };
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "dinero",
    `Costo agregado: ${costKindLabel(v.kind)} · ${v.label} · ${costAmountText({ ...v, amount: (v.currency === "PEN" ? v.amount_pen : v.amount_usd) ?? 0 })} · ${allocationLabel(v.allocation).toLowerCase()}.`,
  );
  return { id };
}

/**
 * Editar un costo (MOM §45.3, «permíteme editar los costos»): tipo, nombre,
 * moneda y monto, IGV, reparto y producto, con las MISMAS reglas que
 * agregarlo (`cleanCost`) y el mismo permiso («Compras» y «Montos de
 * compras»). No en una compra cancelada. El hecho de dinero dice qué cambió.
 */
export async function updateImportCost(costId: string, input: CostInput): Promise<ComprasActionState> {
  if (!isUuid(costId)) return { error: "Ese costo ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_costs").select(`import_id,${COST_COLS}`).eq("id", costId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row) return { error: "Ese costo ya no está." };
  const a = await authorize(admin, String(row.import_id), { manage: true, money: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  const before = normalizeCost(row);
  const { data: rows } = await admin.from("import_items").select("id,name").eq("import_id", a.imp.id);
  const items = (rows ?? []) as { id: string; name: string }[];
  const clean = cleanCost(input, items.map((r) => r.id), baseCurrencyOf(a.imp.kind));
  if ("error" in clean) return clean;
  const name = new Map(items.map((i) => [i.id, i.name]));
  const note = costChangeNote(
    { ...before, igv_treatment: before.igv_treatment },
    costSnapshotOf(clean.value),
    (id) => (id ? (name.get(id) ?? "un producto") : "un producto que ya no está"),
  );
  if (!note) return { notice: "Sin cambios." };
  const { error } = await admin.from("import_costs").update(clean.value).eq("id", costId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", note);
  revalidate(a.imp.id);
  return { notice: "Costo guardado." };
}

export async function removeImportCost(costId: string): Promise<ComprasActionState> {
  if (!isUuid(costId)) return { error: "Ese costo ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_costs").select(`import_id,${COST_COLS}`).eq("id", costId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row) return { error: "Ese costo ya no está." };
  const cost = { import_id: String(row.import_id), ...normalizeCost(row) };
  const a = await authorize(admin, cost.import_id, { manage: true, money: true });
  if ("error" in a) return a;
  const { error } = await admin.from("import_costs").delete().eq("id", costId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", `Costo quitado: ${cost.label} · ${costAmountText(cost)}.`);
  revalidate(a.imp.id);
  return { notice: "Costo quitado." };
}

/**
 * Registrar un pago. El comprobante puede ser uno ya subido (`documentId`) o la
 * captura que se adjunta en el mismo formulario (`voucher`: ya subida con
 * `startImportUpload(…, "payment")`), que se registra como «Comprobante de
 * pago» y queda ligada al pago. En una compra local el comprobante es
 * obligatorio (MOM §45.12); en una importación, opcional.
 */
export async function addImportPayment(
  importId: string,
  input: PaymentInput & { voucher?: { path: string; filename?: string | null } | null },
): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true, money: true });
  if ("error" in a) return a;
  const { data: docs } = await admin.from("import_documents").select("id").eq("import_id", a.imp.id).eq("kind", "payment");
  const docIds = ((docs ?? []) as { id: string }[]).map((d) => d.id);
  let voucher: { id: string; path: string; filename: string | null; mime: string; size: number } | null = null;
  if (input.voucher?.path) {
    const path = String(input.voucher.path).trim();
    if (!isImportFilePath(path, a.imp.org_id, a.imp.id, "docs")) return { error: "El comprobante no es de esta compra." };
    const filename = cleanFilename(input.voucher.filename);
    const file = await checkUploadedFile(admin, path, "payment", filename);
    if ("error" in file) return file;
    voucher = { id: randomUUID(), path, filename, mime: file.mime, size: file.size };
    docIds.push(voucher.id);
  }
  const clean = cleanPayment(voucher ? { ...input, documentId: voucher.id } : input, docIds, {
    voucherRequired: paymentNeedsVoucher(a.imp.kind),
    base: baseCurrencyOf(a.imp.kind),
  });
  if ("error" in clean) {
    if (voucher) await admin.storage.from(IMPORT_FILES_BUCKET).remove([voucher.path]).catch(() => {});
    return clean;
  }
  if (voucher) {
    const { error } = await admin.from("import_documents").insert({
      id: voucher.id,
      org_id: a.imp.org_id,
      import_id: a.imp.id,
      kind: "payment",
      storage_path: voucher.path,
      filename: voucher.filename,
      mime: voucher.mime,
      size_bytes: voucher.size,
      uploaded_by: a.userId,
    });
    if (error) return { error: error.message };
    await addEvent(admin, a.imp, a.userId, "dinero", `Documento subido: ${docKindLabel("payment")}${voucher.filename ? ` (${voucher.filename})` : ""}.`);
  }
  const { error } = await admin.from("import_payments").insert({
    id: randomUUID(),
    org_id: a.imp.org_id,
    import_id: a.imp.id,
    ...clean.value,
    created_by: a.userId,
  });
  if (error) {
    // Sin pago, la captura que se subió para él no queda suelta.
    if (voucher) {
      await admin.from("import_documents").delete().eq("id", voucher.id).eq("import_id", a.imp.id);
      await admin.storage.from(IMPORT_FILES_BUCKET).remove([voucher.path]).catch(() => {});
    }
    return { error: error.message };
  }
  const v = clean.value;
  const amount = (v.currency === "PEN" ? v.amount_pen : v.amount_usd) ?? 0;
  await addEvent(
    admin,
    a.imp,
    a.userId,
    "dinero",
    `Pago registrado: ${moneyText(amount, v.currency)} · ${paymentMethodLabel(v.method)} · ${formatDmy(v.paid_on)}${v.document_id ? " · con comprobante" : ""}.`,
  );
  revalidate(a.imp.id);
  return { notice: "Pago registrado." };
}

/**
 * Editar un pago (MOM §45.3): monto y moneda, fecha, método, nota y
 * comprobante, con las mismas reglas que registrarlo (`cleanPayment`) y el
 * mismo permiso. Sin tocarlo, el comprobante se queda; en una compra local
 * sigue siendo obligatorio. Se puede adjuntar una captura nueva (`voucher`). No
 * en una compra cancelada. El hecho de dinero dice qué cambió.
 */
export async function updateImportPayment(
  paymentId: string,
  input: PaymentInput & { voucher?: { path: string; filename?: string | null } | null },
): Promise<ComprasActionState> {
  if (!isUuid(paymentId)) return { error: "Ese pago ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_payments").select(`import_id,${PAYMENT_COLS}`).eq("id", paymentId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row) return { error: "Ese pago ya no está." };
  const a = await authorize(admin, String(row.import_id), { manage: true, money: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  const before = normalizePayment(row);
  const { data: docs } = await admin.from("import_documents").select("id").eq("import_id", a.imp.id).eq("kind", "payment");
  const docIds = ((docs ?? []) as { id: string }[]).map((d) => d.id);
  let voucher: { id: string; path: string; filename: string | null; mime: string; size: number } | null = null;
  if (input.voucher?.path) {
    const path = String(input.voucher.path).trim();
    if (!isImportFilePath(path, a.imp.org_id, a.imp.id, "docs")) return { error: "El comprobante no es de esta compra." };
    const filename = cleanFilename(input.voucher.filename);
    const file = await checkUploadedFile(admin, path, "payment", filename);
    if ("error" in file) return file;
    voucher = { id: randomUUID(), path, filename, mime: file.mime, size: file.size };
    docIds.push(voucher.id);
  }
  // Sin decir nada del comprobante, se queda el que tenía.
  const documentId = voucher ? voucher.id : input.documentId === undefined ? before.document_id : input.documentId;
  const clean = cleanPayment({ ...input, documentId }, docIds, {
    voucherRequired: paymentNeedsVoucher(a.imp.kind),
    base: baseCurrencyOf(a.imp.kind),
  });
  if ("error" in clean) {
    if (voucher) await admin.storage.from(IMPORT_FILES_BUCKET).remove([voucher.path]).catch(() => {});
    return clean;
  }
  const note = paymentChangeNote(before, paymentSnapshotOf(clean.value));
  if (!note) {
    if (voucher) await admin.storage.from(IMPORT_FILES_BUCKET).remove([voucher.path]).catch(() => {});
    return { notice: "Sin cambios." };
  }
  if (voucher) {
    const { error } = await admin.from("import_documents").insert({
      id: voucher.id,
      org_id: a.imp.org_id,
      import_id: a.imp.id,
      kind: "payment",
      storage_path: voucher.path,
      filename: voucher.filename,
      mime: voucher.mime,
      size_bytes: voucher.size,
      uploaded_by: a.userId,
    });
    if (error) return { error: error.message };
    await addEvent(admin, a.imp, a.userId, "dinero", `Documento subido: ${docKindLabel("payment")}${voucher.filename ? ` (${voucher.filename})` : ""}.`);
  }
  const { error } = await admin.from("import_payments").update(clean.value).eq("id", paymentId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", note);
  revalidate(a.imp.id);
  return { notice: "Pago guardado." };
}

export async function removeImportPayment(paymentId: string): Promise<ComprasActionState> {
  if (!isUuid(paymentId)) return { error: "Ese pago ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("import_payments")
    .select("id,import_id,currency,amount_usd,amount_pen,paid_on,method")
    .eq("id", paymentId)
    .maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row) return { error: "Ese pago ya no está." };
  const pay = { import_id: String(row.import_id), ...normalizePayment(row) };
  const a = await authorize(admin, pay.import_id, { manage: true, money: true });
  if ("error" in a) return a;
  const { error } = await admin.from("import_payments").delete().eq("id", paymentId).eq("import_id", a.imp.id);
  if (error) return { error: error.message };
  await addEvent(admin, a.imp, a.userId, "dinero", `Pago quitado: ${moneyText(pay.amount, pay.currency)} del ${formatDmy(pay.paid_on)}.`);
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
 * ¿Sube (y registra) este tipo de documento? Con «Compras», los que no tienen
 * montos, y con «Montos» además la proforma y el comprobante; con «Recepción
 * de compras», solo fotos (MOM §45.11). Null = sí; si no, el motivo.
 */
function uploadDenied(kind: DocKind, perms: ComprasPerms): string | null {
  if (canUploadDocKind(kind, perms)) return null;
  if (perms.canManage && isMoneyDoc(kind)) return "Hace falta el permiso «Montos de compras».";
  return perms.canReceive ? "Con «Recepción de compras» solo se suben fotos." : "Tu rol no permite editar compras.";
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
  // La foto de un producto es de «Compras»; un documento, según su tipo
  // (`uploadDenied`): la foto de la recepción también con «Recepción de compras».
  const a = await authorize(admin, importId, kind === "item_photo" ? { manage: true } : { receive: kind === "photo" });
  if ("error" in a) return a;
  if (kind !== "item_photo") {
    const denied = uploadDenied(kind, a.perms);
    if (denied) return { error: denied };
  }
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
  input: { kind: string; path: string; filename: string; deliveryId?: string | null },
): Promise<ComprasActionState> {
  if (!isDocKind(input.kind)) return { error: "Tipo de documento inválido." };
  const kind = input.kind;
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { receive: kind === "photo" });
  if ("error" in a) return a;
  const denied = uploadDenied(kind, a.perms);
  if (denied) return { error: denied };
  if (!isImportFilePath(input.path, a.imp.org_id, a.imp.id, "docs")) return { error: "El archivo no es de esta importación." };
  // Una foto más de una entrega ya registrada (MOM §45.14): la entrega es de ESTA compra.
  const deliveryId = String(input.deliveryId ?? "").trim() || null;
  let delivery: DeliveryRecord | null = null;
  if (deliveryId) {
    if (kind !== "photo") return { error: "A una entrega solo se le agregan fotos." };
    delivery = await loadDelivery(admin, deliveryId);
    if (!delivery || delivery.import_id !== a.imp.id) return { error: "Esa entrega no es de esta compra." };
  }
  const filename = cleanFilename(input.filename);
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
    ...(delivery ? { delivery_id: delivery.id } : {}),
  });
  if (error) return { error: error.message };
  await addEvent(
    admin,
    a.imp,
    a.userId,
    delivery ? "recepcion" : isMoneyDoc(kind) ? "dinero" : "documento",
    delivery
      ? `Foto agregada a la entrega del ${formatDmy(delivery.delivered_on)}${filename ? ` (${filename})` : ""}.`
      : `Documento subido: ${docKindLabel(kind)}${filename ? ` (${filename})` : ""}.`,
  );
  revalidate(a.imp.id);
  return { id, notice: delivery ? "Foto agregada a la entrega." : "Documento subido." };
}

export async function removeImportDocument(documentId: string): Promise<ComprasActionState> {
  if (!isUuid(documentId)) return { error: "Ese documento ya no está." };
  const admin = createAdminSupabase();
  const { data } = await admin.from("import_documents").select("import_id,kind,storage_path,filename,delivery_id").eq("id", documentId).maybeSingle();
  const doc = data as { import_id: string; kind: string; storage_path: string; filename: string | null; delivery_id?: string | null } | null;
  if (!doc) return { error: "Ese documento ya no está." };
  const a = await authorize(admin, doc.import_id, { manage: true, money: isMoneyDoc(doc.kind) });
  if ("error" in a) return a;
  // La evidencia obligatoria de una compra local (MOM §45.12, §45.14) no se queda en cero.
  if (paymentNeedsVoucher(a.imp.kind) && doc.kind === "payment") {
    const { data: paid } = await admin.from("import_payments").select("id").eq("document_id", documentId).eq("import_id", a.imp.id).limit(1);
    if (((paid ?? []) as unknown[]).length) return { error: "Es el comprobante de un pago de esta compra local: quita primero el pago." };
  }
  if (deliveryNeedsPhoto(a.imp.kind) && doc.delivery_id) {
    const { data: siblings } = await admin.from("import_documents").select("id").eq("delivery_id", doc.delivery_id).eq("import_id", a.imp.id);
    if (((siblings ?? []) as { id: string }[]).filter((x) => x.id !== documentId).length === 0) {
      return { error: "Es la única foto de esa entrega: agrega otra antes de quitarla, o quita la entrega." };
    }
  }
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
    admin.from("import_costs").select(COST_COLS).eq("import_id", a.imp.id),
    a.imp.supplier_id
      ? admin.from("import_suppliers").select("name").eq("id", a.imp.supplier_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const items = ((itemRows ?? []) as unknown as Record<string, unknown>[]).map((r) => normalizeItem(r, true));
  // En soles: el proveedor y los costos en USD × el tipo de cambio de la
  // importación, y los costos en soles TAL CUAL (0342); se redondea al final.
  const landed = landedCosts(
    items.map(landedItemOf),
    ((costRows ?? []) as unknown as Record<string, unknown>[]).map((r) => landedCostOf(normalizeCost(r))),
    a.imp.fx_pen_per_usd ?? null,
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
    // Una importación pide sus tres códigos de trazabilidad (MOM §45.15).
    trace: traceCodes(a.imp),
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

// ---------------------------------------------------------------------------
// «Leer con IA» (MOM §45.10)
// ---------------------------------------------------------------------------

/** Una línea propuesta, con el SKU conocido que coincide (si coincide). */
export type AiProposalLine = AiLine & { match: { sku: string; name: string | null; storeId: string | null } | null };

export type AiReadState =
  | { error: string }
  | {
      documentId: string;
      filename: string | null;
      /** Sin «Montos de compras»: null, y ni precios ni cargos. */
      currency: string | null;
      lines: AiProposalLine[];
      /** Cada cargo en la moneda que dice el documento (un courier de Perú, en soles). */
      charges: { kind: CostKind; label: string; amount: number; currency: string | null; igvTreatment: "neto" | "inafecto" }[];
      /** El IGV del documento, aparte: se muestra, nunca se agrega como costo. */
      igv: { amount: number; currency: string | null } | null;
      /** Filas que la IA devolvió sin nombre, sin cantidad o sin monto. */
      dropped: number;
      /** Productos que la importación ya tenía (lo leído se agrega aparte). */
      existingItems: number;
      money: boolean;
      /** La moneda base de la compra (MOM §45.12): en una compra local los precios van en soles. */
      base: "USD" | "PEN";
    };

type AiDoc = { id: string; import_id: string; kind: string; storage_path: string; filename: string | null; mime: string; size_bytes: number };

async function loadAiDoc(admin: SupabaseClient, documentId: string): Promise<AiDoc | null> {
  if (!isUuid(documentId)) return null;
  const { data } = await admin
    .from("import_documents")
    .select("id,import_id,kind,storage_path,filename,mime,size_bytes")
    .eq("id", documentId)
    .maybeSingle();
  const doc = data as AiDoc | null;
  return doc ? { ...doc, size_bytes: Number(doc.size_bytes) || 0 } : null;
}

/**
 * Lee con IA una factura comercial, proforma o packing list ya subido y
 * devuelve la PROPUESTA: no escribe nada (ni filas ni hechos). Pide «Compras»
 * (y «Montos» si es la proforma); sin «Montos de compras» la propuesta sale
 * sin precios, sin cargos y sin moneda, quitados aquí, antes de llegar al
 * navegador. Sugiere el SKU y la tienda conocidos de cada línea (§6.9 de la
 * referencia).
 */
export async function readImportDocumentWithAi(documentId: string): Promise<AiReadState> {
  const admin = createAdminSupabase();
  const doc = await loadAiDoc(admin, documentId);
  if (!doc) return { error: "Ese documento ya no está." };
  const a = await authorize(admin, doc.import_id, { manage: true, money: isMoneyDoc(doc.kind) });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  if (!canReadWithAi(doc)) return { error: "«Leer con IA» es para la factura comercial, la proforma o el packing list en PDF o imagen." };
  const fileCheck = checkAiFile({ kind: doc.kind, mime: doc.mime, size: doc.size_bytes });
  if ("error" in fileCheck) return fileCheck;

  const creds = await comprasVisionCreds(a.imp.org_id, admin);
  if (!creds.apiKey) return { error: "No hay una clave de IA configurada para leer documentos." };
  const { data: blob, error: downloadError } = await admin.storage.from(IMPORT_FILES_BUCKET).download(doc.storage_path);
  if (downloadError || !blob) return { error: "No se pudo abrir el archivo. Vuelve a subirlo." };
  const bytes = Buffer.from(await blob.arrayBuffer());
  // El tamaño real, no el que se anotó al subirlo.
  const realCheck = checkAiFile({ kind: doc.kind, mime: doc.mime, size: bytes.length });
  if ("error" in realCheck) return realCheck;

  const read = await readPurchaseDocument(bytes.toString("base64"), doc.mime, creds);
  if (!read.ok) return { error: read.error };
  const proposal = a.canMoney ? read.proposal : stripAiMoney(read.proposal);

  const [catalogRows, { data: existing }] = await Promise.all([
    loadSkuCatalog(a.imp.org_id, admin).catch(() => []),
    admin.from("import_items").select("id").eq("import_id", a.imp.id),
  ]);
  const catalog = buildCatalog(catalogRows);
  return {
    documentId: doc.id,
    filename: doc.filename,
    currency: proposal.currency,
    lines: proposal.lines.map((l) => {
      const m = matchCatalog(l, catalog);
      return { ...l, match: m ? { sku: m.sku, name: m.name, storeId: m.storeId } : null };
    }),
    charges: proposal.charges,
    igv: proposal.igv,
    dropped: proposal.dropped,
    existingItems: ((existing ?? []) as unknown[]).length,
    money: a.canMoney,
    base: baseCurrencyOf(a.imp.kind),
  };
}

/**
 * «Agregar seleccionados»: lo que la persona revisó y dejó marcado en la
 * propuesta. Todo se valida ANTES de escribir nada, con las mismas reglas que
 * a mano (`cleanItem`, `cleanCost`), y cada fila deja el mismo hecho que
 * «Agregar producto» / «Agregar costo»; al final, «Leído con IA: …». Sin
 * «Montos de compras» no se leen precios, cargos ni tipo de cambio (ver
 * `aiConfirmToInputs`). Con «Montos», si el documento no está en USD hace
 * falta «1 USD = X <moneda>» para los precios: el precio por unidad pasa a USD
 * a 4 decimales. Un cargo en USD o en soles se guarda en SU moneda (0342); uno
 * en la moneda del documento (CNY, EUR…) pasa a USD a 2 decimales. El IGV del
 * documento nunca se agrega.
 */
export async function addAiProposalRows(importId: string, input: AiConfirmInput): Promise<ComprasActionState> {
  const admin = createAdminSupabase();
  const a = await authorize(admin, importId, { manage: true });
  if ("error" in a) return a;
  if (a.imp.status === "cancelado") return { error: "La importación está cancelada." };
  const doc = await loadAiDoc(admin, String(input.documentId ?? ""));
  if (!doc || doc.import_id !== a.imp.id || !canReadWithAi(doc)) return { error: "El documento leído no es de esta importación." };
  if (isMoneyDoc(doc.kind) && !a.canMoney) return { error: "Hace falta el permiso «Montos de compras»." };

  const base = baseCurrencyOf(a.imp.kind);
  const conv = aiConfirmToInputs(input, a.canMoney, base);
  if ("error" in conv) return conv;

  const items: ItemValue[] = [];
  for (const [i, row] of conv.items.entries()) {
    const clean = cleanItem(row, a.canMoney, base);
    if ("error" in clean) return { error: `Producto ${i + 1}: ${clean.error}` };
    items.push(clean.value);
  }
  for (const storeId of new Set(items.map((v) => v.store_id).filter((id): id is string => Boolean(id)))) {
    if (!(await storeInOrg(admin, a.imp.org_id, storeId))) return { error: "Esa tienda no es de esta organización." };
  }
  const { data: rows } = await admin.from("import_items").select("id").eq("import_id", a.imp.id);
  const itemIds = ((rows ?? []) as { id: string }[]).map((r) => r.id);
  const costs: CostValue[] = [];
  for (const [i, c] of conv.costs.entries()) {
    const clean = cleanCost(c, itemIds, base);
    if ("error" in clean) return { error: `Cargo ${i + 1}: ${clean.error}` };
    costs.push(clean.value);
  }

  let addedItems = 0;
  let addedCosts = 0;
  let failure: string | null = null;
  let position = await nextItemPosition(admin, a.imp.id);
  for (const v of items) {
    const res = await insertImportItem(admin, a, v, null, position++);
    if ("error" in res) {
      failure = res.error;
      break;
    }
    addedItems++;
  }
  if (!failure) {
    for (const v of costs) {
      const res = await insertImportCost(admin, a, v);
      if ("error" in res) {
        failure = res.error;
        break;
      }
      addedCosts++;
    }
  }
  if (addedItems || addedCosts) {
    await addEvent(admin, a.imp, a.userId, "documento", aiReadEventNote(addedItems, addedCosts, doc.filename));
  }
  revalidate(a.imp.id);
  if (failure) return { error: `Se agregaron ${addedItems} productos y ${addedCosts} cargos; lo demás falló: ${failure}` };
  return { notice: `Agregados ${addedItems} producto${addedItems === 1 ? "" : "s"} y ${addedCosts} cargo${addedCosts === 1 ? "" : "s"}.` };
}
