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
import {
  MONEY_EVENT_KINDS,
  MOVEMENT_EVENT_KINDS,
  isMoneyDoc,
  isUuid,
  type Allocation,
  type CostKind,
  type ImportEventKind,
  type ImportStatus,
} from "@/lib/compras";
import type { ReportImport } from "@/lib/compras-reportes";

export const IMPORT_COLS: string =
  "id,org_id,code,supplier_id,origin,platform_order,transport,carrier,tracking_number,tracking_url,ordered_on,eta,arrived_on,status,reported_to_warehouse_at,reported_by,notes,created_by,created_at,updated_at";
/** Solo con `purchases.money`. */
export const IMPORT_MONEY_COLS: string = ",fx_pen_per_usd";
export const ITEM_COLS: string =
  "id,import_id,store_id,sku,name,image_path,qty,unit_weight_kg,received_qty,damaged_qty,reception_note,received_at,cost_pushed_at,position,created_at";
/** Solo con `purchases.money`. */
export const ITEM_MONEY_COLS: string = ",unit_cost_usd,sale_price_pen";

export interface ImportRow {
  id: string;
  org_id: string;
  code: string;
  supplier_id: string | null;
  origin: string | null;
  platform_order: string | null;
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
  unit_weight_kg: number | null;
  received_qty: number | null;
  damaged_qty: number | null;
  reception_note: string | null;
  received_at: string | null;
  cost_pushed_at: string | null;
  position: number;
  created_at: string;
  /** Solo con `purchases.money`. */
  unit_cost_usd?: number;
  sale_price_pen?: number | null;
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
}

export interface CostRow {
  id: string;
  kind: string;
  label: string;
  amount_usd: number;
  allocation: string;
  item_id: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  amount_usd: number;
  paid_on: string;
  method: string;
  note: string | null;
  document_id: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  kind: ImportEventKind;
  status: ImportStatus | null;
  note: string | null;
  by_user: string | null;
  by_name: string | null;
  at: string;
}

export interface ComprasPerms {
  canManage: boolean;
  canMoney: boolean;
  /** «Pasar a Costos»: `purchases.money` + `costs.manage`. */
  canPushCosts: boolean;
}

export async function comprasPerms(orgId: string): Promise<ComprasPerms> {
  const [canManage, canMoney, canCosts] = await Promise.all([
    hasOrgPermission(orgId, "purchases.manage"),
    hasOrgPermission(orgId, "purchases.money"),
    hasOrgPermission(orgId, "costs.manage"),
  ]);
  return { canManage, canMoney, canPushCosts: canMoney && canCosts };
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
  const out = {
    ...(row as unknown as ItemRow),
    qty: num(row.qty),
    unit_weight_kg: numOrNull(row.unit_weight_kg),
    received_qty: numOrNull(row.received_qty),
    damaged_qty: numOrNull(row.damaged_qty),
  };
  if (canMoney) {
    out.unit_cost_usd = num(row.unit_cost_usd);
    out.sale_price_pen = numOrNull(row.sale_price_pen);
  } else {
    delete out.unit_cost_usd;
    delete out.sale_price_pen;
  }
  return out;
}

export function normalizeImport(row: Record<string, unknown>, canMoney: boolean): ImportRow {
  const out = { ...(row as unknown as ImportRow) };
  if (canMoney) out.fx_pen_per_usd = numOrNull(row.fx_pen_per_usd);
  else delete out.fx_pen_per_usd;
  return out;
}

/**
 * La importación y lo que la persona puede hacer en su organización. Null si
 * no existe o si no tiene ni `purchases.manage` ni `purchases.money` allí.
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
  if (!perms.canManage && !perms.canMoney) return null;
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
  /** Solo con `purchases.money`. */
  money?: { totalUsd: number; paidUsd: number };
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
    admin.from("import_items").select(`import_id,name,qty,sku,position${canMoney ? ITEM_MONEY_COLS : ""}`).in("import_id", ids),
    admin.from("import_documents").select("import_id,kind").in("import_id", ids),
    admin
      .from("import_events")
      .select("import_id,at")
      .in("import_id", ids)
      .in("kind", MOVEMENT_EVENT_KINDS as unknown as string[])
      .order("at", { ascending: false }),
    admin.from("import_suppliers").select("id,name").eq("org_id", orgId),
    canMoney ? admin.from("import_costs").select("import_id,amount_usd").in("import_id", ids) : Promise.resolve({ data: [] }),
    canMoney ? admin.from("import_payments").select("import_id,amount_usd").in("import_id", ids) : Promise.resolve({ data: [] }),
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
      ...(canMoney ? { money: { totalUsd: 0, paidUsd: 0 } } : {}),
    });
  }
  const sortedItems = ((items.data ?? []) as unknown as Record<string, unknown>[]).sort((a, b) => num(a.position) - num(b.position));
  for (const it of sortedItems) {
    const row = byImport.get(String(it.import_id));
    if (!row) continue;
    const qty = num(it.qty);
    row.items.push({ name: String(it.name), qty, sku: (it.sku as string | null) ?? null });
    row.units += qty;
    if (row.money) row.money.totalUsd += qty * num(it.unit_cost_usd);
  }
  for (const d of (docs.data ?? []) as { import_id: string; kind: string }[]) {
    const row = byImport.get(d.import_id);
    if (row && !row.docKinds.includes(d.kind)) row.docKinds.push(d.kind);
  }
  for (const e of (events.data ?? []) as { import_id: string; at: string }[]) {
    const row = byImport.get(e.import_id);
    if (row && (!row.lastMovementAt || e.at > row.lastMovementAt)) row.lastMovementAt = e.at;
  }
  for (const c of (costs.data ?? []) as { import_id: string; amount_usd: unknown }[]) {
    const m = byImport.get(c.import_id)?.money;
    if (m) m.totalUsd += num(c.amount_usd);
  }
  for (const p of (payments.data ?? []) as { import_id: string; amount_usd: unknown }[]) {
    const m = byImport.get(p.import_id)?.money;
    if (m) m.paidUsd += num(p.amount_usd);
  }
  for (const row of byImport.values()) row.lastMovementAt ??= row.imp.created_at;
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
  const [items, docs, costs, payments, events, suppliers] = await Promise.all([
    admin
      .from("import_items")
      .select(`${ITEM_COLS}${money ? ITEM_MONEY_COLS : ""}`)
      .eq("import_id", imp.id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("import_documents")
      .select("id,kind,filename,mime,size_bytes,created_at")
      .eq("import_id", imp.id)
      .order("created_at", { ascending: true }),
    money
      ? admin.from("import_costs").select("id,kind,label,amount_usd,allocation,item_id,created_at").eq("import_id", imp.id).order("created_at", { ascending: true })
      : Promise.resolve({ data: null }),
    money
      ? admin.from("import_payments").select("id,amount_usd,paid_on,method,note,document_id,created_at").eq("import_id", imp.id).order("paid_on", { ascending: true })
      : Promise.resolve({ data: null }),
    admin.from("import_events").select("id,kind,status,note,by_user,at").eq("import_id", imp.id).order("at", { ascending: false }).limit(300),
    loadSuppliers(imp.org_id, admin),
  ]);
  const eventRows = ((events.data ?? []) as Omit<EventRow, "by_name">[]).filter(
    (e) => money || !MONEY_EVENT_KINDS.includes(e.kind),
  );
  const userIds = new Set<string>();
  for (const e of eventRows) if (e.by_user) userIds.add(e.by_user);
  if (imp.reported_by) userIds.add(imp.reported_by);
  const names = userIds.size ? await resolveAgentNames(userIds, admin).catch(() => ({}) as Record<string, string>) : {};
  return {
    imp,
    supplier: suppliers.find((s) => s.id === imp.supplier_id) ?? null,
    items: ((items.data ?? []) as unknown as Record<string, unknown>[]).map((r) => normalizeItem(r, money)),
    documents: ((docs.data ?? []) as DocumentRow[])
      .filter((d) => money || !isMoneyDoc(d.kind))
      .map((d) => ({ ...d, size_bytes: num(d.size_bytes) })),
    costs: costs.data
      ? (costs.data as CostRow[]).map((c) => ({ ...c, amount_usd: num(c.amount_usd) }))
      : null,
    payments: payments.data
      ? (payments.data as PaymentRow[]).map((p) => ({ ...p, amount_usd: num(p.amount_usd) }))
      : null,
    events: eventRows.map((e) => ({ ...e, by_name: e.by_user ? (names[e.by_user] ?? null) : null })),
    suppliers,
    perms,
    reportedByName: imp.reported_by ? (names[imp.reported_by] ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Proveedores y reportes (MOM §45.7 y §45.8)
// ---------------------------------------------------------------------------

/**
 * La organización de Compras que se mira: la pedida (`?org=`) si la persona
 * tiene allí el permiso, si no la primera. `need`: «any» = «Compras» o «Montos
 * de compras» (ver la sección y Proveedores); «money» = «Montos de compras»
 * (Reportes).
 */
export async function resolveComprasOrg(
  requested: string | null | undefined,
  need: "any" | "money" = "any",
): Promise<{ orgId: string | null; allowed: string[] }> {
  const [manageOrgs, moneyOrgs] = await Promise.all([
    need === "money" ? Promise.resolve([]) : orgsWithPermission("purchases.manage"),
    orgsWithPermission("purchases.money"),
  ]);
  const allowed = [...new Set([...manageOrgs, ...moneyOrgs].map((m) => m.org_id))];
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
            .select("id,import_id,kind,label,amount_usd,allocation,item_id")
            .eq("org_id", orgId)
            .order("id", { ascending: true }) as unknown as PageQuery,
        )
      : Promise.resolve([]),
    canMoney
      ? readAll(() =>
          admin
            .from("import_payments")
            .select("id,import_id,amount_usd,paid_on")
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
      unitCostUsd: canMoney ? (it.unit_cost_usd ?? 0) : 0,
      unitWeightKg: it.unit_weight_kg,
      receivedQty: it.received_qty,
      damagedQty: it.damaged_qty,
    });
  }
  for (const c of costs) {
    byId.get(String(c.import_id))?.costs.push({
      id: String(c.id),
      kind: c.kind as CostKind,
      label: String(c.label),
      amountUsd: num(c.amount_usd),
      allocation: c.allocation as Allocation,
      itemId: (c.item_id as string | null) ?? null,
    });
  }
  for (const p of payments) {
    byId.get(String(p.import_id))?.payments.push({ amountUsd: num(p.amount_usd), paidOn: String(p.paid_on) });
  }
  return [...byId.values()];
}
