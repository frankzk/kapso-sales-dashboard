// «Compras» (MOM §45.10 y §45.11): las acciones nuevas y el permiso nuevo.
//   - «Recepción de compras» (`purchases.receive`): ve sin montos (lista y
//     detalle), guarda la recepción y sube fotos; NO edita nada más ni toca
//     dinero, documentos con montos, «Pasar a Costos», proveedores ni la IA.
//   - «Leer con IA»: la lectura no escribe nada; sin «Montos de compras» la
//     propuesta llega sin precios ni cargos; «Agregar seleccionados» pasa por
//     las reglas de siempre y deja los hechos de siempre más «Leído con IA».
//   - La foto de un producto ya creado: agregar, cambiar y quitar, y la
//     anterior se borra del bucket.
// La API de Anthropic NUNCA se llama: `fetch` está simulado.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  files: new Map<string, { size: number; contentType: string }>(),
  removed: [] as string[],
  catalog: [] as { sku: string; product_name: string | null; order_count: number }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "44444444-4444-4444-8444-444444444444", email: "bodega@kapta.pe" }) }));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (_org: string, perm: string) => h.perms.has(perm),
  orgsWithPermission: async (perm: string) => (h.perms.has(perm) ? [{ org_id: ORG, role: "vendedora" }] : []),
}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: (t: string) => h.db.from(t),
    rpc: async (n: string, a: unknown) => {
      h.db.rpcCalls.push({ name: n, args: a });
      return n === "org_shopify_products" ? { data: h.catalog, error: null } : { data: null, error: null };
    },
    storage: {
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({
        info: async (path: string) => {
          const f = h.files.get(path);
          return f ? { data: f, error: null } : { data: null, error: { message: "not found" } };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) {
            h.files.delete(p);
            h.removed.push(p);
          }
          return { data: null, error: null };
        },
        download: async (path: string) => {
          const f = h.files.get(path);
          return f ? { data: new Blob([new Uint8Array(f.size)], { type: f.contentType }), error: null } : { data: null, error: { message: "not found" } };
        },
        createSignedUploadUrl: async (path: string) => ({ data: { path, token: "tok" }, error: null }),
      }),
    },
  }),
}));

import { FakeDb } from "./woocommerce-fake-db";
import * as actions from "@/app/dashboard/compras/actions";
import { loadImportDetail, loadImportList, resolveComprasOrg } from "@/lib/compras-server";
import { visibleComprasSections } from "@/components/compras/subnav";
import { limaToday } from "@/lib/compras";

const {
  addAiProposalRows,
  readImportDocumentWithAi,
  registerImportDocument,
  saveReception,
  setImportItemPhoto,
  startImportUpload,
} = actions;

const ORG = "11111111-1111-4111-8111-111111111111";
const IMP = "22222222-2222-4222-8222-222222222222";
const OTHER_IMP = "22222222-2222-4222-8222-22222222222f";
const ITEM_A = "33333333-3333-4333-8333-33333333333a";
const ITEM_B = "33333333-3333-4333-8333-33333333333b";
const STORE = "55555555-5555-4555-8555-555555555555";
const SUPPLIER = "66666666-6666-4666-8666-666666666666";
const DOC_INVOICE = "99999999-9999-4999-8999-99999999999a";
const DOC_PROFORMA = "99999999-9999-4999-8999-99999999999b";
const DOC_PACKING = "99999999-9999-4999-8999-99999999999c";
const DOC_PHOTO = "99999999-9999-4999-8999-99999999999d";
const DOC_TRACKING = "99999999-9999-4999-8999-99999999999e";
const OLD_PHOTO = `${ORG}/${IMP}/items/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;

const ALL = ["purchases.manage", "purchases.money", "costs.manage"];
const RECEIVE = ["purchases.receive"];

function seed(status = "en_camino_bodega") {
  h.db = new FakeDb({
    stores: [{ id: STORE, org_id: ORG }],
    import_suppliers: [
      { id: SUPPLIER, org_id: ORG, name: "Yiwu Trading", country: "China", whatsapp: "+8613800000000", notes: "paga por adelantado", contact_name: "Li", email: "li@yiwu.cn", payment_terms: "30 % adelanto" },
    ],
    imports: [
      { id: IMP, org_id: ORG, code: "IMP-2026-001", supplier_id: SUPPLIER, status, arrived_on: null, fx_pen_per_usd: 3.75, transport: "courier", created_at: "2026-11-01T15:00:00Z" },
      { id: OTHER_IMP, org_id: ORG, code: "IMP-2026-002", supplier_id: null, status: "cotizacion", arrived_on: null, fx_pen_per_usd: null, transport: "air", created_at: "2026-11-02T15:00:00Z" },
    ],
    import_items: [
      { id: ITEM_A, org_id: ORG, import_id: IMP, store_id: STORE, sku: "SKU-A", name: "A", qty: 100, unit_cost_usd: 2, unit_weight_kg: 0.5, sale_price_pen: 20, image_path: OLD_PHOTO, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 1 },
      { id: ITEM_B, org_id: ORG, import_id: IMP, store_id: null, sku: "SKU-B", name: "B", qty: 50, unit_cost_usd: 12, unit_weight_kg: 0.2, sale_price_pen: 60, image_path: null, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 2 },
    ],
    import_costs: [{ id: "c1", org_id: ORG, import_id: IMP, kind: "envio", label: "Flete", amount_usd: 120, allocation: "weight", item_id: null }],
    import_payments: [{ id: "p1", org_id: ORG, import_id: IMP, amount_usd: 500, paid_on: "2026-11-02", method: "paypal", note: null, document_id: null }],
    import_documents: [
      { id: DOC_INVOICE, org_id: ORG, import_id: IMP, kind: "invoice", storage_path: `${ORG}/${IMP}/docs/inv.pdf`, filename: "factura.pdf", mime: "application/pdf", size_bytes: 2048, created_at: "2026-11-02T10:00:00Z" },
      { id: DOC_PROFORMA, org_id: ORG, import_id: IMP, kind: "proforma", storage_path: `${ORG}/${IMP}/docs/pro.pdf`, filename: "proforma.pdf", mime: "application/pdf", size_bytes: 2048, created_at: "2026-11-02T10:00:00Z" },
      { id: DOC_PACKING, org_id: ORG, import_id: IMP, kind: "packing", storage_path: `${ORG}/${IMP}/docs/pack.png`, filename: "packing.png", mime: "image/png", size_bytes: 1024, created_at: "2026-11-02T10:00:00Z" },
      { id: DOC_PHOTO, org_id: ORG, import_id: IMP, kind: "photo", storage_path: `${ORG}/${IMP}/docs/foto.jpg`, filename: "caja.jpg", mime: "image/jpeg", size_bytes: 1024, created_at: "2026-11-02T10:00:00Z" },
      { id: DOC_TRACKING, org_id: ORG, import_id: IMP, kind: "tracking", storage_path: `${ORG}/${IMP}/docs/awb.pdf`, filename: "awb.pdf", mime: "application/pdf", size_bytes: 1024, created_at: "2026-11-02T10:00:00Z" },
    ],
    import_events: [
      { id: "e1", org_id: ORG, import_id: IMP, kind: "status", status: "en_camino_bodega", note: null, by_user: null, at: "2026-11-05T10:00:00Z" },
      { id: "e2", org_id: ORG, import_id: IMP, kind: "dinero", status: null, note: "Pago registrado: US$ 500.00", by_user: null, at: "2026-11-06T10:00:00Z" },
    ],
    product_costs: [{ id: "pc1", org_id: ORG, store_id: STORE, sku: "KP-AUD-01", product_name: "Audífonos Bluetooth Pro", unit_cost: 11 }],
  });
  h.files = new Map([
    [`${ORG}/${IMP}/docs/inv.pdf`, { size: 2048, contentType: "application/pdf" }],
    [`${ORG}/${IMP}/docs/pro.pdf`, { size: 2048, contentType: "application/pdf" }],
    [`${ORG}/${IMP}/docs/pack.png`, { size: 1024, contentType: "image/png" }],
    [OLD_PHOTO, { size: 1024, contentType: "image/jpeg" }],
  ]);
}

const WRITES = ["import_items", "import_costs", "import_payments", "import_documents", "import_events", "imports", "import_suppliers", "product_costs"];
const writes = () =>
  WRITES.flatMap((t) => ["insert", "update", "delete", "upsert"].flatMap((op) => h.db.opsOn(t, op))).map((o) => `${o.table}.${o.op}`);
const events = (kind?: string) => h.db.rows("import_events").filter((e) => !kind || e.kind === kind);

/** La respuesta de Claude, por la herramienta. */
const AI_INPUT = {
  currency: "CNY",
  lines: [
    { name: "Audífonos bluetooth pro", sku: "kp-aud-01", quantity: 100, unit_price: 14.2, line_total: 1420, unit_weight_kg: 0.1, line_weight_kg: null },
    { name: "Funda de silicona", sku: null, quantity: "20", unit_price: null, line_total: "71", unit_weight_kg: null, line_weight_kg: null },
  ],
  charges: [{ kind: "envio", label: "Flete", amount: 142.5 }],
};
const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
  new Response(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "registrar_documento", input: AI_INPUT }] }), { status: 200 }),
);

beforeEach(() => {
  h.perms = new Set(ALL);
  h.removed = [];
  h.catalog = [{ sku: "FUNDA-SIL", product_name: "Funda de silicona", order_count: 4 }];
  seed();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("«Recepción de compras»: ve sin montos", () => {
  it("el detalle: sin dinero, sin proveedores para editar ni contacto, y solo factura, packing list y fotos", async () => {
    h.perms = new Set(RECEIVE);
    const detail = (await loadImportDetail(IMP))!;
    expect(detail.perms).toMatchObject({ canManage: false, canMoney: false, canReceive: true, canPushCosts: false });
    expect(detail.costs).toBeNull();
    expect(detail.payments).toBeNull();
    expect(detail.imp).not.toHaveProperty("fx_pen_per_usd");
    for (const it of detail.items) {
      expect(it).not.toHaveProperty("unit_cost_usd");
      expect(it).not.toHaveProperty("sale_price_pen");
    }
    expect(detail.documents.map((d) => d.kind).sort()).toEqual(["invoice", "packing", "photo"]);
    expect(detail.events.map((e) => e.kind)).toEqual(["status"]);
    expect(detail.suppliers).toEqual([]);
    expect(detail.supplier).toMatchObject({ name: "Yiwu Trading", whatsapp: null, email: null, contact_name: null, payment_terms: null, notes: null });
    expect(h.db.opsOn("import_costs", "select")).toEqual([]);
    expect(h.db.opsOn("import_payments", "select")).toEqual([]);
    for (const op of [...h.db.opsOn("import_items", "select"), ...h.db.opsOn("imports", "select")]) {
      expect(op.cols ?? "").not.toMatch(/unit_cost_usd|sale_price_pen|fx_pen_per_usd/);
    }
  });

  it("la lista: entra a su organización y sin montos; Proveedores y Reportes no", async () => {
    h.perms = new Set(RECEIVE);
    expect((await resolveComprasOrg(null, "view")).orgId).toBe(ORG);
    expect((await resolveComprasOrg(null)).orgId).toBeNull();
    expect((await resolveComprasOrg(null, "money")).orgId).toBeNull();
    const rows = await loadImportList(ORG, false);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.money === undefined)).toBe(true);
    expect(visibleComprasSections({ canManage: false, canMoney: false, canReceive: true }).map((s) => s.id)).toEqual(["importaciones"]);
    expect(visibleComprasSections({ canManage: true, canMoney: false, canReceive: true }).map((s) => s.id)).toEqual(["importaciones", "proveedores"]);
  });
});

describe("«Recepción de compras»: guarda la recepción y sube fotos", () => {
  it("guarda lo contado y pasa a Recibido (el único cambio de estado)", async () => {
    h.perms = new Set(RECEIVE);
    const res = await saveReception(IMP, [
      { itemId: ITEM_A, received: "100", damaged: "1", note: "una caja golpeada" },
      { itemId: ITEM_B, received: "48" },
    ]);
    expect(res.notice).toMatch(/Recibido/);
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_A)).toMatchObject({ received_qty: 100, damaged_qty: 1, reception_note: "una caja golpeada" });
    expect(h.db.rows("imports").find((r) => r.id === IMP)).toMatchObject({ status: "recibido", arrived_on: limaToday() });
    expect(events("recepcion").at(-1)!.note).toBe("Recepción: 148 de 150 u. · faltan 2 · 1 dañada");
    // Ni costo, ni precio, ni tipo de cambio en lo que se escribió.
    for (const op of [...h.db.opsOn("import_items", "update"), ...h.db.opsOn("imports", "update")]) {
      expect(Object.keys(op.payload ?? {}).join(",")).not.toMatch(/unit_cost_usd|sale_price_pen|fx_pen_per_usd/);
    }
  });

  it("sube una foto (tipo «Foto») y la registra; nada más", async () => {
    h.perms = new Set(RECEIVE);
    const up = await startImportUpload(IMP, { kind: "photo", contentType: "image/jpeg", filename: "llegada.jpg", size: 500 });
    expect(up).toHaveProperty("path");
    const path = (up as { path: string }).path;
    h.files.set(path, { size: 500, contentType: "image/jpeg" });
    const res = await registerImportDocument(IMP, { kind: "photo", path, filename: "llegada.jpg" });
    expect(res.error).toBeUndefined();
    expect(events("documento").at(-1)!.note).toBe("Documento subido: Foto (llegada.jpg).");

    for (const kind of ["invoice", "packing", "proforma", "payment", "tracking", "other", "item_photo"]) {
      expect(await startImportUpload(IMP, { kind, contentType: "image/jpeg", filename: "x.jpg", size: 10 }), kind).toHaveProperty("error");
    }
    const other = `${ORG}/${IMP}/docs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf`;
    h.files.set(other, { size: 10, contentType: "application/pdf" });
    expect((await registerImportDocument(IMP, { kind: "invoice", path: other, filename: "f.pdf" })).error).toMatch(/solo se suben fotos/);
  });

  it("no puede nada más: cabecera, estado, productos, fotos de producto, costos, pagos, tipo de cambio, Costos, documentos, IA, proveedores", async () => {
    h.perms = new Set(RECEIVE);
    const a = actions;
    const results = await Promise.all([
      a.createImport(ORG, {}),
      a.updateImportHeader(IMP, { notes: "x" }),
      a.setImportStatus(IMP, "cerrado", ""),
      a.setImportStatus(IMP, "en_camino_bodega", "nota"),
      a.setWarehouseReported(IMP, true),
      a.addImportItem(IMP, { name: "Z", qty: "1" }),
      a.updateImportItem(ITEM_A, { name: "A2", qty: "1" }),
      a.removeImportItem(ITEM_B),
      a.setImportItemPhoto(ITEM_A, null),
      a.setImportFx(IMP, "3.9"),
      a.addImportCost(IMP, { kind: "envio", amount: "10", allocation: "units" }),
      a.removeImportCost("c1"),
      a.addImportPayment(IMP, { amount: "10", paidOn: "2026-11-01", method: "paypal" }),
      a.removeImportPayment("p1"),
      a.pushImportCosts(IMP),
      a.removeImportDocument(DOC_PHOTO),
      a.readImportDocumentWithAi(DOC_INVOICE),
      a.addAiProposalRows(IMP, { documentId: DOC_INVOICE, lines: [{ name: "Z", qty: "1" }] }),
      a.createSupplier(ORG, { name: "Nuevo" }),
      a.updateSupplier(SUPPLIER, { name: "Otro" }),
      a.deleteSupplier(SUPPLIER),
    ]);
    for (const [i, r] of results.entries()) expect((r as { error?: string }).error, String(i)).toBeTruthy();
    expect(writes()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin ningún permiso de Compras, ni la recepción", async () => {
    h.perms = new Set(["costs.manage"]);
    expect((await saveReception(IMP, [{ itemId: ITEM_A, received: "1" }])).error).toBe("Sin acceso a esta importación.");
    expect(await loadImportDetail(IMP)).toBeNull();
  });

  it("solo «Montos de compras» (sin «Compras» ni «Recepción») no guarda la recepción", async () => {
    h.perms = new Set(["purchases.money"]);
    expect((await saveReception(IMP, [{ itemId: ITEM_A, received: "1" }])).error).toMatch(/recepción/);
    expect(writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("«Leer con IA»: la lectura no guarda nada", () => {
  it("propone líneas y cargos, sugiere SKU y tienda conocidos, y no escribe ni una fila", async () => {
    const res = await readImportDocumentWithAi(DOC_INVOICE);
    if ("error" in res) throw new Error(res.error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    expect(res).toMatchObject({ documentId: DOC_INVOICE, filename: "factura.pdf", currency: "CNY", money: true, existingItems: 2, dropped: 0 });
    expect(res.lines).toEqual([
      { name: "Audífonos bluetooth pro", sku: "kp-aud-01", qty: 100, unitPrice: 14.2, unitWeightKg: 0.1, match: { sku: "KP-AUD-01", name: "Audífonos Bluetooth Pro", storeId: STORE } },
      { name: "Funda de silicona", sku: null, qty: 20, unitPrice: 3.55, unitWeightKg: null, match: { sku: "FUNDA-SIL", name: "Funda de silicona", storeId: null } },
    ]);
    // El cargo sin moneda propia es de la del documento.
    expect(res.charges).toEqual([{ kind: "envio", label: "Flete", amount: 142.5, currency: "CNY" }]);
    expect(res.igv).toBeNull();
    expect(writes()).toEqual([]);
    // Del catálogo se leen SKU, nombre y tienda; ningún costo.
    for (const op of h.db.opsOn("product_costs", "select")) expect(op.cols).toBe("sku,product_name,store_id");
  });

  it("una imagen va como `image`", async () => {
    await readImportDocumentWithAi(DOC_PACKING);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });

  it("sin «Montos de compras»: la propuesta sale sin precios, sin cargos y sin moneda", async () => {
    h.perms = new Set(["purchases.manage"]);
    const res = await readImportDocumentWithAi(DOC_INVOICE);
    if ("error" in res) throw new Error(res.error);
    expect(res.money).toBe(false);
    expect(res.currency).toBeNull();
    expect(res.charges).toEqual([]);
    expect(res.lines.every((l) => l.unitPrice === null)).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/14\.2|142\.5|1420|CNY/);
    // La proforma tiene montos: ni se lee.
    fetchMock.mockClear();
    expect(await readImportDocumentWithAi(DOC_PROFORMA)).toEqual({ error: "Hace falta el permiso «Montos de compras»." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("solo factura, proforma y packing list; con clave; y corta un archivo que la API no recibe", async () => {
    expect(await readImportDocumentWithAi(DOC_TRACKING)).toHaveProperty("error");
    expect(await readImportDocumentWithAi(DOC_PHOTO)).toHaveProperty("error");
    h.db.rows("import_documents").find((d) => d.id === DOC_PACKING)!.size_bytes = 6 * 1024 * 1024;
    expect(await readImportDocumentWithAi(DOC_PACKING)).toEqual({ error: expect.stringMatching(/5 MB/) });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await readImportDocumentWithAi(DOC_INVOICE)).toEqual({ error: expect.stringMatching(/clave de IA/) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("si la IA falla, el error se dice y no se escribe nada", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 529 }));
    expect(await readImportDocumentWithAi(DOC_INVOICE)).toEqual({ error: expect.stringMatching(/ocupada/) });
    expect(writes()).toEqual([]);
  });
});

describe("«Agregar seleccionados»", () => {
  const confirm = {
    documentId: DOC_INVOICE,
    currency: "CNY",
    fx: "7.1",
    lines: [
      { name: "Audífonos Bluetooth Pro", sku: "KP-AUD-01", storeId: STORE, qty: "100", unitWeightKg: "0.1", unitPrice: "14.2" },
      { name: "Funda de silicona", sku: "FUNDA-SIL", storeId: "", qty: "20", unitWeightKg: "", unitPrice: "3.55" },
    ],
    charges: [{ kind: "envio", label: "Flete", amount: "142.5", allocation: "weight" }],
  };

  it("agrega con las reglas de siempre, en USD (4 y 2 decimales), con los hechos de siempre y «Leído con IA»", async () => {
    const res = await addAiProposalRows(IMP, confirm);
    expect(res).toEqual({ notice: "Agregados 2 productos y 1 cargo." });
    const added = h.db.rows("import_items").filter((r) => r.id !== ITEM_A && r.id !== ITEM_B);
    expect(added).toEqual([
      expect.objectContaining({ name: "Audífonos Bluetooth Pro", sku: "KP-AUD-01", store_id: STORE, qty: 100, unit_weight_kg: 0.1, unit_cost_usd: 2, sale_price_pen: null, image_path: null, position: 3, import_id: IMP, org_id: ORG }),
      expect.objectContaining({ name: "Funda de silicona", sku: "FUNDA-SIL", store_id: null, qty: 20, unit_cost_usd: 0.5, position: 4 }),
    ]);
    expect(h.db.rows("import_costs").at(-1)).toMatchObject({ kind: "envio", label: "Flete", amount_usd: 20.07, allocation: "weight", item_id: null });
    expect(events("producto").map((e) => e.note)).toEqual([
      "Producto agregado: 100 × Audífonos Bluetooth Pro (SKU KP-AUD-01).",
      "Producto agregado: 20 × Funda de silicona (SKU FUNDA-SIL).",
    ]);
    expect(events("dinero").at(-1)!.note).toBe("Costo agregado: Envío · Flete · US$ 20.07 · por peso.");
    expect(events("documento").at(-1)!.note).toBe("Leído con IA: 2 productos, 1 cargo agregados de factura.pdf.");
  });

  it("sin «Montos de compras» no guarda precios ni cargos aunque el navegador los mande", async () => {
    h.perms = new Set(["purchases.manage"]);
    const res = await addAiProposalRows(IMP, { ...confirm, fx: "" });
    expect(res.error).toBeUndefined();
    for (const op of h.db.opsOn("import_items", "insert")) {
      expect(op.payload).not.toHaveProperty("unit_cost_usd");
      expect(op.payload).not.toHaveProperty("sale_price_pen");
    }
    expect(h.db.opsOn("import_costs", "insert")).toEqual([]);
    expect(events("dinero").filter((e) => e.id !== "e2")).toEqual([]);
    expect(events("documento").at(-1)!.note).toBe("Leído con IA: 2 productos, 0 cargos agregados de factura.pdf.");
  });

  it("todo se valida antes de escribir: una fila mala, nada", async () => {
    const bad = { ...confirm, lines: [...confirm.lines, { name: "", qty: "3" }] };
    expect((await addAiProposalRows(IMP, bad)).error).toBe("Producto 3: Indica el nombre del producto.");
    expect((await addAiProposalRows(IMP, { ...confirm, lines: [{ name: "X", qty: "0" }] })).error).toMatch(/^Producto 1: Cantidad/);
    expect((await addAiProposalRows(IMP, { ...confirm, fx: "" })).error).toBe("Escribe el tipo de cambio: 1 USD = X CNY.");
    expect((await addAiProposalRows(IMP, { ...confirm, lines: [{ name: "X", qty: "1", storeId: "55555555-5555-4555-8555-000000000000" }] })).error).toMatch(/tienda/);
    expect(writes()).toEqual([]);
  });

  it("el documento tiene que ser de esta importación y de los que se leen", async () => {
    expect((await addAiProposalRows(OTHER_IMP, confirm)).error).toMatch(/no es de esta importación/);
    expect((await addAiProposalRows(IMP, { ...confirm, documentId: DOC_TRACKING })).error).toMatch(/no es de esta importación/);
    h.perms = new Set(["purchases.manage"]);
    expect((await addAiProposalRows(IMP, { ...confirm, documentId: DOC_PROFORMA })).error).toMatch(/Montos de compras/);
    expect(writes()).toEqual([]);
  });

  it("una importación cancelada no se lee ni se le agrega", async () => {
    seed("cancelado");
    expect(await readImportDocumentWithAi(DOC_INVOICE)).toEqual({ error: "La importación está cancelada." });
    expect((await addAiProposalRows(IMP, confirm)).error).toBe("La importación está cancelada.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("la foto de un producto ya creado", () => {
  const NEW_PHOTO = `${ORG}/${IMP}/items/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`;

  it("cambiarla guarda la nueva, borra la anterior del bucket y deja el hecho", async () => {
    h.files.set(NEW_PHOTO, { size: 800, contentType: "image/png" });
    expect(await setImportItemPhoto(ITEM_A, NEW_PHOTO)).toEqual({ notice: "Foto cambiada." });
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_A)!.image_path).toBe(NEW_PHOTO);
    expect(h.removed).toEqual([OLD_PHOTO]);
    expect(events("producto").at(-1)!.note).toBe("Foto cambiada: A.");
  });

  it("agregarla a uno sin foto, y quitarla", async () => {
    h.files.set(NEW_PHOTO, { size: 800, contentType: "image/png" });
    expect(await setImportItemPhoto(ITEM_B, NEW_PHOTO)).toEqual({ notice: "Foto agregada." });
    expect(h.removed).toEqual([]);
    expect(await setImportItemPhoto(ITEM_B, null)).toEqual({ notice: "Foto quitada." });
    expect(h.db.rows("import_items").find((r) => r.id === ITEM_B)!.image_path).toBeNull();
    expect(h.removed).toEqual([NEW_PHOTO]);
    expect(events("producto").map((e) => e.note)).toEqual(["Foto agregada: B.", "Foto quitada: B."]);
  });

  it("solo una imagen subida a ESTA importación; con «Compras»", async () => {
    const otherPath = `${ORG}/${OTHER_IMP}/items/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`;
    h.files.set(otherPath, { size: 800, contentType: "image/png" });
    expect((await setImportItemPhoto(ITEM_A, otherPath)).error).toMatch(/no es de esta importación/);
    const pdf = `${ORG}/${IMP}/items/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png`;
    h.files.set(pdf, { size: 800, contentType: "application/pdf" });
    expect((await setImportItemPhoto(ITEM_A, pdf)).error).toMatch(/JPG, PNG o WEBP/);
    expect(h.files.has(pdf)).toBe(false);
    h.perms = new Set(["purchases.money", "purchases.receive"]);
    expect((await setImportItemPhoto(ITEM_A, null)).error).toMatch(/no permite editar/);
    expect(writes()).toEqual([]);
    expect(h.files.has(OLD_PHOTO)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lo que se comprueba leyendo el fuente
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("el fuente", () => {
  const src = read("app/dashboard/compras/actions.ts");
  const bodies = src.split(/^export async function /m).slice(1);
  const body = (name: string) => bodies.find((b) => b.startsWith(`${name}(`))!;

  it("solo la recepción y la subida de fotos aceptan «Recepción de compras»", () => {
    const withReceive = bodies.filter((b) => /receive:/.test(b)).map((b) => b.slice(0, b.indexOf("(")));
    expect(withReceive.sort()).toEqual(["registerImportDocument", "saveReception", "startImportUpload"]);
    expect(body("saveReception")).toContain("authorize(admin, importId, { receive: true })");
    expect(body("startImportUpload")).toContain('{ receive: kind === "photo" }');
    expect(body("startImportUpload")).toContain("uploadDenied(kind, a.perms)");
    expect(body("registerImportDocument")).toContain("uploadDenied(kind, a.perms)");
    for (const name of ["readImportDocumentWithAi", "addAiProposalRows", "setImportItemPhoto"]) expect(body(name), name).toMatch(/manage: true/);
  });

  it("la lectura con IA no escribe: ni insert, ni update, ni evento", () => {
    const read = body("readImportDocumentWithAi");
    expect(read).not.toMatch(/\.insert\(|\.update\(|\.delete\(|addEvent\(|insertImport/);
    expect(read).toContain("a.canMoney ? read.proposal : stripAiMoney(read.proposal)");
  });

  it("«Agregar seleccionados» reutiliza las reglas y los hechos de agregar a mano", () => {
    const add = body("addAiProposalRows");
    expect(add).toContain("aiConfirmToInputs(input, a.canMoney)");
    expect(add).toContain("cleanItem(row, a.canMoney)");
    expect(add).toContain("cleanCost(c, itemIds)");
    expect(add).toContain("insertImportItem(admin, a, v, null, position++)");
    expect(add).toContain("insertImportCost(admin, a, v)");
    expect(body("addImportItem")).toContain("insertImportItem(admin, a, clean.value, imagePath)");
    expect(body("addImportCost")).toContain("insertImportCost(admin, a, clean.value)");
  });

  it("las rutas del documento y de la foto aceptan «Recepción de compras» con sus límites", () => {
    const doc = read("app/api/compras/documento/[id]/route.ts");
    expect(doc).toContain('hasOrgPermission(doc.org_id, "purchases.receive")');
    expect(doc).toContain("if (!canSeeDocKind(doc.kind, { canManage, canMoney, canReceive })) return NOT_FOUND();");
    expect(doc).toContain("if (isMoneyDoc(doc.kind) && !canMoney) return NOT_FOUND();");
    expect(read("app/api/compras/foto/[id]/route.ts")).toContain('hasOrgPermission(item.org_id, "purchases.receive")');
  });

  it("las páginas: la lista entra con «Recepción»; Proveedores y Reportes no; el detalle da 120 s a la IA", () => {
    const list = read("app/dashboard/compras/page.tsx");
    expect(list).toContain('resolveComprasOrg(sp.org, "view")');
    expect(list).toContain("COMPRAS_VIEW_PERMISSIONS.some((p) => master.can(p))");
    expect(read("app/dashboard/compras/proveedores/page.tsx")).toContain("if (!perms.canManage && !perms.canMoney)");
    const detail = read("app/dashboard/compras/[id]/page.tsx");
    expect(detail).toContain("export const maxDuration = 120;");
    expect(detail).toContain("COMPRAS_VIEW_PERMISSIONS.some((p) => master.can(p))");
    expect(read("app/dashboard/layout.tsx")).toContain('permissions.can("purchases.receive")');
  });

  it("la pantalla no manda precios sin «Montos» y no guarda hasta «Agregar seleccionados»", () => {
    const ui = read("components/compras/ai-proposal.tsx");
    expect(ui).toContain("...(money ? { unitPrice: l.unitPrice } : {})");
    expect(ui).toContain("const chosenCharges = money ? charges.filter((c) => c.on) : [];");
    expect((ui.match(/addAiProposalRows\(/g) ?? []).length).toBe(1);
    expect(ui).toContain("Agregar seleccionados");
  });

  it("la IA usa el patrón de Kapta: fetch directo, ANTHROPIC_VERSION, AbortController, clave de lib/env", () => {
    const vision = read("lib/compras-ia-vision.ts");
    expect(vision).toContain('const ANTHROPIC_VERSION = "2023-06-01";');
    expect(vision).toContain("new AbortController()");
    expect(vision).not.toMatch(/@anthropic-ai\/sdk/);
    expect(read("lib/compras-server.ts")).toContain("resolveVisionCreds()");
  });
});

describe("el MOM y DEPLOY.md", () => {
  it("§45.10 y §45.11 con sus reglas, y el resumen de permisos", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const section = mom.slice(mom.indexOf("## 45. Compras: importaciones"));
    for (const s of [
      "### 45.10 «Leer con IA»",
      "### 45.11 «Recepción de compras»",
      "purchases.receive",
      "Agregar seleccionados",
      "1 USD = X <moneda>",
      "4 decimales",
      "al menos 6 caracteres",
      "sin precios, sin cargos y sin moneda",
      "«Almacén»",
    ]) {
      expect(section.replace(/\s+/g, " "), s).toContain(s);
    }
    expect(mom.slice(0, mom.indexOf("## 45. Compras: importaciones"))).toContain("«Recepción de compras»** (`purchases.receive`");
  });

  it("DEPLOY.md: su entrada, sin migración", () => {
    const deploy = read("DEPLOY.md");
    // Por su título: otras entradas pueden ir encima.
    const first = deploy.indexOf("### 14-11-2026 · Compras: «Leer con IA»");
    expect(first).toBeGreaterThanOrEqual(0);
    const entry = deploy.slice(first, deploy.indexOf("\n### ", first + 4));
    expect(entry).toContain("«Leer con IA»");
    expect(entry).toContain("purchases.receive");
    expect(entry).toMatch(/Sin migración/);
  });
});
