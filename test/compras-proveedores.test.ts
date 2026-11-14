// «Compras» fase 4 (MOM §45.7, §45.8 y §45.9): proveedores, reportes y el
// Excel de una importación.
//   - Proveedores: crear, editar (renombrar) y borrar con «Compras»; borrar
//     solo sin importaciones; contacto, correo y condiciones de pago (0341).
//   - Las lecturas de las estadísticas no piden dinero sin «Montos de compras».
//   - El Excel: sin «Montos de compras», ni hojas ni columnas de dinero.
//   - Las páginas y la ruta vuelven a pedir el permiso; Reportes solo con
//     «Montos de compras»; la sub-navegación muestra solo lo que se puede abrir.
//   - La 0341, el MOM y DEPLOY.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "44444444-4444-4444-8444-444444444444", email: "frankz@kapta.pe" }) }));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (_org: string, perm: string) => h.perms.has(perm),
  orgsWithPermission: async (perm: string) => (h.perms.has(perm) ? [{ org_id: ORG, role: "admin" }] : []),
}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: (t: string) => h.db.from(t),
    rpc: (n: string, a: unknown) => h.db.rpc(n, a),
  }),
}));

import { FakeDb } from "./woocommerce-fake-db";
import { createSupplier, deleteSupplier, updateSupplier } from "@/app/dashboard/compras/actions";
import { loadImportDetail, loadReportImports, resolveComprasOrg } from "@/lib/compras-server";
import { buildImportWorkbook, importExcelFilename } from "@/lib/exports/compras-importacion";
import { visibleComprasSections } from "@/components/compras/subnav";

const ORG = "11111111-1111-4111-8111-111111111111";
const IMP = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "33333333-3333-4333-8333-33333333333a";
const ITEM_B = "33333333-3333-4333-8333-33333333333b";
const STORE = "55555555-5555-4555-8555-555555555555";
const SUPPLIER = "66666666-6666-4666-8666-666666666666";
const UNUSED = "77777777-7777-4777-8777-777777777777";

function seed() {
  h.db = new FakeDb({
    import_suppliers: [
      { id: SUPPLIER, org_id: ORG, name: "Yiwu Trading", country: "China", whatsapp: null, notes: null },
      { id: UNUSED, org_id: ORG, name: "Shenzhen Parts", country: "China", whatsapp: null, notes: null },
    ],
    imports: [
      {
        id: IMP,
        org_id: ORG,
        code: "IMP-2026-001",
        supplier_id: SUPPLIER,
        status: "cancelado",
        ordered_on: "2026-11-01",
        fx_pen_per_usd: 3.75,
        transport: "air",
        created_at: "2026-11-01T15:00:00Z",
      },
    ],
    // El ejemplo de la referencia: A = 3,40 y B = 14,30 por unidad.
    import_items: [
      { id: ITEM_A, org_id: ORG, import_id: IMP, store_id: STORE, sku: "SKU-A", name: "A", qty: 100, unit_cost_usd: 2, unit_weight_kg: 0.5, sale_price_pen: 20, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 1 },
      { id: ITEM_B, org_id: ORG, import_id: IMP, store_id: null, sku: "SKU-B", name: "B", qty: 50, unit_cost_usd: 12, unit_weight_kg: 0.2, sale_price_pen: 60, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 2 },
    ],
    import_costs: [
      { id: "c1", org_id: ORG, import_id: IMP, kind: "importacion", label: "Aranceles", amount_usd: 80, allocation: "value", item_id: null },
      { id: "c2", org_id: ORG, import_id: IMP, kind: "envio", label: "Flete", amount_usd: 120, allocation: "weight", item_id: null },
      { id: "c3", org_id: ORG, import_id: IMP, kind: "adicional", label: "Inspección", amount_usd: 30, allocation: "units", item_id: null },
      { id: "c4", org_id: ORG, import_id: IMP, kind: "adicional", label: "Etiquetas B", amount_usd: 25, allocation: "item", item_id: ITEM_B },
    ],
    import_payments: [{ id: "p1", org_id: ORG, import_id: IMP, amount_usd: 500, paid_on: "2026-11-02", method: "transferencia", note: null, document_id: null }],
    import_documents: [],
    import_events: [],
  });
}

beforeEach(() => {
  h.perms = new Set(["purchases.manage", "purchases.money"]);
  seed();
});

const supplier = (id: string) => h.db.rows("import_suppliers").find((s) => s.id === id);

describe("proveedores: crear, editar y borrar (MOM §45.7)", () => {
  it("crea con contacto, correo y condiciones de pago (0341)", async () => {
    const res = await createSupplier(ORG, { name: "Ningbo Tools", country: "China", contactName: "Lily", email: "Lily@Ningbo.cn", paymentTerms: "30 % adelanto" });
    expect(res.error).toBeUndefined();
    expect(supplier(res.id!)).toMatchObject({ org_id: ORG, name: "Ningbo Tools", contact_name: "Lily", email: "lily@ningbo.cn", payment_terms: "30 % adelanto" });
  });

  it("edita y renombra: las importaciones siguen apuntando al mismo id", async () => {
    const res = await updateSupplier(SUPPLIER, { name: "Yiwu Trading Co.", country: "China", email: "ventas@yiwu.cn", paymentTerms: "100 % adelanto" });
    expect(res.error).toBeUndefined();
    expect(supplier(SUPPLIER)).toMatchObject({ name: "Yiwu Trading Co.", email: "ventas@yiwu.cn", payment_terms: "100 % adelanto" });
    expect(h.db.rows("imports")[0]!.supplier_id).toBe(SUPPLIER);
  });

  it("no deja dos con el mismo nombre (sin mayúsculas), pero sí guardar el propio", async () => {
    expect(await updateSupplier(SUPPLIER, { name: "shenzhen parts" })).toEqual({ error: "Ya existe un proveedor con ese nombre." });
    expect((await updateSupplier(SUPPLIER, { name: "YIWU TRADING" })).error).toBeUndefined();
  });

  it("borra solo si no tiene importaciones (también cuenta una cancelada)", async () => {
    const res = await deleteSupplier(SUPPLIER);
    expect(res.error).toMatch(/tiene importaciones: no se puede borrar/);
    expect(supplier(SUPPLIER)).toBeTruthy();
    expect((await deleteSupplier(UNUSED)).error).toBeUndefined();
    expect(supplier(UNUSED)).toBeUndefined();
  });

  it("con solo «Montos de compras» no se crea, ni se edita, ni se borra", async () => {
    h.perms = new Set(["purchases.money"]);
    expect((await createSupplier(ORG, { name: "Nuevo" })).error).toMatch(/no permite/);
    expect((await updateSupplier(SUPPLIER, { name: "Otro" })).error).toMatch(/no permite/);
    expect((await deleteSupplier(UNUSED)).error).toMatch(/no permite/);
    expect(supplier(SUPPLIER)!.name).toBe("Yiwu Trading");
    expect(supplier(UNUSED)).toBeTruthy();
  });

  it("un id que no es un proveedor no se toca", async () => {
    expect((await deleteSupplier("no-es-uuid")).error).toBe("No encontramos ese proveedor.");
    expect((await updateSupplier("88888888-8888-4888-8888-888888888888", { name: "X" })).error).toBe("No encontramos ese proveedor.");
  });
});

describe("las lecturas de estadísticas y reportes", () => {
  it("sin «Montos de compras» no piden a la base costos por unidad, tipo de cambio, costos ni pagos", async () => {
    const rows = await loadReportImports(ORG, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.items.map((it) => it.unitCostUsd)).toEqual([0, 0]);
    expect(rows[0]!.fxPenPerUsd).toBeNull();
    expect(rows[0]!.costs).toEqual([]);
    expect(rows[0]!.payments).toEqual([]);
    for (const op of h.db.opsOn("import_items")) expect(op.cols).not.toMatch(/unit_cost_usd|sale_price_pen/);
    for (const op of h.db.opsOn("imports")) expect(op.cols).not.toMatch(/fx_pen_per_usd/);
    expect(h.db.opsOn("import_costs")).toHaveLength(0);
    expect(h.db.opsOn("import_payments")).toHaveLength(0);
  });

  it("con el permiso traen todo, por organización", async () => {
    const [row] = await loadReportImports(ORG, true);
    expect(row!.fxPenPerUsd).toBe(3.75);
    expect(row!.items.map((it) => it.unitCostUsd)).toEqual([2, 12]);
    expect(row!.costs).toHaveLength(4);
    expect(row!.payments).toEqual([{ amountUsd: 500, paidOn: "2026-11-02" }]);
    for (const t of ["imports", "import_items", "import_costs", "import_payments"]) {
      for (const op of h.db.opsOn(t)) expect(op.filters, t).toContainEqual(["eq", "org_id", ORG]);
    }
  });

  it("Reportes solo mira organizaciones con «Montos de compras»", async () => {
    h.perms = new Set(["purchases.manage"]);
    expect((await resolveComprasOrg(null, "money")).orgId).toBeNull();
    expect((await resolveComprasOrg(null)).orgId).toBe(ORG);
    h.perms = new Set(["purchases.money"]);
    expect((await resolveComprasOrg(ORG, "money")).orgId).toBe(ORG);
  });
});

describe("la sub-navegación muestra solo lo que se puede abrir", () => {
  it("Reportes solo con «Montos de compras»", () => {
    expect(visibleComprasSections({ canManage: true, canMoney: false }).map((s) => s.id)).toEqual(["importaciones", "proveedores"]);
    expect(visibleComprasSections({ canManage: false, canMoney: true }).map((s) => s.id)).toEqual(["importaciones", "proveedores", "reportes"]);
    expect(visibleComprasSections({ canManage: false, canMoney: false })).toEqual([]);
  });
});

async function workbook(): Promise<ExcelJS.Workbook> {
  const detail = await loadImportDetail(IMP);
  expect(detail).not.toBeNull();
  const buf = await buildImportWorkbook(detail!, { storeNames: new Map([[STORE, "Aurela"]]), now: new Date("2026-11-14T15:00:00Z") });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

const headers = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1).map(String);
const allText = (wb: ExcelJS.Workbook) => {
  const out: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => out.push(String(c.value)))));
  return out.join("\n");
};

describe("el Excel de la importación (MOM §45.9)", () => {
  it("con «Montos de compras»: productos con el costo aterrizado y su desglose, margen, costos y pagos", async () => {
    const wb = await workbook();
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Importación", "Productos", "Costos", "Pagos"]);
    const products = wb.getWorksheet("Productos")!;
    const cols = headers(products);
    const col = (name: string) => cols.indexOf(name) + 1;
    expect(col("Costo aterrizado por unidad (USD)")).toBeGreaterThan(0);
    const a = products.getRow(2);
    const b = products.getRow(3);
    expect(a.getCell(col("Producto")).value).toBe("A");
    expect(a.getCell(col("Tienda")).value).toBe("Aurela");
    expect(b.getCell(col("Tienda")).value).toBe("General");
    expect(a.getCell(col("Costo aterrizado por unidad (USD)")).value).toBe(3.4);
    expect(b.getCell(col("Costo aterrizado por unidad (USD)")).value).toBe(14.3);
    expect(a.getCell(col("Costo aterrizado por unidad (S/)")).value).toBe(12.75);
    // 20 − 3,40 × 3,75 = 7,25 → 36,3 %.
    expect(a.getCell(col("Margen por unidad (S/)")).value).toBe(7.25);
    expect(a.getCell(col("Margen %")).value).toBe(0.363);
    const costs = wb.getWorksheet("Costos")!;
    expect(costs.rowCount).toBeGreaterThanOrEqual(6);
    const pays = wb.getWorksheet("Pagos")!;
    expect(pays.getRow(2).getCell(3).value).toBe(500);
    expect(allText(wb)).toContain("Costo total");
  });

  it("sin «Montos de compras»: ni hojas ni columnas de dinero", async () => {
    h.perms = new Set(["purchases.manage"]);
    const wb = await workbook();
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Importación", "Productos"]);
    const cols = headers(wb.getWorksheet("Productos")!);
    expect(cols).toContain("Cantidad");
    expect(cols).toContain("Buenas");
    for (const c of cols) expect(c, c).not.toMatch(/USD|S\/|Margen|Precio|Costo/);
    const text = allText(wb);
    expect(text).not.toMatch(/Tipo de cambio|Costo total|Pagado|Falta pagar|Ganancia/);
    expect(text).not.toContain("3.75");
    expect(text).not.toContain("500");
  });

  it("el nombre del archivo es el código", () => {
    expect(importExcelFilename("IMP-2026-001")).toBe("IMP-2026-001.xlsx");
    expect(importExcelFilename('IMP"; x')).not.toMatch(/["; ]/);
  });
});

// ---------------------------------------------------------------------------
// Lo que se comprueba leyendo el fuente
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("las páginas y la ruta vuelven a pedir el permiso", () => {
  it("Proveedores: «Compras» o «Montos de compras»; los montos solo con «Montos de compras»", () => {
    const src = read("app/dashboard/compras/proveedores/page.tsx");
    expect(src).toContain("resolveComprasOrg(sp.org)");
    expect(src).toContain("comprasPerms(orgId)");
    expect(src).toContain("if (!perms.canManage && !perms.canMoney)");
    expect(src).toContain("loadReportImports(orgId, perms.canMoney)");
    expect(src).toContain("supplierStats(supplier.id, imports, { money: perms.canMoney })");
    const view = read("components/compras/suppliers.tsx");
    expect(view).toContain("{canMoney && <th");
    expect(view).toContain("{canManage && form && (");
    expect(view).toContain("{canManage && (");
  });

  it("Reportes: solo con «Montos de compras»", () => {
    const src = read("app/dashboard/compras/reportes/page.tsx");
    expect(src).toContain('resolveComprasOrg(sp.org, "money")');
    expect(src).toContain("if (!perms.canMoney)");
    // El chequeo va antes de leer los datos.
    expect(src.indexOf("if (!perms.canMoney)")).toBeLessThan(src.indexOf("loadReportImports("));
  });

  it("la lista de importaciones filtra por `?proveedor=` de la misma organización", () => {
    const src = read("app/dashboard/compras/page.tsx");
    expect(src).toContain("isUuid(sp.proveedor) ? (suppliers.find((s) => s.id === sp.proveedor) ?? null) : null");
    expect(src).toContain('<ComprasSubnav current="importaciones"');
  });

  it("la ruta del Excel pide sesión y pasa por loadImportDetail (permiso y dinero)", () => {
    const src = read("app/api/compras/excel/[id]/route.ts");
    expect(src).toContain("await getCurrentUser()");
    expect(src).toContain("await loadImportDetail(id)");
    expect(src).toContain('"cache-control": "private, no-store"');
    expect(src).toContain("status: 404");
    const builder = read("lib/exports/compras-importacion.ts");
    expect(builder).toContain("detail.perms.canMoney && detail.costs !== null && detail.payments !== null");
    expect(builder).toContain("landedCosts(");
    expect(read("components/compras/import-detail.tsx")).toContain("/api/compras/excel/${imp.id}");
  });

  it("los reportes reutilizan landedCosts, no una copia", () => {
    const src = read("lib/compras-reportes.ts");
    expect(src).toContain("landedCosts(");
    expect(src).not.toMatch(/qty \* it\.unitCostUsd/);
  });

  it("las acciones de proveedores piden «Compras» en la organización del proveedor", () => {
    const src = read("app/dashboard/compras/actions.ts");
    expect(src).toContain('hasOrgPermission(supplier.org_id, "purchases.manage")');
    expect(src).toMatch(/export async function deleteSupplier[\s\S]*\.eq\("supplier_id", a\.supplier\.id\)[\s\S]*\.delete\(\)/);
  });
});

describe("la migración 0341", () => {
  const sql = read("db/migrations/0341_compras_proveedores.sql");
  it("agrega tres columnas opcionales con CHECK, sin drop, idempotente", () => {
    for (const c of ["contact_name", "email", "payment_terms"]) expect(sql).toContain(`add column if not exists ${c} text`);
    expect(sql).toContain("check (contact_name is null or char_length(btrim(contact_name)) between 1 and 120)");
    expect(sql).toContain("check (payment_terms is null or char_length(btrim(payment_terms)) between 1 and 200)");
    expect(sql).toMatch(/check \(email is null or \(char_length\(email\) <= 160 and email ~ /);
    expect(sql).not.toMatch(/^\s*drop\s/im);
    expect(sql).not.toMatch(/create policy/);
  });
  it("sigue siendo solo del servidor, como la 0340", () => {
    expect(sql).toContain("revoke all on public.import_suppliers from anon, authenticated;");
    expect(sql).toContain("grant all privileges on public.import_suppliers to service_role;");
  });
});

describe("el MOM y DEPLOY.md", () => {
  it("el MOM tiene proveedores, reportes y el Excel", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const section = mom.slice(mom.indexOf("## 45. Compras: importaciones"));
    for (const s of ["### 45.7 Proveedores", "### 45.8 Reportes", "### 45.9 El Excel de la importación", "0341", "70 %", "3 %", "2 %", "no tiene ninguna importación"]) {
      expect(section, s).toContain(s);
    }
  });

  it("DEPLOY.md: arriba de todo, la 0341 antes que el código", () => {
    const deploy = read("DEPLOY.md");
    const first = deploy.indexOf("### ");
    const entry = deploy.slice(first, deploy.indexOf("\n### ", first + 4));
    expect(entry).toContain("0341_compras_proveedores");
    expect(entry).toMatch(/antes/i);
  });
});
