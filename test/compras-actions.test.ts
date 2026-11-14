// «Compras» (MOM §45): las acciones del servidor y lo que las rodea.
//   - Sin `purchases.money` el servidor NI LEE NI ESCRIBE el dinero: costo por
//     unidad, precio de venta, tipo de cambio, costos, pagos, documentos con
//     montos y eventos de dinero.
//   - El código IMP-<año de Lima>-NNN, con reintento si choca.
//   - La recepción pasa a Recibido y anota la llegada de hoy en Lima.
//   - Quitar un producto no hace desaparecer su costo «a un producto».
//   - «Pasar a Costos»: con `costs.manage`, en soles a 2 decimales, con la
//     vigencia de Costos, y dos veces no duplica.
//   - La 0340, la ruta del documento, el menú, el MOM y DEPLOY.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  files: new Map<string, { size: number; contentType: string }>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "44444444-4444-4444-8444-444444444444", email: "frankz@kapta.pe" }) }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async (_org: string, perm: string) => h.perms.has(perm) }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: (t: string) => h.db.from(t),
    rpc: (n: string, a: unknown) => h.db.rpc(n, a),
    storage: {
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({
        info: async (path: string) => {
          const f = h.files.get(path);
          return f ? { data: f, error: null } : { data: null, error: { message: "not found" } };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) h.files.delete(p);
          return { data: null, error: null };
        },
        createSignedUploadUrl: async (path: string) => ({ data: { path, token: "tok" }, error: null }),
      }),
    },
  }),
}));

import { FakeDb } from "./woocommerce-fake-db";
import {
  addImportCost,
  addImportPayment,
  createImport,
  pushImportCosts,
  registerImportDocument,
  removeImportItem,
  saveReception,
  setImportFx,
  startImportUpload,
  updateImportItem,
} from "@/app/dashboard/compras/actions";
import { loadImportDetail } from "@/lib/compras-server";
import { limaToday, limaYear } from "@/lib/compras";

const ORG = "11111111-1111-4111-8111-111111111111";
const IMP = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "33333333-3333-4333-8333-33333333333a";
const ITEM_B = "33333333-3333-4333-8333-33333333333b";
const STORE = "55555555-5555-4555-8555-555555555555";
const SUPPLIER = "66666666-6666-4666-8666-666666666666";

const ALL = ["purchases.manage", "purchases.money", "costs.manage"];

function seed(overrides: { status?: string; arrived_on?: string | null; fx?: number | null } = {}) {
  h.db = new FakeDb({
    stores: [{ id: STORE, org_id: ORG }],
    import_suppliers: [{ id: SUPPLIER, org_id: ORG, name: "Yiwu Trading", country: "China", whatsapp: null, notes: null }],
    imports: [
      {
        id: IMP,
        org_id: ORG,
        code: "IMP-2026-001",
        supplier_id: SUPPLIER,
        status: overrides.status ?? "en_transito",
        arrived_on: overrides.arrived_on ?? null,
        fx_pen_per_usd: overrides.fx === undefined ? 3.7517 : overrides.fx,
        transport: "courier",
        created_at: "2026-11-01T15:00:00Z",
      },
    ],
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
    import_payments: [],
    import_documents: [
      { id: "d1", org_id: ORG, import_id: IMP, kind: "invoice", storage_path: "x/inv.pdf", filename: "inv.pdf", mime: "application/pdf", size_bytes: 10, created_at: "2026-11-02T10:00:00Z" },
      { id: "d2", org_id: ORG, import_id: IMP, kind: "proforma", storage_path: "x/pro.pdf", filename: "pro.pdf", mime: "application/pdf", size_bytes: 10, created_at: "2026-11-02T10:00:00Z" },
    ],
    import_events: [
      { id: "e1", org_id: ORG, import_id: IMP, kind: "status", status: "en_transito", note: null, by_user: null, at: "2026-11-05T10:00:00Z" },
      { id: "e2", org_id: ORG, import_id: IMP, kind: "dinero", status: null, note: "Pago registrado: US$ 500.00", by_user: null, at: "2026-11-06T10:00:00Z" },
    ],
    product_costs: [],
  });
}

beforeEach(() => {
  h.perms = new Set(ALL);
  h.files = new Map();
  seed();
});

const events = (kind?: string) => h.db.rows("import_events").filter((e) => !kind || e.kind === kind);

describe("sin «Montos de compras» el dinero no se lee ni se escribe", () => {
  it("editar un producto no toca el costo por unidad ni el precio de venta", async () => {
    h.perms = new Set(["purchases.manage"]);
    const res = await updateImportItem(ITEM_A, { name: "A2", sku: "SKU-A", storeId: STORE, qty: "120", unitCostUsd: "99", salePricePen: "1" });
    expect(res.error).toBeUndefined();
    const update = h.db.opsOn("import_items", "update").at(-1)!;
    expect(update.payload).not.toHaveProperty("unit_cost_usd");
    expect(update.payload).not.toHaveProperty("sale_price_pen");
    const row = h.db.rows("import_items").find((r) => r.id === ITEM_A)!;
    expect(row).toMatchObject({ name: "A2", qty: 120, unit_cost_usd: 2, sale_price_pen: 20 });
  });

  it("con el permiso sí los guarda", async () => {
    await updateImportItem(ITEM_A, { name: "A", qty: "100", unitCostUsd: "2.5", salePricePen: "21" });
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_A)).toMatchObject({ unit_cost_usd: 2.5, sale_price_pen: 21 });
  });

  it("costos, pagos, tipo de cambio y documentos con montos piden el permiso", async () => {
    h.perms = new Set(["purchases.manage"]);
    expect((await addImportCost(IMP, { kind: "envio", amountUsd: "10", allocation: "units" })).error).toMatch(/Montos de compras/);
    expect((await addImportPayment(IMP, { amountUsd: "10", paidOn: "2026-11-01", method: "paypal" })).error).toMatch(/Montos de compras/);
    expect((await setImportFx(IMP, "3.8")).error).toMatch(/Montos de compras/);
    expect(await startImportUpload(IMP, { kind: "proforma", contentType: "application/pdf", filename: "p.pdf", size: 10 })).toHaveProperty("error");
    expect(await startImportUpload(IMP, { kind: "invoice", contentType: "application/pdf", filename: "f.pdf", size: 10 })).toHaveProperty("path");
    expect(h.db.opsOn("import_costs", "insert")).toEqual([]);
    expect(h.db.opsOn("import_payments", "insert")).toEqual([]);
  });

  it("el detalle no pide a la base las columnas ni las tablas de dinero", async () => {
    h.perms = new Set(["purchases.manage"]);
    const detail = (await loadImportDetail(IMP))!;
    expect(detail.costs).toBeNull();
    expect(detail.payments).toBeNull();
    expect(detail.imp).not.toHaveProperty("fx_pen_per_usd");
    for (const it of detail.items) {
      expect(it).not.toHaveProperty("unit_cost_usd");
      expect(it).not.toHaveProperty("sale_price_pen");
    }
    expect(detail.documents.map((d) => d.kind)).toEqual(["invoice"]);
    expect(detail.events.map((e) => e.kind)).toEqual(["status"]);
    expect(h.db.opsOn("import_costs", "select")).toEqual([]);
    expect(h.db.opsOn("import_payments", "select")).toEqual([]);
    for (const op of [...h.db.opsOn("import_items", "select"), ...h.db.opsOn("imports", "select")]) {
      expect(op.cols ?? "").not.toMatch(/unit_cost_usd|sale_price_pen|fx_pen_per_usd/);
    }
  });

  it("con el permiso, el detalle trae todo", async () => {
    const detail = (await loadImportDetail(IMP))!;
    expect(detail.costs).toHaveLength(4);
    expect(detail.imp.fx_pen_per_usd).toBe(3.7517);
    expect(detail.items[0]).toHaveProperty("unit_cost_usd", 2);
    expect(detail.documents.map((d) => d.kind).sort()).toEqual(["invoice", "proforma"]);
  });

  it("sin ningún permiso de Compras, nada", async () => {
    h.perms = new Set(["costs.manage"]);
    expect(await loadImportDetail(IMP)).toBeNull();
    expect((await updateImportItem(ITEM_A, { name: "x", qty: "1" })).error).toBe("Sin acceso a esta importación.");
  });
});

describe("crear la importación", () => {
  it("IMP-<año de Lima>-NNN en Cotización, con su hecho en el historial", async () => {
    const year = limaYear();
    h.db.rows("imports").push({ id: "77777777-7777-4777-8777-777777777777", org_id: ORG, code: `IMP-${year}-004` });
    const res = await createImport(ORG, { supplierId: SUPPLIER, transport: "air", eta: "2026-12-01" });
    expect(res.error).toBeUndefined();
    const created = h.db.rows("imports").find((r) => r.id === res.id)!;
    expect(created).toMatchObject({ code: `IMP-${year}-005`, status: "cotizacion", transport: "air", ordered_on: limaToday(), org_id: ORG });
    expect(events("status").at(-1)).toMatchObject({ import_id: res.id, status: "cotizacion" });
  });

  it("si el código choca, se reintenta", async () => {
    let fails = 1;
    h.db.failOn = (table, op) => (table === "imports" && op === "insert" && fails-- > 0 ? { code: "23505", message: "duplicate" } : null);
    const res = await createImport(ORG, {});
    expect(res.error).toBeUndefined();
    expect(h.db.opsOn("imports", "insert")).toHaveLength(2);
  });

  it("sin «Compras» no se crea; un proveedor de otra organización tampoco", async () => {
    h.perms = new Set(["purchases.money"]);
    expect((await createImport(ORG, {})).error).toMatch(/no permite/);
    h.perms = new Set(ALL);
    expect((await createImport(ORG, { supplierId: "88888888-8888-4888-8888-888888888888" })).error).toMatch(/no es de esta organización/);
  });
});

describe("recepción", () => {
  it("guarda lo contado, pasa a Recibido y anota la llegada de hoy en Lima", async () => {
    const res = await saveReception(IMP, [
      { itemId: ITEM_A, received: "98", damaged: "2" },
      { itemId: ITEM_B, received: "50" },
    ]);
    expect(res.notice).toMatch(/Recibido/);
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_A)).toMatchObject({ received_qty: 98, damaged_qty: 2 });
    expect(h.db.rows("imports")[0]).toMatchObject({ status: "recibido", arrived_on: limaToday() });
    expect(events("recepcion").at(-1)!.note).toBe("Recepción: 148 de 150 u. · faltan 2 · 2 dañadas");
    expect(events("status").at(-1)).toMatchObject({ status: "recibido" });
  });

  it("ya recibida: no cambia el estado ni pisa la llegada escrita", async () => {
    seed({ status: "ingresado", arrived_on: "2026-11-10" });
    await saveReception(IMP, [{ itemId: ITEM_A, received: "100" }]);
    expect(h.db.rows("imports")[0]).toMatchObject({ status: "ingresado", arrived_on: "2026-11-10" });
  });
});

describe("quitar un producto no borra su costo «a un producto» (§13.4)", () => {
  it("el costo se queda sin producto y queda el hecho de dinero", async () => {
    const res = await removeImportItem(ITEM_B);
    expect(res.notice).toMatch(/por valor/);
    expect(h.db.rows("import_items").map((r) => r.id)).toEqual([ITEM_A]);
    expect(h.db.rows("import_costs").find((c) => c.id === "c4")).toMatchObject({ item_id: null, amount_usd: 25 });
    expect(events("dinero").at(-1)!.note).toBe("«Etiquetas B» estaba asignado a «B»: ahora se reparte por valor.");
  });
});

describe("documentos", () => {
  it("se registra con el tipo y tamaño de Storage, no del navegador", async () => {
    const up = await startImportUpload(IMP, { kind: "invoice", contentType: "application/pdf", filename: "f.pdf", size: 10 });
    expect(up).toHaveProperty("path");
    const path = (up as { path: string }).path;
    expect(path.startsWith(`${ORG}/${IMP}/docs/`)).toBe(true);
    h.files.set(path, { size: 2048, contentType: "application/pdf" });
    const res = await registerImportDocument(IMP, { kind: "invoice", path, filename: "factura.pdf" });
    expect(res.error).toBeUndefined();
    expect(h.db.rows("import_documents").at(-1)).toMatchObject({ kind: "invoice", size_bytes: 2048, mime: "application/pdf", storage_path: path });
    expect(events("documento").at(-1)!.note).toBe("Documento subido: Factura comercial (factura.pdf).");
  });

  it("un archivo que no es lo que dijo se borra; una ruta de otra importación no se acepta", async () => {
    const path = `${ORG}/${IMP}/docs/99999999-9999-4999-8999-999999999999.pdf`;
    h.files.set(path, { size: 10, contentType: "text/html" });
    expect((await registerImportDocument(IMP, { kind: "invoice", path, filename: "x.pdf" })).error).toMatch(/PDF, JPG/);
    expect(h.files.has(path)).toBe(false);
    expect((await registerImportDocument(IMP, { kind: "invoice", path: `otra/${path}`, filename: "x" })).error).toMatch(/no es de esta importación/);
  });
});

describe("«Pasar a Costos»", () => {
  beforeEach(() => {
    seed({ status: "recibido", arrived_on: "2026-11-12" });
    for (const r of h.db.rows("import_items")) {
      r.received_qty = r.qty;
      r.damaged_qty = 0;
    }
  });

  it("lleva el costo aterrizado en soles a Costos de productos y marca cada línea", async () => {
    h.db.rows("product_costs").push({ id: "old", org_id: ORG, store_id: STORE, sku: "SKU-A", unit_cost: 11, effective_from: "2026-01-01", effective_to: null });
    const res = await pushImportCosts(IMP);
    expect(res.error).toBeUndefined();
    const rows = h.db.rows("product_costs").filter((r) => r.id !== "old");
    expect(rows).toEqual([
      expect.objectContaining({ org_id: ORG, store_id: STORE, sku: "SKU-A", product_name: "A", supplier: "Yiwu Trading", batch: "IMP-2026-001", unit_cost: 12.76, currency: "PEN", effective_from: "2026-11-12", note: "Costo aterrizado IMP-2026-001" }),
      expect.objectContaining({ store_id: null, sku: "SKU-B", unit_cost: 53.65, effective_from: "2026-11-12" }),
    ]);
    // La vigencia de Costos: el periodo abierto se cierra el día anterior.
    expect(h.db.rows("product_costs").find((r) => r.id === "old")).toMatchObject({ effective_to: "2026-11-11" });
    expect(h.db.rows("import_items").every((r) => r.cost_pushed_at)).toBe(true);
    expect(events("costos").at(-1)!.note).toBe("Pasó a Costos: 2 productos (SKU SKU-A, SKU-B), vigente desde 12/11/2026.");
  });

  it("dos veces no duplica: «Ya se pasó a Costos.»", async () => {
    await pushImportCosts(IMP);
    const before = h.db.rows("product_costs").length;
    const again = await pushImportCosts(IMP);
    expect(again).toEqual({ notice: "Ya se pasó a Costos." });
    expect(h.db.rows("product_costs")).toHaveLength(before);
  });

  it("una línea que otro ya marcó no se vuelve a pasar", async () => {
    h.db.rows("import_items").find((r) => r.id === ITEM_A)!.cost_pushed_at = "2026-11-13T10:00:00Z";
    await pushImportCosts(IMP);
    expect(h.db.rows("product_costs").map((r) => r.sku)).toEqual(["SKU-B"]);
  });

  it("pide «Montos de compras» y «Editar costos»; y Recibida con tipo de cambio", async () => {
    h.perms = new Set(["purchases.manage", "purchases.money"]);
    expect((await pushImportCosts(IMP)).error).toMatch(/Editar costos/);
    h.perms = new Set(["purchases.manage", "costs.manage"]);
    expect((await pushImportCosts(IMP)).error).toMatch(/Montos de compras/);
    h.perms = new Set(ALL);
    seed({ status: "en_aduana" });
    expect((await pushImportCosts(IMP)).error).toMatch(/Recibida/);
    seed({ status: "recibido", fx: null });
    expect((await pushImportCosts(IMP)).error).toMatch(/tipo de cambio/);
    expect(h.db.rows("product_costs")).toEqual([]);
  });

  it("si Costos falla, la línea se desmarca para poder reintentar", async () => {
    h.db.failOn = (table, op, payload) => (table === "product_costs" && op === "insert" && payload.sku === "SKU-B" ? { message: "boom" } : null);
    const res = await pushImportCosts(IMP);
    expect(res.error).toMatch(/SKU-B/);
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_B)!.cost_pushed_at).toBeNull();
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_A)!.cost_pushed_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Lo que se comprueba leyendo el fuente
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("las acciones vuelven a pedir el permiso", () => {
  const src = read("app/dashboard/compras/actions.ts");
  const bodies = src.split(/^export async function /m).slice(1);

  it("cada acción exportada pide permiso en la organización", () => {
    expect(bodies.length).toBeGreaterThanOrEqual(15);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      expect(/authorize\(admin|hasOrgPermission\(/.test(body), name).toBe(true);
    }
  });

  it("las de dinero piden `money: true`", () => {
    for (const name of ["setImportFx", "addImportCost", "removeImportCost", "addImportPayment", "removeImportPayment", "pushImportCosts"]) {
      const body = bodies.find((b) => b.startsWith(`${name}(`))!;
      expect(body, name).toMatch(/money: true/);
    }
  });

  it("los productos pasan por cleanItem con el permiso de dinero", () => {
    expect(src.match(/cleanItem\(input, a\.canMoney\)/g)).toHaveLength(2);
  });

  it("«Pasar a Costos» reutiliza la vigencia de Costos, no una copia", () => {
    expect(src).toContain("insertProductCostPeriod(admin");
    expect(src).toContain(`{ laterOpen: "keep" }`);
    expect(read("app/dashboard/costos/actions.ts")).toContain("insertProductCostPeriod(createAdminSupabase()");
    expect(src).toContain('.is("cost_pushed_at", null)');
  });

  it("las fechas son de Lima, nunca la fecha UTC", () => {
    expect(src).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(src).toContain("limaToday()");
    expect(src).toContain("limaYear()");
  });
});

describe("lecturas: las columnas de dinero solo con el permiso", () => {
  const src = read("lib/compras-server.ts");
  it("ITEM_MONEY_COLS e IMPORT_MONEY_COLS solo se piden detrás de canMoney/money", () => {
    for (const line of src.split("\n").filter((l) => /\$\{.*(ITEM_MONEY_COLS|IMPORT_MONEY_COLS)/.test(l))) {
      expect(line).toMatch(/\$\{(canMoney|money) \? (ITEM_MONEY_COLS|IMPORT_MONEY_COLS) : ""\}/);
    }
  });
});

describe("la ruta del documento", () => {
  const src = read("app/api/compras/documento/[id]/route.ts");
  it("vuelve a pedir permiso en la organización y la proforma/comprobante solo con «Montos»", () => {
    expect(src).toContain('hasOrgPermission(doc.org_id, "purchases.manage")');
    expect(src).toContain('hasOrgPermission(doc.org_id, "purchases.money")');
    expect(src).toContain("if (isMoneyDoc(doc.kind) && !canMoney) return NOT_FOUND();");
    expect(src).toContain("createSignedUrl(doc.storage_path, 600");
    expect(src).toContain('"referrer-policy": "no-referrer"');
  });
});

describe("la migración 0340", () => {
  const sql = read("db/migrations/0340_compras_importaciones.sql");
  const tables = ["import_suppliers", "imports", "import_items", "import_documents", "import_costs", "import_payments", "import_events"];

  it("cada tabla con RLS y sin privilegios para anon ni authenticated", () => {
    for (const t of tables) expect(sql, t).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    expect(sql).toMatch(/revoke all on public\.import_suppliers, public\.imports, public\.import_items, public\.import_documents,\s+public\.import_costs, public\.import_payments from anon, authenticated;/);
    expect(sql).toContain("revoke all on public.import_events from anon, authenticated, service_role;");
    expect(sql).toContain("grant select, insert on public.import_events to service_role;");
    expect(sql).not.toMatch(/create policy/);
  });

  it("los valores cerrados con CHECK (§13.11) y el monto > 0", () => {
    expect(sql).toContain("check (transport in ('courier', 'air', 'sea', 'land'))");
    expect(sql).toMatch(/status\s+text not null default 'cotizacion' check \(status in \(/);
    expect(sql).toContain("check (kind in ('envio', 'importacion', 'adicional'))");
    expect(sql).toContain("check (allocation in ('value', 'units', 'weight', 'item'))");
    expect(sql).toContain("amount_usd  numeric(14, 2) not null check (amount_usd > 0)");
    expect(sql).toContain("check (qty between 1 and 10000000)");
    expect(sql).toContain("check (size_bytes between 1 and 26214400)");
    expect(sql).toContain("check (tracking_url is null or (tracking_url ~* '^https?://'");
  });

  it("un costo cuyo producto se quita se queda (set null), y el historial es append-only", () => {
    expect(sql).toContain("references public.import_items (id, import_id) on delete set null (item_id)");
    expect(sql).toContain("create or replace trigger import_events_append_only before update or delete on public.import_events");
    expect(sql).toContain("constraint imports_code_org_uniq unique (org_id, code)");
    expect(sql).toContain("'import-files', 'import-files', false, 26214400");
    // DEPLOY.md, 0248: nada de `drop`.
    expect(sql).not.toMatch(/^\s*drop\s/im);
  });
});

describe("el menú, el MOM y DEPLOY.md", () => {
  it("«Compras» en el menú solo con permiso", () => {
    expect(read("app/dashboard/layout.tsx")).toContain('purchases: permissions.can("purchases.manage") || permissions.can("purchases.money")');
    expect(read("components/sidebar.tsx")).toContain('...(access.purchases ? [{ href: "/dashboard/compras", label: "Compras"');
  });

  it("el MOM tiene la sección de Compras con la fórmula y «Pasar a Costos»", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const start = mom.indexOf("## 45. Compras: importaciones");
    expect(start).toBeGreaterThan(-1);
    const section = mom.slice(start);
    for (const s of ["purchases.manage", "purchases.money", "Pasar a Costos", "3,40", "14,30", "America/Lima", "docs/compras/referencia-modulo-compras.md", "0340"]) {
      expect(section, s).toContain(s);
    }
  });

  it("DEPLOY.md: la 0340 antes que el código, con el bucket import-files, arriba de todo", () => {
    const deploy = read("DEPLOY.md");
    const first = deploy.indexOf("### ");
    const entry = deploy.slice(first, deploy.indexOf("\n### ", first + 4));
    expect(entry).toContain("0340_compras_importaciones");
    expect(entry).toContain("import-files");
    expect(entry).toMatch(/antes/i);
  });
});
