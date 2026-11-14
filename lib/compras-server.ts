import "server-only";

// «Compras» (MOM §45): lecturas y autorización del servidor. Las tablas no
// tienen políticas de RLS (0340): todo se lee con service role DESPUÉS de
// comprobar el permiso en la organización de la importación. Sin
// `purchases.money` las columnas de dinero no se piden a la base (no basta con
// no mostrarlas) y los costos, pagos, documentos con montos y eventos de dinero
// no se leen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission, orgsWithPermission } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import type { Permission } from "@/lib/permissions";
import {
  MONEY_EVENT_KINDS,
  MOVEMENT_EVENT_KINDS,
  canSeeDocKind,
  canViewCompras,
  isReceiveOnly,
  addMoney,
  igvTreatmentOf,
  importKindOf,
  isUuid,
  traceCodeKey,
  moneyOf,
  paymentBalance,
  zeroMoney,
  type Allocation,
  type CostKind,
  type Currency,
  type IgvTreatment,
  type ImportEventKind,
  type ImportKind,
  type ImportStatus,
  type Money2,
} from "@/lib/compras";
import type { ReportImport } from "@/lib/compras-reportes";
import type { CatalogEntry } from "@/lib/compras-ia";
import { resolveVisionCreds } from "@/lib/vision";
import { storeVisionCreds } from "@/lib/store-settings";

export const IMPORT_COLS: string =
  "id,org_id,code,kind,supplier_id,origin,platform_order,proforma_number,transport,carrier,tracking_number,tracking_url,ordered_on,eta,arrived_on,status,reported_to_warehouse_at,reported_by,notes,created_by,created_at,updated_at";
/** Solo con `purchases.money`. */
export const IMPORT_MONEY_COLS: string = ",fx_pen_per_usd";
/** `unit_cost_currency` no es un monto: dice en qué moneda va el costo (0343). */
export const ITEM_COLS: string =
  "id,import_id,store_id,sku,name,image_path,qty,courtesy_qty,unit_cost_currency,unit_weight_kg,received_qty,damaged_qty,reception_note,received_at,cost_pushed_at,position,created_at";
/** Solo con `purchases.money`. */
export const ITEM_MONEY_COLS: string = ",unit_cost_usd,unit_cost_pen,sale_price_pen";
/** Las entregas y sus líneas (MOM §45.14): sin montos, las ve cualquiera que abra Compras. */
export const DELIVERY_COLS: string = "id,import_id,delivered_on,note,by_user,legacy,created_at,updated_at";
export const DELIVERY_LINE_COLS: string = "id,delivery_id,item_id,received,damaged,note";
export const DOCUMENT_COLS: string = "id,kind,filename,mime,size_bytes,created_at,delivery_id";

export interface ImportRow {
  id: string;
  org_id: string;
  code: string;
  /** 0343 (MOM §45.12): importación o compra local; sin la columna, importación. */
  kind: ImportKind;
  supplier_id: string | null;
  origin: string | null;
  /** «Orden de Alibaba» (código de trazabilidad, MOM §45.15). */
  platform_order: string | null;
  /** «Código de la proforma invoice» (0343, MOM §45.15). */
  proforma_number?: string | null;
  transport: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ordered_on: string | null;
  eta: string | null;
  arrived_on: string | null;
  status: ImportStatus;
  reported_to_warehouse_at: string | null;
  reported_by: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Solo con `purchases.money`. */
  fx_pen_per_usd?: number | null;
}

export interface ItemRow {
  id: string;
  import_id: string;
  store_id: string | null;
  sku: string | null;
  name: string;
  image_path: string | null;
  qty: number;
  /** Cortesía (MOM §45.13): unidades gratis que también se esperan. */
  courtesy_qty: number;
  /** En qué moneda va el costo por unidad (0343): USD en una importación, PEN en una compra local. */
  unit_cost_currency: Currency;
  unit_weight_kg: number | null;
  /** Σ de sus entregas (trigger de la 0343); null sin ninguna. */
  received_qty: number | null;
  damaged_qty: number | null;
  reception_note: string | null;
  received_at: string | null;
  cost_pushed_at: string | null;
  position: number;
  created_at: string;
  /** Solo con `purchases.money`. */
  unit_cost_usd?: number | null;
  unit_cost_pen?: number | null;
  sale_price_pen?: number | null;
}

/** Una entrega con sus líneas y sus fotos (MOM §45.14). Sin montos. */
export interface DeliveryRow {
  id: string;
  delivered_on: string;
  note: string | null;
  by_user: string | null;
  by_name: string | null;
  /** La recepción de antes de la 0343, pasada a entrega por el backfill. */
  legacy: boolean;
  created_at: string;
  updated_at: string;
  lines: { id: string; item_id: string; received: number; damaged: number; note: string | null }[];
  photos: DocumentRow[];
}

export interface SupplierRow {
  id: string;
  name: string;
  country: string | null;
  whatsapp: string | null;
  notes: string | null;
  /** Desde la 0341 (MOM §45.7). */
  contact_name: string | null;
  email: string | null;
  payment_terms: string | null;
}

export const SUPPLIER_COLS: string = "id,name,country,whatsapp,notes,contact_name,email,payment_terms";

export interface DocumentRow {
  id: string;
  kind: string;
  filename: string | null;
  mime: string;
  size_bytes: number;
  created_at: string;
  /** La entrega de la que es foto (0343), si lo es. */
  delivery_id?: string | null;
}

/** Un costo leído (0342): el monto en su moneda, sin IGV. */
export interface CostRow {
  id: string;
  kind: string;
  label: string;
  currency: Currency;
  /** Lo que entra al costo (sin IGV), en `currency`. */
  amount: number;
  /** «Incluye IGV»: `gross_amount` es el monto con IGV tal como se escribió. */
  includes_igv: boolean;
  gross_amount: number | null;
  /** 0343 (MOM §45.3): neto, con_igv o inafecto. */
  igv_treatment: IgvTreatment;
  allocation: string;
  item_id: string | null;
  created_at: string;
}

/** Un pago leído (0342): el monto en su moneda. */
export interface PaymentRow {
  id: string;
  currency: Currency;
  amount: number;
  paid_on: string;
  method: string;
  note: string | null;
  document_id: string | null;
  created_at: string;
}

/** Las columnas de `import_costs` que se leen (solo con `purchases.money`). */
export const COST_COLS: string = "id,kind,label,currency,amount_usd,amount_pen,includes_igv,gross_amount,igv_treatment,allocation,item_id,created_at";
/** Las columnas de `import_payments` que se leen (solo con `purchases.money`). */
export const PAYMENT_COLS: string = "id,currency,amount_usd,amount_pen,paid_on,method,note,document_id,created_at";

export interface EventRow {
  id: string;
  kind: ImportEventKind;
  status: ImportStatus | null;
  note: string | null;
  by_user: string | null;
  by_name: string | null;
  at: string;
}

/**
 * Los permisos que abren Compras (lista y detalle). Una vendedora con alguno
 * —la bodega con el rol «Almacén» trae «Recepción de compras»— entra aunque el
 * resto del panel completo no sea para ella (MOM §45.11).
 */
export const COMPRAS_VIEW_PERMISSIONS: readonly Permission[] = ["purchases.manage", "purchases.money", "purchases.receive"];

export interface ComprasPerms {
  canManage: boolean;
  canMoney: boolean;
  /** «Recepción de compras» (MOM §45.11): ver sin montos, recepción y fotos. */
  canReceive: boolean;
  /** «Pasar a Costos»: `purchases.money` + `costs.manage`. */
  canPushCosts: boolean;
}

export async function comprasPerms(orgId: string): Promise<ComprasPerms> {
  const [canManage, canMoney, canReceive, canCosts] = await Promise.all([
    hasOrgPermission(orgId, "purchases.manage"),
    hasOrgPermission(orgId, "purchases.money"),
    hasOrgPermission(orgId, "purchases.receive"),
    hasOrgPermission(orgId, "costs.manage"),
  ]);
  return { canManage, canMoney, canReceive, canPushCosts: canMoney && canCosts };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** PostgREST puede devolver numeric como texto: se normaliza. */
export function normalizeItem(row: Record<string, unknown>, canMoney: boolean): ItemRow {
  const currency: Currency = row.unit_cost_currency === "PEN" ? "PEN" : "USD";
  const out = {
    ...(row as unknown as ItemRow),
    qty: num(row.qty),
    courtesy_qty: num(row.courtesy_qty),
    unit_cost_currency: currency,
    unit_weight_kg: numOrNull(row.unit_weight_kg),
    received_qty: numOrNull(row.received_qty),
    damaged_qty: numOrNull(row.damaged_qty),
  };
  if (canMoney) {
    // El costo en la columna de su moneda; la otra, nula (0343).
    out.unit_cost_usd = currency === "PEN" ? null : num(row.unit_cost_usd);
    out.unit_cost_pen = currency === "PEN" ? num(row.unit_cost_pen) : null;
    out.sale_price_pen = numOrNull(row.sale_price_pen);
  } else {
    delete out.unit_cost_usd;
    delete out.unit_cost_pen;
    delete out.sale_price_pen;
  }
  return out;
}

/** El costo por unidad de un producto en su moneda (solo con `purchases.money`). */
export function itemCostOf(it: Pick<ItemRow, "unit_cost_currency" | "unit_cost_usd" | "unit_cost_pen">): { amount: number; currency: Currency } {
  return it.unit_cost_currency === "PEN" ? { amount: it.unit_cost_pen ?? 0, currency: "PEN" } : { amount: it.unit_cost_usd ?? 0, currency: "USD" };
}

/** La moneda de una fila; sin ella (antes de la 0342), USD. */
function currencyOf(v: unknown): Currency {
  return v === "PEN" ? "PEN" : "USD";
}

/** El monto de una fila en su moneda: `amount_usd` o `amount_pen` (0342). */
function amountOf(row: Record<string, unknown>, currency: Currency): number {
  return num(currency === "PEN" ? row.amount_pen : row.amount_usd);
}

export function normalizeCost(row: Record<string, unknown>): CostRow {
  const currency = currencyOf(row.currency);
  const includesIgv = row.includes_igv === true;
  return {
    id: String(row.id),
    kind: String(row.kind),
    label: String(row.label),
    currency,
    amount: amountOf(row, currency),
    includes_igv: includesIgv,
    gross_amount: includesIgv ? numOrNull(row.gross_amount) : null,
    igv_treatment: igvTreatmentOf(row),
    allocation: String(row.allocation),
    item_id: (row.item_id as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

export function normalizePayment(row: Record<string, unknown>): PaymentRow {
  const currency = currencyOf(row.currency);
  return {
    id: String(row.id),
    currency,
    amount: amountOf(row, currency),
    paid_on: String(row.paid_on),
    method: String(row.method),
    note: (row.note as string | null) ?? null,
    document_id: (row.document_id as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

export function normalizeImport(row: Record<string, unknown>, canMoney: boolean): ImportRow {
  const out = { ...(row as unknown as ImportRow), kind: importKindOf(row.kind) };
  if (canMoney) out.fx_pen_per_usd = numOrNull(row.fx_pen_per_usd);
  else delete out.fx_pen_per_usd;
  return out;
}

/**
 * La importación y lo que la persona puede hacer en su organización. Null si
 * no existe o si no tiene allí ni `purchases.manage`, ni `purchases.money`, ni
 * `purchases.receive`.
 */
export async function loadImportAccess(
  importId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<{ userId: string; imp: ImportRow; perms: ComprasPerms } | null> {
  if (!isUuid(importId)) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  const { data } = await admin.from("imports").select(IMPORT_COLS).eq("id", importId).maybeSingle();
  if (!data) return null;
  const raw = data as unknown as Record<string, unknown>;
  const perms = await comprasPerms(String(raw.org_id));
  if (!canViewCompras(perms)) return null;
  // El tipo de cambio es dinero: se pide a la base solo con el permiso.
  if (perms.canMoney) {
    const { data: fx } = await admin.from("imports").select("fx_pen_per_usd").eq("id", importId).maybeSingle();
    raw.fx_pen_per_usd = (fx as { fx_pen_per_usd?: unknown } | null)?.fx_pen_per_usd ?? null;
  }
  return { userId: user.id, imp: normalizeImport(raw, perms.canMoney), perms };
}

export async function loadSuppliers(orgId: string, admin: SupabaseClient = createAdminSupabase()): Promise<SupplierRow[]> {
  const { data } = await admin
    .from("import_suppliers")
    .select(SUPPLIER_COLS)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  return (data ?? []) as unknown as SupplierRow[];
}

export interface ImportListRow {
  imp: ImportRow;
  supplierName: string | null;
  items: { name: string; qty: number; sku: string | null }[];
  units: number;
  docKinds: string[];
  lastMovementAt: string | null;
  /**
   * Solo con `purchases.money`. `total` y `paid` por moneda, sin convertir; los
   * de USD con el tipo de cambio de la importación (null si hay soles y no lo
   * tiene, MOM §45.3) y los de soles (null si hay USD y no lo tiene): una
   * compra local toda en soles se lee en soles sin tipo de cambio (§45.12).
   */
  money?: {
    total: Money2;
    paid: Money2;
    totalUsd: number | null;
    paidUsd: number | null;
    pendingUsd: number | null;
    totalPen: number | null;
    pendingPen: number | null;
  };
}

/** Tope de la lista: una organización de Kapta no se acerca. */
export const IMPORT_LIST_LIMIT = 500;

export async function loadImportList(
  orgId: string,
  canMoney: boolean,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<ImportListRow[]> {
  const { data: rows } = await admin
    .from("imports")
    .select(`${IMPORT_COLS}${canMoney ? IMPORT_MONEY_COLS : ""}`)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(IMPORT_LIST_LIMIT);
  const imports = ((rows ?? []) as unknown as Record<string, unknown>[]).map((r) => normalizeImport(r, canMoney));
  if (!imports.length) return [];
  const ids = imports.map((i) => i.id);
  const [items, docs, events, suppliers, costs, payments] = await Promise.all([
    admin.from("import_items").select(`import_id,name,qty,courtesy_qty,unit_cost_currency,sku,position${canMoney ? ITEM_MONEY_COLS : ""}`).in("import_id", ids),
    admin.from("import_documents").select("import_id,kind").in("import_id", ids),
    admin
      .from("import_events")
      .select("import_id,at")
      .in("import_id", ids)
      .in("kind", MOVEMENT_EVENT_KINDS as unknown as string[])
      .order("at", { ascending: false }),
    admin.from("import_suppliers").select("id,name").eq("org_id", orgId),
    canMoney ? admin.from("import_costs").select("import_id,currency,amount_usd,amount_pen").in("import_id", ids) : Promise.resolve({ data: [] }),
    canMoney ? admin.from("import_payments").select("import_id,currency,amount_usd,amount_pen").in("import_id", ids) : Promise.resolve({ data: [] }),
  ]);
  const supplierName = new Map(((suppliers.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const byImport = new Map<string, ImportListRow>();
  for (const imp of imports) {
    byImport.set(imp.id, {
      imp,
      supplierName: imp.supplier_id ? (supplierName.get(imp.supplier_id) ?? null) : null,
      items: [],
      units: 0,
      docKinds: [],
      lastMovementAt: null,
      ...(canMoney ? { money: { total: zeroMoney(), paid: zeroMoney(), totalUsd: 0, paidUsd: 0, pendingUsd: 0, totalPen: 0, pendingPen: 0 } } : {}),
    });
  }
  const sortedItems = ((items.data ?? []) as unknown as Record<string, unknown>[]).sort((a, b) => num(a.position) - num(b.position));
  for (const it of sortedItems) {
    const row = byImport.get(String(it.import_id));
    if (!row) continue;
    const qty = num(it.qty);
    row.items.push({ name: String(it.name), qty, sku: (it.sku as string | null) ?? null });
    row.units += qty;
    // El proveedor en la moneda del producto: USD o soles (compra local, 0343).
    if (row.money) {
      const pen = it.unit_cost_currency === "PEN";
      row.money.total = addMoney(row.money.total, moneyOf(qty * num(pen ? it.unit_cost_pen : it.unit_cost_usd), pen ? "PEN" : "USD"));
    }
  }
  for (const d of (docs.data ?? []) as { import_id: string; kind: string }[]) {
    const row = byImport.get(d.import_id);
    if (row && !row.docKinds.includes(d.kind)) row.docKinds.push(d.kind);
  }
  for (const e of (events.data ?? []) as { import_id: string; at: string }[]) {
    const row = byImport.get(e.import_id);
    if (row && (!row.lastMovementAt || e.at > row.lastMovementAt)) row.lastMovementAt = e.at;
  }
  for (const c of (costs.data ?? []) as Record<string, unknown>[]) {
    const m = byImport.get(String(c.import_id))?.money;
    const currency = currencyOf(c.currency);
    if (m) m.total = addMoney(m.total, moneyOf(amountOf(c, currency), currency));
  }
  for (const p of (payments.data ?? []) as Record<string, unknown>[]) {
    const m = byImport.get(String(p.import_id))?.money;
    const currency = currencyOf(p.currency);
    if (m) m.paid = addMoney(m.paid, moneyOf(amountOf(p, currency), currency));
  }
  for (const row of byImport.values()) {
    row.lastMovementAt ??= row.imp.created_at;
    if (row.money) {
      // La base es USD: los soles con el tipo de cambio de ESTA importación.
      const b = paymentBalance(row.money.total, row.money.paid, row.imp.fx_pen_per_usd);
      row.money.totalUsd = b.totalUsd;
      row.money.paidUsd = b.paidUsd;
      row.money.pendingUsd = b.pendingUsd;
      row.money.totalPen = b.totalPen;
      row.money.pendingPen = b.pendingPen;
    }
  }
  return [...byImport.values()];
}

export interface ImportDetail {
  imp: ImportRow;
  supplier: SupplierRow | null;
  items: ItemRow[];
  documents: DocumentRow[];
  /** Null sin `purchases.money`. */
  costs: CostRow[] | null;
  payments: PaymentRow[] | null;
  /** Las entregas (MOM §45.14), de la más vieja a la más reciente. */
  deliveries: DeliveryRow[];
  /**
   * Posibles duplicados (MOM §45.15, aviso que no bloquea): los códigos de
   * otras compras de la organización con el mismo código de proforma o la
   * misma orden de Alibaba.
   */
  traceDuplicates: { proforma: string[]; alibaba: string[] };
  events: EventRow[];
  suppliers: SupplierRow[];
  perms: ComprasPerms;
  reportedByName: string | null;
}

export async function loadImportDetail(importId: string): Promise<ImportDetail | null> {
  const admin = createAdminSupabase();
  const access = await loadImportAccess(importId, admin);
  if (!access) return null;
  const { imp, perms } = access;
  const money = perms.canMoney;
  // Solo «Recepción de compras» (MOM §45.11): ni la lista de proveedores (no
  // edita la cabecera) ni los datos de contacto del proveedor.
  const receiveOnly = isReceiveOnly(perms);
  const [items, docs, costs, payments, events, suppliers, deliveries, deliveryLines, traceDuplicates] = await Promise.all([
    admin
      .from("import_items")
      .select(`${ITEM_COLS}${money ? ITEM_MONEY_COLS : ""}`)
      .eq("import_id", imp.id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("import_documents")
      .select(DOCUMENT_COLS)
      .eq("import_id", imp.id)
      .order("created_at", { ascending: true }),
    money
      ? admin.from("import_costs").select(COST_COLS).eq("import_id", imp.id).order("created_at", { ascending: true })
      : Promise.resolve({ data: null }),
    money
      ? admin.from("import_payments").select(PAYMENT_COLS).eq("import_id", imp.id).order("paid_on", { ascending: true })
      : Promise.resolve({ data: null }),
    admin.from("import_events").select("id,kind,status,note,by_user,at").eq("import_id", imp.id).order("at", { ascending: false }).limit(300),
    receiveOnly
      ? imp.supplier_id
        ? admin.from("import_suppliers").select(SUPPLIER_COLS).eq("id", imp.supplier_id).eq("org_id", imp.org_id).then((r) => (r.data ?? []) as unknown as SupplierRow[])
        : Promise.resolve([] as SupplierRow[])
      : loadSuppliers(imp.org_id, admin),
    admin.from("import_deliveries").select(DELIVERY_COLS).eq("import_id", imp.id).order("delivered_on", { ascending: true }).order("created_at", { ascending: true }),
    admin.from("import_delivery_lines").select(DELIVERY_LINE_COLS).eq("import_id", imp.id),
    loadTraceDuplicates(admin, imp),
  ]);
  const eventRows = ((events.data ?? []) as Omit<EventRow, "by_name">[]).filter(
    (e) => money || !MONEY_EVENT_KINDS.includes(e.kind),
  );
  const deliveryRows = ((deliveries.data ?? []) as unknown as Record<string, unknown>[]).sort(
    (a, b) => String(a.delivered_on).localeCompare(String(b.delivered_on)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
  );
  const userIds = new Set<string>();
  for (const e of eventRows) if (e.by_user) userIds.add(e.by_user);
  for (const d of deliveryRows) if (d.by_user) userIds.add(String(d.by_user));
  if (imp.reported_by) userIds.add(imp.reported_by);
  const names = userIds.size ? await resolveAgentNames(userIds, admin).catch(() => ({}) as Record<string, string>) : {};
  const supplier = suppliers.find((s) => s.id === imp.supplier_id) ?? null;
  const documents = ((docs.data ?? []) as unknown as DocumentRow[])
    .filter((d) => canSeeDocKind(d.kind, perms))
    .map((d) => ({ ...d, size_bytes: num(d.size_bytes), delivery_id: d.delivery_id ?? null }));
  const lines = (deliveryLines.data ?? []) as unknown as Record<string, unknown>[];
  return {
    imp,
    supplier:
      supplier && receiveOnly
        ? { ...supplier, whatsapp: null, notes: null, contact_name: null, email: null, payment_terms: null }
        : supplier,
    items: ((items.data ?? []) as unknown as Record<string, unknown>[]).map((r) => normalizeItem(r, money)),
    documents,
    costs: costs.data ? (costs.data as unknown as Record<string, unknown>[]).map(normalizeCost) : null,
    payments: payments.data ? (payments.data as unknown as Record<string, unknown>[]).map(normalizePayment) : null,
    traceDuplicates,
    deliveries: deliveryRows.map((d) => ({
      id: String(d.id),
      delivered_on: String(d.delivered_on),
      note: (d.note as string | null) ?? null,
      by_user: (d.by_user as string | null) ?? null,
      by_name: d.by_user ? (names[String(d.by_user)] ?? null) : null,
      legacy: d.legacy === true,
      created_at: String(d.created_at ?? ""),
      updated_at: String(d.updated_at ?? d.created_at ?? ""),
      lines: lines
        .filter((l) => String(l.delivery_id) === String(d.id))
        .map((l) => ({ id: String(l.id), item_id: String(l.item_id), received: num(l.received), damaged: num(l.damaged), note: (l.note as string | null) ?? null })),
      photos: documents.filter((doc) => doc.delivery_id === String(d.id)),
    })),
    events: eventRows.map((e) => ({ ...e, by_name: e.by_user ? (names[e.by_user] ?? null) : null })),
    suppliers: receiveOnly ? [] : suppliers,
    perms,
    reportedByName: imp.reported_by ? (names[imp.reported_by] ?? null) : null,
  };
}

/**
 * Otras compras de la organización con el mismo código de proforma o la misma
 * orden de Alibaba (sin mayúsculas ni espacios al borde). Solo códigos, sin
 * montos; un aviso de posible duplicado, nunca un bloqueo (MOM §45.15).
 */
async function loadTraceDuplicates(admin: SupabaseClient, imp: ImportRow): Promise<{ proforma: string[]; alibaba: string[] }> {
  const out = { proforma: [] as string[], alibaba: [] as string[] };
  if (imp.kind === "local") return out;
  const checks: [keyof typeof out, "proforma_number" | "platform_order", string | null | undefined][] = [
    ["proforma", "proforma_number", imp.proforma_number],
    ["alibaba", "platform_order", imp.platform_order],
  ];
  await Promise.all(
    checks.map(async ([key, column, value]) => {
      const v = traceCodeKey(value);
      if (!v) return;
      const { data } = await admin
        .from("imports")
        .select(`id,code,${column}`)
        .eq("org_id", imp.org_id)
        .neq("id", imp.id)
        // Contiene (sin mayúsculas); la igualdad exacta, sin espacios al borde, se mira abajo.
        .ilike(column, `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
        .limit(10);
      out[key] = ((data ?? []) as unknown as Record<string, unknown>[])
        .filter((r) => traceCodeKey(r[column] as string | null) === v)
        .map((r) => String(r.code));
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Proveedores y reportes (MOM §45.7 y §45.8)
// ---------------------------------------------------------------------------

/**
 * La organización de Compras que se mira: la pedida (`?org=`) si la persona
 * tiene allí el permiso, si no la primera. `need`: «view» = cualquiera de los
 * tres, también «Recepción de compras» (la lista de importaciones, MOM
 * §45.11); «any» = «Compras» o «Montos de compras» (Proveedores); «money» =
 * «Montos de compras» (Reportes).
 */
export async function resolveComprasOrg(
  requested: string | null | undefined,
  need: "view" | "any" | "money" = "any",
): Promise<{ orgId: string | null; allowed: string[] }> {
  const [manageOrgs, moneyOrgs, receiveOrgs] = await Promise.all([
    need === "money" ? Promise.resolve([]) : orgsWithPermission("purchases.manage"),
    orgsWithPermission("purchases.money"),
    need === "view" ? orgsWithPermission("purchases.receive") : Promise.resolve([]),
  ]);
  const allowed = [...new Set([...manageOrgs, ...moneyOrgs, ...receiveOrgs].map((m) => m.org_id))];
  const orgId = requested && allowed.includes(requested) ? requested : (allowed[0] ?? null);
  return { orgId, allowed };
}

/** Filas por página al leer todo (el tope por defecto de PostgREST es 1000). */
const PAGE = 1000;
/** Tope de páginas: 50.000 filas, lejos de lo que tiene una organización de Kapta. */
const MAX_PAGES = 50;

type PageQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };

/** Lee todas las filas de una consulta, de a 1000. */
async function readAll(build: () => PageQuery): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build().range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Todas las importaciones de la organización con sus productos, para las
 * estadísticas de Proveedores y los Reportes. Sin `purchases.money` NO se piden
 * el costo por unidad, el tipo de cambio, los costos ni los pagos: salen en 0 o
 * vacíos y solo sirven los números sin dinero (unidades, días, a tiempo,
 * faltantes).
 */
export async function loadReportImports(
  orgId: string,
  canMoney: boolean,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<ReportImport[]> {
  const [imports, items, costs, payments] = await Promise.all([
    readAll(() =>
      admin
        .from("imports")
        .select(`${IMPORT_COLS}${canMoney ? IMPORT_MONEY_COLS : ""}`)
        .eq("org_id", orgId)
        .order("id", { ascending: true }) as unknown as PageQuery,
    ),
    readAll(() =>
      admin
        .from("import_items")
        .select(`${ITEM_COLS}${canMoney ? ITEM_MONEY_COLS : ""}`)
        .eq("org_id", orgId)
        .order("id", { ascending: true }) as unknown as PageQuery,
    ),
    canMoney
      ? readAll(() =>
          admin
            .from("import_costs")
            .select("id,import_id,kind,label,currency,amount_usd,amount_pen,allocation,item_id")
            .eq("org_id", orgId)
            .order("id", { ascending: true }) as unknown as PageQuery,
        )
      : Promise.resolve([]),
    canMoney
      ? readAll(() =>
          admin
            .from("import_payments")
            .select("id,import_id,currency,amount_usd,amount_pen,paid_on")
            .eq("org_id", orgId)
            .order("id", { ascending: true }) as unknown as PageQuery,
        )
      : Promise.resolve([]),
  ]);
  const byId = new Map<string, ReportImport>();
  for (const raw of imports) {
    const imp = normalizeImport(raw, canMoney);
    byId.set(imp.id, {
      id: imp.id,
      code: imp.code,
      kind: imp.kind,
      supplierId: imp.supplier_id,
      status: imp.status,
      orderedOn: imp.ordered_on,
      createdAt: imp.created_at,
      eta: imp.eta,
      arrivedOn: imp.arrived_on,
      fxPenPerUsd: canMoney ? (imp.fx_pen_per_usd ?? null) : null,
      items: [],
      costs: [],
      payments: [],
    });
  }
  const sortedItems = items
    .map((r) => normalizeItem(r, canMoney))
    .sort((a, b) => num(a.position) - num(b.position) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  for (const it of sortedItems) {
    byId.get(it.import_id)?.items.push({
      id: it.id,
      name: it.name,
      sku: it.sku,
      storeId: it.store_id,
      qty: it.qty,
      courtesyQty: it.courtesy_qty,
      unitCostUsd: canMoney ? (it.unit_cost_usd ?? 0) : 0,
      unitCostPen: canMoney ? (it.unit_cost_pen ?? null) : null,
      unitCostCurrency: it.unit_cost_currency,
      unitWeightKg: it.unit_weight_kg,
      receivedQty: it.received_qty,
      damagedQty: it.damaged_qty,
    });
  }
  for (const c of costs) {
    const currency = currencyOf(c.currency);
    byId.get(String(c.import_id))?.costs.push({
      id: String(c.id),
      kind: c.kind as CostKind,
      label: String(c.label),
      amount: amountOf(c, currency),
      currency,
      allocation: c.allocation as Allocation,
      itemId: (c.item_id as string | null) ?? null,
    });
  }
  for (const p of payments) {
    const currency = currencyOf(p.currency);
    byId.get(String(p.import_id))?.payments.push({ amount: amountOf(p, currency), currency, paidOn: String(p.paid_on) });
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// «Leer con IA» (MOM §45.10)
// ---------------------------------------------------------------------------

/** Tope de filas de Costos que se leen para sugerir SKU. */
const CATALOG_COST_ROWS = 5000;

/**
 * Los SKU que la organización ya conoce, para sugerir la coincidencia de una
 * línea leída con IA: los de Costos de productos (con su tienda) y los vistos
 * en los pedidos de sus tiendas (`org_shopify_products`, 0094). Solo SKU,
 * nombre, tienda y en cuántos pedidos salió: ningún costo. También alimenta el
 * selector de «Agregar producto» (MOM §45.1).
 */
export async function loadSkuCatalog(orgId: string, admin: SupabaseClient = createAdminSupabase()): Promise<CatalogEntry[]> {
  const [costs, shop] = await Promise.all([
    admin.from("product_costs").select("sku,product_name,store_id").eq("org_id", orgId).limit(CATALOG_COST_ROWS),
    admin.rpc("org_shopify_products", { p_org_id: orgId }),
  ]);
  const out: CatalogEntry[] = [];
  for (const r of ((costs.data ?? []) as { sku: string | null; product_name: string | null; store_id: string | null }[])) {
    if (r.sku) out.push({ sku: r.sku, name: r.product_name, storeId: r.store_id ?? null });
  }
  if (!shop.error) {
    for (const r of ((shop.data ?? []) as { sku: string | null; product_name: string | null; order_count?: number | string | null }[])) {
      if (r.sku) out.push({ sku: r.sku, name: r.product_name, storeId: null, orderCount: r.order_count == null ? null : Number(r.order_count) });
    }
  }
  return out;
}

/**
 * La clave de IA para Compras, que es de la organización y no de una tienda:
 * la del entorno; si no hay, la primera tienda de la organización con clave
 * propia (0052). Modelo y base, los de lib/vision.ts.
 */
export async function comprasVisionCreds(
  orgId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<{ apiKey: string; model: string; apiBase: string }> {
  const envCreds = resolveVisionCreds();
  if (envCreds.apiKey) return envCreds;
  const { data } = await admin
    .from("stores")
    .select("id")
    .eq("org_id", orgId)
    .not("anthropic_api_key_enc", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  const storeId = ((data ?? []) as { id: string }[])[0]?.id;
  if (!storeId) return envCreds;
  return resolveVisionCreds(await storeVisionCreds(admin, storeId));
}
