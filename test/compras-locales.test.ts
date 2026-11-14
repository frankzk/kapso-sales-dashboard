// «Compras» (MOM §45.12–§45.15, 0343): compras locales a laboratorios y
// maquilas, cortesía, entregas parciales con foto, comprobante obligatorio en
// los pagos locales, los códigos de trazabilidad de una importación, el IGV de
// cada costo (neto, con IGV, inafecto) y editar costos y pagos.
//   - La serie LOC- y la base en soles (sin tipo de cambio si todo es soles).
//   - La cortesía: no sube montos, baja el costo por unidad buena; «faltan».
//   - Entregas: totales = Σ entregas (el trigger de la 0343, imitado aquí con
//     `withDeliveryTrigger`), estado Recibido parcial / Recibido, foto
//     obligatoria en una compra local, corregir y quitar con «Compras».
//   - La recepción de antes (una entrega «legacy») no se pierde.
//   - «Recepción de compras» registra entregas y nada más.

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
import { withDeliveryTrigger } from "./compras-entregas-fake";
import * as actions from "@/app/dashboard/compras/actions";
import { loadImportDetail } from "@/lib/compras-server";
import {
  DELIVERY_PHOTO_REQUIRED,
  PAYMENT_VOUCHER_REQUIRED,
  cleanCost,
  cleanDelivery,
  cleanHeader,
  cleanItem,
  cleanPayment,
  costAmountText,
  costChangeNote,
  costPushPlan,
  defaultItemCostColumns,
  deliveryTotals,
  formatDmy,
  goodUnits,
  igvTreatmentOf,
  importAlerts,
  importChecklist,
  isImportCode,
  landedCosts,
  limaToday,
  limaYear,
  lineProgress,
  lineProgressText,
  nextImportCode,
  paymentChangeNote,
  receptionEventNote,
  receptionSummary,
  statusAfterDelivery,
  statusTraceBlocker,
  traceCodes,
  traceCodesRequiredFor,
} from "@/lib/compras";
import { aiConfirmToInputs, parseAiProposal } from "@/lib/compras-ia";
import { needsFxForUsd, supplierStats, unitCostHistory, type ReportImport } from "@/lib/compras-reportes";

const ORG = "11111111-1111-4111-8111-111111111111";
const LOC = "22222222-2222-4222-8222-22222222222c";
const IMP = "22222222-2222-4222-8222-22222222222a";
const CREMA = "33333333-3333-4333-8333-3333333333c1";
const GEL = "33333333-3333-4333-8333-3333333333c2";
const ITEM_I = "33333333-3333-4333-8333-3333333333a1";
const LAB = "66666666-6666-4666-8666-666666666666";
const COST = "77777777-7777-4777-8777-777777777771";
const PAY = "88888888-8888-4888-8888-888888888881";
const VOUCHER = "99999999-9999-4999-8999-999999999991";
const USER = "44444444-4444-4444-8444-444444444444";

const ALL = ["purchases.manage", "purchases.money", "costs.manage"];
const RECEIVE = ["purchases.receive"];
const TODAY = limaToday();

const photoPath = (n: number) => `${ORG}/${LOC}/docs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}.jpg`;
const docPath = (imp: string, n: number, ext = "pdf") => `${ORG}/${imp}/docs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${n}.${ext}`;

function seed(opts: { locStatus?: string; impStatus?: string; codes?: boolean } = {}) {
  h.db = withDeliveryTrigger(
    new FakeDb({
      stores: [],
      import_suppliers: [{ id: LAB, org_id: ORG, name: "Laboratorio Andino", country: "Perú" }],
      imports: [
        // Una compra local (MOM §45.12): en soles, sin tipo de cambio.
        { id: LOC, org_id: ORG, code: "LOC-2026-001", kind: "local", supplier_id: LAB, status: opts.locStatus ?? "pagado", arrived_on: null, fx_pen_per_usd: null, transport: "land", created_at: "2026-11-01T15:00:00Z" },
        // Una importación como las de antes, con o sin sus códigos de trazabilidad (MOM §45.15).
        {
          id: IMP,
          org_id: ORG,
          code: "IMP-2026-001",
          supplier_id: null,
          status: opts.impStatus ?? "cotizacion",
          arrived_on: null,
          fx_pen_per_usd: 3.75,
          transport: "courier",
          created_at: "2026-11-01T15:00:00Z",
          ...(opts.codes ? { proforma_number: "PI-2026-0042", platform_order: "2045123456789", tracking_number: "1234567890" } : {}),
        },
      ],
      import_items: [
        { id: CREMA, org_id: ORG, import_id: LOC, sku: "CREMA-1", name: "Crema", qty: 600, courtesy_qty: 50, unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 7.5, sale_price_pen: 25, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 1 },
        { id: GEL, org_id: ORG, import_id: LOC, sku: "GEL-1", name: "Gel", qty: 200, courtesy_qty: 0, unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 4, sale_price_pen: 15, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 2 },
        { id: ITEM_I, org_id: ORG, import_id: IMP, sku: "SKU-I", name: "Audífonos", qty: 100, unit_cost_usd: 2, unit_weight_kg: 0.1, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 1 },
      ],
      import_costs: [
        { id: COST, org_id: ORG, import_id: LOC, kind: "envio", label: "AFORO FÍSICO", currency: "PEN", amount_usd: null, amount_pen: 114.5, includes_igv: false, gross_amount: null, igv_treatment: "neto", allocation: "units", item_id: null },
      ],
      import_payments: [
        { id: PAY, org_id: ORG, import_id: LOC, currency: "PEN", amount_usd: null, amount_pen: 2000, paid_on: "2026-11-02", method: "transferencia", note: null, document_id: VOUCHER },
      ],
      import_documents: [
        { id: VOUCHER, org_id: ORG, import_id: LOC, kind: "payment", storage_path: docPath(LOC, 1), filename: "yape.png", mime: "image/png", size_bytes: 10, created_at: "2026-11-02T10:00:00Z", delivery_id: null },
      ],
      import_deliveries: [],
      import_delivery_lines: [],
      import_events: [],
      product_costs: [],
    }),
  );
  h.files = new Map([
    [photoPath(1), { size: 900, contentType: "image/jpeg" }],
    [photoPath(2), { size: 900, contentType: "image/jpeg" }],
  ]);
}

beforeEach(() => {
  h.perms = new Set(ALL);
  seed();
});

const events = (kind?: string) => h.db.rows("import_events").filter((e) => !kind || e.kind === kind);
const item = (id: string) => h.db.rows("import_items").find((r) => r.id === id)!;
const imp = (id: string) => h.db.rows("imports").find((r) => r.id === id)!;

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

describe("la serie del código (MOM §45.12)", () => {
  it("LOC-<año>-NNN va por su lado; las IMP- no cuentan", () => {
    expect(nextImportCode(["IMP-2026-003", "IMP-2026-009"], 2026, "local")).toBe("LOC-2026-001");
    expect(nextImportCode(["LOC-2026-001", "LOC-2026-007", "LOC-2025-099", "IMP-2026-012"], 2026, "local")).toBe("LOC-2026-008");
    expect(nextImportCode(["LOC-2026-050", "IMP-2026-002"], 2026)).toBe("IMP-2026-003");
    expect(isImportCode("LOC-2026-001")).toBe(true);
    expect(isImportCode("LOC-2026-001", "local")).toBe(true);
    expect(isImportCode("LOC-2026-001", "importacion")).toBe(false);
    expect(isImportCode("IMP-2026-001", "local")).toBe(false);
    expect(isImportCode("LAB-2026-001")).toBe(false);
  });
});

describe("la cortesía (MOM §45.13)", () => {
  const crema = { id: "c", name: "Crema", qty: 600, courtesyQty: 50, unitCostUsd: 0, unitCostPen: 7.5, unitCostCurrency: "PEN" as const };

  it("no sube el costo y baja el costo por unidad buena", () => {
    const without = landedCosts([{ ...crema, courtesyQty: 0, receivedQty: 600, damagedQty: 0 }], []);
    const withCourtesy = landedCosts([{ ...crema, receivedQty: 650, damagedQty: 0 }], []);
    expect(without.pen!.total).toBe(4500);
    expect(withCourtesy.pen!.total).toBe(4500);
    expect(without.lines[0]!.pen!.unitCost).toBe(7.5);
    expect(withCourtesy.lines[0]!.pen!.unitCost).toBeCloseTo(4500 / 650, 10);
    expect(withCourtesy.lines[0]!.pen!.unitCost).toBeLessThan(without.lines[0]!.pen!.unitCost);
    // Sin entregas todavía, el costo se estima sobre lo esperado (pedidas + cortesía).
    expect(goodUnits({ qty: 600, courtesyQty: 50, receivedQty: null, damagedQty: null })).toBe(650);
  });

  it("«faltan» = esperadas − recibidas; el texto del avance", () => {
    const p = lineProgress({ qty: 600, courtesyQty: 50, receivedQty: 400, damagedQty: 3 });
    expect(p).toMatchObject({ expected: 650, received: 400, missing: 250, good: 397, extra: 0 });
    expect(lineProgressText(p)).toBe("Llegaron 400 de 600 (+50 cortesía) · faltan 250");
    expect(lineProgressText(lineProgress({ qty: 600, courtesyQty: 50, receivedQty: 650, damagedQty: 0 }))).toBe("Llegaron 650 de 600 (+50 cortesía) · completo");
    expect(lineProgressText(lineProgress({ qty: 10, receivedQty: 12, damagedQty: 0 }))).toBe("Llegaron 12 de 10 · sobran 2");
    const s = receptionSummary([
      { id: "c", qty: 600, courtesyQty: 50, receivedQty: 600, damagedQty: 0 },
      { id: "g", qty: 200, receivedQty: null, damagedQty: null },
    ]);
    expect(s).toMatchObject({ ordered: 800, courtesy: 50, expected: 850, received: 600, missing: 50, allArrived: false });
    expect(receptionEventNote(s)).toBe("Recepción: 600 de 800 u. (+50 de cortesía) · faltan 50 · 1 sin contar");
  });
});

describe("las entregas (MOM §45.14)", () => {
  it("los totales de cada producto son la suma de sus entregas", () => {
    const t = deliveryTotals([
      { itemId: "c", received: 400, damaged: 3 },
      { itemId: "g", received: 100, damaged: 0 },
      { itemId: "c", received: 250, damaged: 2 },
    ]);
    expect(t.get("c")).toEqual({ received: 650, damaged: 5 });
    expect(t.get("g")).toEqual({ received: 100, damaged: 0 });
    expect(t.has("x")).toBe(false);
  });

  it("el estado solo avanza: una parte → Recibido parcial; todo lo esperado → Recibido con la llegada de la última entrega", () => {
    const items = [
      { qty: 600, courtesyQty: 50, receivedQty: 600 },
      { qty: 200, courtesyQty: 0, receivedQty: 200 },
    ];
    // Falta la cortesía: todavía es parcial.
    expect(statusAfterDelivery({ status: "pagado", items, lastDeliveredOn: "2026-11-12" })).toEqual({ status: "recibido_parcial", arrivedOn: null });
    expect(statusAfterDelivery({ status: "recibido_parcial", items, lastDeliveredOn: "2026-11-12" })).toBeNull();
    const all = [{ ...items[0]!, receivedQty: 650 }, items[1]!];
    expect(statusAfterDelivery({ status: "recibido_parcial", items: all, lastDeliveredOn: "2026-11-13" })).toEqual({ status: "recibido", arrivedOn: "2026-11-13" });
    expect(statusAfterDelivery({ status: "en_camino_bodega", items: all, lastDeliveredOn: "2026-11-13" })).toEqual({ status: "recibido", arrivedOn: "2026-11-13" });
    // Ya recibida, después o cancelada: no cambia. Sin nada que llegó: tampoco.
    for (const status of ["recibido", "ingresado", "cerrado", "cancelado"] as const) expect(statusAfterDelivery({ status, items: all, lastDeliveredOn: "2026-11-13" }), status).toBeNull();
    expect(statusAfterDelivery({ status: "pagado", items: [{ qty: 5, receivedQty: null }], lastDeliveredOn: null })).toBeNull();
  });

  it("valida la entrega: fecha de Lima hasta hoy; vacío o 0 = no vino", () => {
    const ids = ["c", "g"];
    expect(cleanDelivery({ deliveredOn: "2099-01-01", lines: [{ itemId: "c", received: "1" }] }, ids, "2026-11-14")).toEqual({ error: "La fecha de la entrega no puede ser después de hoy." });
    expect(cleanDelivery({ deliveredOn: "14/11/2026", lines: [{ itemId: "c", received: "1" }] }, ids, "2026-11-14")).toHaveProperty("error");
    expect(cleanDelivery({ deliveredOn: "2026-11-14", note: " llegó en camioneta ", lines: [{ itemId: "c", received: "0" }, { itemId: "g", received: "5", damaged: "1" }] }, ids, "2026-11-14")).toEqual({
      value: { delivered_on: "2026-11-14", note: "llegó en camioneta", lines: [{ itemId: "g", received: 5, damaged: 1, note: null }] },
    });
  });
});

describe("compra local: soles sin tipo de cambio (MOM §45.12)", () => {
  const items = [
    { id: "c", qty: 600, courtesyQty: 50, unitCostUsd: 0, unitCostPen: 7.5, unitCostCurrency: "PEN" as const, receivedQty: 650, damagedQty: 0 },
    { id: "g", qty: 200, unitCostUsd: 0, unitCostPen: 4, unitCostCurrency: "PEN" as const, receivedQty: 200, damagedQty: 0 },
  ];
  const costs = [{ kind: "envio" as const, label: "Transporte", amount: 80, currency: "PEN" as const, allocation: "units" as const }];
  const pushItems = [
    { id: "c", name: "Crema", sku: "CREMA-1", storeId: null, receivedQty: 650, costPushedAt: null },
    { id: "g", name: "Gel", sku: "GEL-1", storeId: null, receivedQty: 200, costPushedAt: null },
  ];

  it("el costo aterrizado por unidad buena en soles, sin tipo de cambio; la vista en USD lo pide", () => {
    const landed = landedCosts(items, costs, null);
    expect(landed.hasUsd).toBe(false);
    expect(landed.usd).toBeNull();
    expect(landed.pen).toEqual({ productTotal: 5300, costsTotal: 80, total: 5380 });
    // Crema: (4500 + 80 × 600/800) ÷ 650; Gel: (800 + 20) ÷ 200.
    expect(landed.byItem.get("c")!.pen!.unitCost).toBeCloseTo(4560 / 650, 10);
    expect(landed.byItem.get("g")!.pen!.unitCost).toBe(4.1);
    expect(landed.byItem.get("c")!.usd).toBeNull();
  });

  it("«Pasar a Costos» no pide tipo de cambio si todo está en soles; con un US$, sí", () => {
    const plan = costPushPlan({ status: "recibido", fxPenPerUsd: null, items: pushItems, landed: landedCosts(items, costs, null) });
    expect(plan.blockers).toEqual([]);
    expect(plan.lines).toEqual([
      { itemId: "c", name: "Crema", sku: "CREMA-1", storeId: null, state: "push", unitCostPen: 7.02 },
      { itemId: "g", name: "Gel", sku: "GEL-1", storeId: null, state: "push", unitCostPen: 4.1 },
    ]);
    const withUsd = [...costs, { kind: "adicional" as const, label: "Envase importado", amount: 10, currency: "USD" as const, allocation: "units" as const }];
    expect(costPushPlan({ status: "recibido", fxPenPerUsd: null, items: pushItems, landed: landedCosts(items, withUsd, null) }).blockers).toContain("Falta el tipo de cambio (soles por 1 USD).");
  });

  it("el producto se guarda en soles; sin «Montos», con costo 0 en soles", () => {
    expect(cleanItem({ name: "Crema", qty: "600", courtesyQty: "50", unitCostPen: "7,5", salePricePen: "25" }, true, "PEN")).toEqual({
      value: { store_id: null, sku: null, name: "Crema", qty: 600, courtesy_qty: 50, unit_weight_kg: null, unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 7.5, sale_price_pen: 25 },
    });
    expect(cleanItem({ name: "X", qty: "1", courtesyQty: "-1" }, true, "PEN")).toHaveProperty("error");
    expect(defaultItemCostColumns("PEN")).toEqual({ unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 0 });
    expect(defaultItemCostColumns("USD")).toEqual({});
  });

  it("sin transporte, guía, proforma ni aviso a la bodega; «Atrasada» sí", () => {
    const head = cleanHeader({ transport: "air", carrier: "DHL", trackingNumber: "123", trackingUrl: "https://x.y", proformaNumber: "PI-1", platformOrder: "COT-7" }, "local");
    expect(head).toMatchObject({ value: { transport: "land", carrier: null, tracking_number: null, tracking_url: null, proforma_number: null, platform_order: "COT-7" } });
    const base = { status: "en_transito" as const, eta: "2026-11-10", reportedAt: null, lastMovementAt: "2026-10-01T15:00:00Z" };
    expect(importAlerts({ ...base, kind: "local" }, "2026-11-14")).toMatchObject({ late: true, notifyWarehouse: false, stale: false });
    expect(importAlerts({ ...base, kind: "importacion" }, "2026-11-14")).toMatchObject({ late: true, notifyWarehouse: true, stale: true });
    // Recibido parcial: la bodega ya lo tiene, no se avisa.
    expect(importAlerts({ ...base, status: "recibido_parcial" }, "2026-11-14")).toMatchObject({ late: true, notifyWarehouse: false });
    expect(importChecklist(["invoice"], null, "local")).toEqual({ invoice: true, tracking: null });
  });

  it("el comprobante del pago es obligatorio en una compra local; la moneda por defecto, soles", () => {
    expect(cleanPayment({ amount: "500", paidOn: "2026-11-02", method: "transferencia" }, [], { voucherRequired: true, base: "PEN" })).toEqual({ error: PAYMENT_VOUCHER_REQUIRED });
    expect(cleanPayment({ amount: "500", paidOn: "2026-11-02", method: "transferencia", documentId: "d1" }, ["d1"], { voucherRequired: true, base: "PEN" })).toMatchObject({
      value: { currency: "PEN", amount_pen: 500, amount_usd: null, document_id: "d1" },
    });
    expect(cleanPayment({ amount: "500", paidOn: "2026-11-02", method: "transferencia" }, [])).toMatchObject({ value: { currency: "USD", document_id: null } });
  });

  it("«Leer con IA»: precios en soles se quedan en soles; en otra moneda, «1 <moneda> = X S/»", () => {
    const pen = aiConfirmToInputs({ currency: "PEN", lines: [{ name: "Crema", qty: "600", unitPrice: "7.5" }], charges: [{ kind: "envio", amount: "80", currency: "PEN" }] }, true, "PEN");
    expect(pen).toMatchObject({ fx: 1, items: [{ unitCostPen: "7.5" }], costs: [{ amount: "80", currency: "PEN" }] });
    expect(pen).not.toHaveProperty("items.0.unitCostUsd");
    expect(aiConfirmToInputs({ currency: "USD", lines: [{ name: "Crema", qty: "1", unitPrice: "2" }] }, true, "PEN")).toEqual({ error: "Escribe el tipo de cambio: 1 USD = X S/." });
    expect(aiConfirmToInputs({ currency: "USD", fx: "3.75", lines: [{ name: "Crema", qty: "1", unitPrice: "2" }], charges: [{ kind: "envio", amount: "10", currency: "USD" }] }, true, "PEN")).toMatchObject({
      items: [{ unitCostPen: "7.5" }],
      costs: [{ amount: "10", currency: "USD" }],
    });
    // La importación sigue igual: 1 USD = X <moneda>.
    expect(aiConfirmToInputs({ currency: "CNY", lines: [{ name: "A", qty: "1", unitPrice: "7" }] }, true)).toEqual({ error: "Escribe el tipo de cambio: 1 USD = X CNY." });
  });

  it("los reportes: en soles tal cual, en USD solo con tipo de cambio; faltantes sobre lo esperado", () => {
    const report = (over: Partial<ReportImport>): ReportImport => ({
      id: "r",
      code: "LOC-2026-001",
      kind: "local",
      supplierId: "lab",
      status: "recibido",
      orderedOn: "2026-11-01",
      createdAt: "2026-11-01T15:00:00Z",
      eta: null,
      arrivedOn: "2026-11-10",
      fxPenPerUsd: null,
      items: [{ id: "c", name: "Crema", sku: "CREMA-1", storeId: null, qty: 600, courtesyQty: 50, unitCostUsd: 0, unitCostPen: 7.5, unitCostCurrency: "PEN", unitWeightKg: null, receivedQty: 650, damagedQty: 0 }],
      costs: [],
      payments: [],
      ...over,
    });
    expect(needsFxForUsd(report({}))).toBe(true);
    expect(needsFxForUsd(report({ fxPenPerUsd: 3.75 }))).toBe(false);
    const stats = supplierStats("lab", [report({})], { money: true });
    expect(stats.shortageShare).toBe(0);
    expect(stats.boughtPen).toBe(4500);
    expect(stats.boughtUsdWithoutFx).toBe(1);
    // El cambio del costo por unidad, en soles si ninguna tiene tipo de cambio.
    const older = report({ id: "r0", code: "LOC-2026-000", orderedOn: "2026-10-01", items: [{ ...report({}).items[0]!, courtesyQty: 0, receivedQty: 600 }] });
    const [product] = unitCostHistory([older, report({})]);
    expect(product!.last.unitCostPen).toBeCloseTo(4500 / 650, 10);
    expect(product!.change).toBeCloseTo(4500 / 650 / 7.5 - 1, 10);
    expect(product!.trend).toBe("down");
  });
});

describe("los códigos de trazabilidad de una importación (MOM §45.15)", () => {
  const none = { kind: "importacion" as const, proforma_number: null, platform_order: null, tracking_number: null };

  it("tres códigos; una compra local no los usa", () => {
    expect(traceCodes(none)).toMatchObject({ applies: true, filled: 0, total: 3, missing: ["proforma", "alibaba", "guide"] });
    expect(traceCodes({ ...none, proforma_number: " PI-1 ", platform_order: "2045" })).toMatchObject({ filled: 2, missing: ["guide"] });
    expect(traceCodes({ kind: "local", proforma_number: null, platform_order: null, tracking_number: null })).toMatchObject({ applies: false, filled: 0, missing: [] });
  });

  it("se piden de forma progresiva; cancelar nunca los pide", () => {
    expect(traceCodesRequiredFor("cotizacion")).toEqual([]);
    expect(traceCodesRequiredFor("pagado")).toEqual(["proforma", "alibaba"]);
    expect(traceCodesRequiredFor("en_produccion")).toEqual(["proforma", "alibaba"]);
    for (const s of ["en_transito", "en_aduana", "en_camino_bodega", "recibido_parcial", "recibido", "ingresado", "cerrado"] as const) {
      expect(traceCodesRequiredFor(s), s).toEqual(["proforma", "alibaba", "guide"]);
    }
    expect(traceCodesRequiredFor("cancelado")).toEqual([]);
    expect(statusTraceBlocker(none, "pagado")!.message).toBe("Para pasar a «Pagado» faltan el código de la proforma invoice y la orden de Alibaba (códigos de trazabilidad).");
    expect(statusTraceBlocker({ ...none, proforma_number: "PI-1", platform_order: "2045" }, "en_transito")!.message).toBe(
      "Para pasar a «En tránsito» falta la guía de envío (códigos de trazabilidad).",
    );
    expect(statusTraceBlocker(none, "cancelado")).toBeNull();
    expect(statusTraceBlocker({ ...none, kind: "local" }, "recibido")).toBeNull();
  });

  it("«Pasar a Costos» de una importación pide los tres", () => {
    const items = [{ id: "a", name: "A", sku: "SKU-A", storeId: null, receivedQty: 10, costPushedAt: null }];
    const landed = landedCosts([{ id: "a", qty: 10, unitCostUsd: 2, receivedQty: 10, damagedQty: 0 }], [], 3.75);
    const plan = costPushPlan({ status: "recibido", fxPenPerUsd: 3.75, items, landed, trace: traceCodes({ ...none, proforma_number: "PI-1" }) });
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContain("Faltan códigos de trazabilidad: la orden de Alibaba y la guía de envío.");
    expect(costPushPlan({ status: "recibido", fxPenPerUsd: 3.75, items, landed, trace: traceCodes({ ...none, proforma_number: "PI-1", platform_order: "2", tracking_number: "3" }) }).ready).toBe(true);
  });
});

describe("el IGV de cada costo y lo que cambió al editar (MOM §45.3)", () => {
  it("neto, incluye IGV o inafecto", () => {
    expect(cleanCost({ kind: "envio", label: "Flete internacional", amount: "300", currency: "USD", igvTreatment: "inafecto" }, [])).toMatchObject({
      value: { amount_usd: 300, includes_igv: false, gross_amount: null, igv_treatment: "inafecto" },
    });
    expect(cleanCost({ kind: "importacion", amount: "504.16", currency: "PEN", igvTreatment: "con_igv" }, [])).toMatchObject({
      value: { amount_pen: 427.25, includes_igv: true, gross_amount: 504.16, igv_treatment: "con_igv" },
    });
    expect(cleanCost({ kind: "importacion", amount: "427.25", currency: "PEN" }, [])).toMatchObject({ value: { igv_treatment: "neto", includes_igv: false } });
    expect(cleanCost({ kind: "envio", amount: "1", igvTreatment: "exonerado" }, [])).toEqual({ error: "Tratamiento del IGV inválido." });
    expect(costAmountText({ amount: 300, currency: "USD", igv_treatment: "inafecto" })).toBe("US$ 300.00 · inafecto a IGV");
    expect(igvTreatmentOf({ includes_igv: true })).toBe("con_igv");
    expect(igvTreatmentOf({ includes_igv: false })).toBe("neto");
  });

  it("la IA propone inafecto lo que el documento marca inafecto o exonerado", () => {
    const p = parseAiProposal({
      currency: "USD",
      charges: [
        { kind: "envio", label: "Flete internacional", amount: 300, igv_exempt: true },
        { kind: "importacion", label: "Desaduanaje", amount: 50, igv_exempt: false },
      ],
    })!;
    expect(p.charges.map((c) => c.igvTreatment)).toEqual(["inafecto", "neto"]);
    const conv = aiConfirmToInputs({ currency: "USD", lines: [], charges: [{ kind: "envio", amount: "300", currency: "USD", igvTreatment: "inafecto" }] }, true);
    expect(conv).toMatchObject({ costs: [{ igvTreatment: "inafecto" }] });
  });

  it("el hecho dice qué cambió", () => {
    const before = { kind: "envio", label: "AFORO FÍSICO", currency: "PEN" as const, amount: 114.5, includes_igv: false, gross_amount: null, igv_treatment: "neto" as const, allocation: "units", item_id: null };
    expect(costChangeNote(before, { ...before, kind: "importacion" })).toBe("Costo «AFORO FÍSICO»: tipo Envío → Importación.");
    expect(costChangeNote(before, { ...before, igv_treatment: "inafecto" })).toBe("Costo «AFORO FÍSICO»: IGV Sin IGV (monto neto) → Inafecto a IGV.");
    expect(costChangeNote(before, { ...before, amount: 97.03, includes_igv: true, gross_amount: 114.5, igv_treatment: "con_igv" })).toBe(
      "Costo «AFORO FÍSICO»: monto S/ 114.50 → S/ 114.50 con IGV → S/ 97.03 sin IGV.",
    );
    expect(costChangeNote(before, before)).toBe("");
    const pay = { currency: "USD" as const, amount: 500, paid_on: "2026-11-02", method: "paypal", note: null, document_id: "d1" };
    expect(paymentChangeNote(pay, { ...pay, amount: 520, method: "transferencia" })).toBe("Pago del 02/11/2026: monto US$ 500.00 → US$ 520.00 · método PayPal → Transferencia.");
    expect(paymentChangeNote(pay, pay)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Las acciones
// ---------------------------------------------------------------------------

describe("crear una compra local", () => {
  it("LOC-<año de Lima>-NNN, en soles, sin transporte ni guía", async () => {
    const year = limaYear();
    h.db.rows("imports").push({ id: "x", org_id: ORG, code: `LOC-${year}-004`, kind: "local" }, { id: "y", org_id: ORG, code: `IMP-${year}-009` });
    const res = await actions.createImport(ORG, { kind: "local", supplierId: LAB, transport: "air", carrier: "DHL", trackingNumber: "1", proformaNumber: "PI-1" });
    expect(res.error).toBeUndefined();
    expect(res.notice).toBe(`Compra local LOC-${year}-005 creada en Cotización.`);
    expect(imp(res.id!)).toMatchObject({ code: `LOC-${year}-005`, kind: "local", transport: "land", carrier: null, tracking_number: null, proforma_number: null });
    expect(events("status").at(-1)).toMatchObject({ note: "Compra local creada", status: "cotizacion" });
    expect((await actions.createImport(ORG, { kind: "laboratorio" })).error).toBe("Tipo de compra inválido.");
  });

  it("un producto nuevo de una compra local va en soles (con o sin «Montos»)", async () => {
    await actions.addImportItem(LOC, { name: "Jabón", qty: "100", courtesyQty: "10", unitCostPen: "3.2" });
    expect(h.db.rows("import_items").at(-1)).toMatchObject({ name: "Jabón", courtesy_qty: 10, unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 3.2 });
    expect(events("producto").at(-1)!.note).toBe("Producto agregado: 100 × Jabón (+10 de cortesía).");
    h.perms = new Set(["purchases.manage"]);
    await actions.addImportItem(LOC, { name: "Champú", qty: "5", unitCostPen: "99" });
    expect(h.db.rows("import_items").at(-1)).toMatchObject({ name: "Champú", unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 0 });
  });

  it("el aviso a la bodega no es de una compra local", async () => {
    expect((await actions.setWarehouseReported(LOC, true)).error).toMatch(/compra local/);
  });
});

describe("entregas parciales con evidencia", () => {
  it("una entrega de una compra local sin foto no se guarda", async () => {
    const res = await actions.registerDelivery(LOC, { deliveredOn: TODAY, lines: [{ itemId: CREMA, received: "400" }] });
    expect(res).toEqual({ error: DELIVERY_PHOTO_REQUIRED });
    expect(h.db.rows("import_deliveries")).toEqual([]);
    expect(h.db.rows("import_delivery_lines")).toEqual([]);
  });

  it("con foto: la entrega, sus líneas, la foto ligada, los totales y Recibido parcial", async () => {
    const res = await actions.registerDelivery(LOC, {
      deliveredOn: TODAY,
      note: "Primera parte",
      lines: [
        { itemId: CREMA, received: "400", damaged: "3", note: "tres cajas golpeadas" },
        { itemId: GEL, received: "" },
      ],
      photos: [{ path: photoPath(1), filename: "llegada.jpg" }],
    });
    expect(res.notice).toBe("Entrega registrada. Pasó a Recibido parcial.");
    const [d] = h.db.rows("import_deliveries");
    expect(d).toMatchObject({ import_id: LOC, org_id: ORG, delivered_on: TODAY, note: "Primera parte", by_user: USER });
    expect(h.db.rows("import_delivery_lines")).toEqual([expect.objectContaining({ delivery_id: d!.id, item_id: CREMA, received: 400, damaged: 3, note: "tres cajas golpeadas" })]);
    expect(h.db.rows("import_documents").find((x) => x.storage_path === photoPath(1))).toMatchObject({ kind: "photo", delivery_id: d!.id, mime: "image/jpeg" });
    expect(item(CREMA)).toMatchObject({ received_qty: 400, damaged_qty: 3 });
    expect(item(GEL).received_qty).toBeNull();
    expect(imp(LOC)).toMatchObject({ status: "recibido_parcial", arrived_on: null });
    expect(events("recepcion").at(-1)!.note).toBe(`Entrega registrada del ${formatDmy(TODAY)}: 400 × Crema (3 dañadas) · 1 foto.`);
    expect(events("status").at(-1)).toMatchObject({ status: "recibido_parcial" });

    // La segunda trae el resto (con la cortesía): Recibido, con la llegada del día de la entrega.
    const second = await actions.registerDelivery(LOC, {
      deliveredOn: TODAY,
      lines: [
        { itemId: CREMA, received: "250" },
        { itemId: GEL, received: "200" },
      ],
      photos: [{ path: photoPath(2), filename: "resto.jpg" }],
    });
    expect(second.notice).toMatch(/pasó a Recibido/);
    expect(item(CREMA)).toMatchObject({ received_qty: 650, damaged_qty: 3 });
    expect(imp(LOC)).toMatchObject({ status: "recibido", arrived_on: TODAY });
  });

  it("corregir (con «Compras»): las líneas cambian, los totales se recalculan y queda el antes", async () => {
    await actions.registerDelivery(LOC, { deliveredOn: TODAY, lines: [{ itemId: CREMA, received: "400" }], photos: [{ path: photoPath(1) }] });
    const [d] = h.db.rows("import_deliveries");
    const res = await actions.updateDelivery(d!.id, { deliveredOn: TODAY, lines: [{ itemId: CREMA, received: "380", damaged: "2" }, { itemId: GEL, received: "20" }] });
    expect(res.error).toBeUndefined();
    expect(item(CREMA)).toMatchObject({ received_qty: 380, damaged_qty: 2 });
    expect(item(GEL)).toMatchObject({ received_qty: 20 });
    expect(events("recepcion").at(-1)!.note).toBe(`Entrega corregida del ${formatDmy(TODAY)}: 380 × Crema (2 dañadas) · 20 × Gel. Antes: 400 × Crema.`);
  });

  it("quitar: sus unidades salen de los totales y la foto se queda en Documentos", async () => {
    await actions.registerDelivery(LOC, { deliveredOn: TODAY, lines: [{ itemId: CREMA, received: "400" }], photos: [{ path: photoPath(1) }] });
    const [d] = h.db.rows("import_deliveries");
    // La única foto de una entrega local no se quita sola.
    const photo = h.db.rows("import_documents").find((x) => x.delivery_id === d!.id)!;
    expect((await actions.removeImportDocument(photo.id)).error).toMatch(/única foto/);
    // Un producto con entregas no se quita.
    expect((await actions.removeImportItem(CREMA)).error).toMatch(/tiene entregas/);
    const res = await actions.removeDelivery(d!.id);
    expect(res.notice).toMatch(/Entrega quitada/);
    expect(h.db.rows("import_deliveries")).toEqual([]);
    expect(h.db.rows("import_delivery_lines")).toEqual([]);
    expect(item(CREMA)).toMatchObject({ received_qty: null, damaged_qty: null });
    expect(h.db.rows("import_documents").find((x) => x.id === photo.id)).toMatchObject({ delivery_id: null });
    expect(events("recepcion").at(-1)!.note).toBe(`Entrega quitada del ${formatDmy(TODAY)}: 400 × Crema. Su foto queda en Documentos.`);
  });

  it("la recepción de antes (entrega «legacy») no se pierde: la entrega nueva se suma", async () => {
    seed({ impStatus: "en_camino_bodega", codes: false });
    h.db.rows("import_deliveries").push({ id: "legacy-1", org_id: ORG, import_id: IMP, delivered_on: "2026-11-09", note: "Recepción registrada antes de las entregas parciales (0343).", legacy: true, created_at: "2026-11-09T20:00:00Z" });
    h.db.rows("import_delivery_lines").push({ id: "ll1", org_id: ORG, import_id: IMP, delivery_id: "legacy-1", item_id: ITEM_I, received: 98, damaged: 1, note: "una caja golpeada" });
    Object.assign(item(ITEM_I), { received_qty: 98, damaged_qty: 1, reception_note: "una caja golpeada" });
    const detail = (await loadImportDetail(IMP))!;
    expect(detail.deliveries).toEqual([expect.objectContaining({ id: "legacy-1", legacy: true, lines: [expect.objectContaining({ item_id: ITEM_I, received: 98 })] })]);
    // Una importación no pide foto; los códigos que faltan no bloquean una entrega.
    const res = await actions.registerDelivery(IMP, { deliveredOn: TODAY, lines: [{ itemId: ITEM_I, received: "2" }] });
    expect(res.notice).toMatch(/pasó a Recibido/);
    expect(item(ITEM_I)).toMatchObject({ received_qty: 100, damaged_qty: 1 });
    expect(imp(IMP)).toMatchObject({ status: "recibido", arrived_on: TODAY });
  });
});

describe("«Recepción de compras» registra entregas; nada más", () => {
  it("registra una entrega con foto; no corrige, no quita, no toca dinero", async () => {
    h.perms = new Set(RECEIVE);
    expect((await actions.registerDelivery(LOC, { deliveredOn: TODAY, lines: [{ itemId: CREMA, received: "10" }], photos: [{ path: photoPath(1) }] })).error).toBeUndefined();
    const [d] = h.db.rows("import_deliveries");
    expect((await actions.updateDelivery(d!.id, { deliveredOn: TODAY, lines: [{ itemId: CREMA, received: "1" }] })).error).toMatch(/no permite editar/);
    expect((await actions.removeDelivery(d!.id)).error).toMatch(/no permite editar/);
    expect((await actions.addImportPayment(LOC, { amount: "1", paidOn: TODAY, method: "efectivo", documentId: VOUCHER })).error).toBeTruthy();
    expect((await actions.updateImportCost(COST, { kind: "importacion", amount: "114.5", currency: "PEN" })).error).toBeTruthy();
    expect((await actions.updateImportPayment(PAY, { amount: "1", paidOn: TODAY, method: "efectivo" })).error).toBeTruthy();
    expect(item(CREMA).received_qty).toBe(10);
    // Y puede agregar una foto más a su entrega.
    h.files.set(photoPath(2), { size: 100, contentType: "image/jpeg" });
    expect((await actions.registerImportDocument(LOC, { kind: "photo", path: photoPath(2), filename: "otra.jpg", deliveryId: d!.id })).notice).toBe("Foto agregada a la entrega.");
    expect(h.db.rows("import_documents").filter((x) => x.delivery_id === d!.id)).toHaveLength(2);
  });
});

describe("el comprobante de un pago local", () => {
  it("sin comprobante no se registra; con la captura adjunta, el pago queda con su documento", async () => {
    expect((await actions.addImportPayment(LOC, { amount: "1500", paidOn: TODAY, method: "transferencia" })).error).toBe(PAYMENT_VOUCHER_REQUIRED);
    expect(h.db.rows("import_payments")).toHaveLength(1);
    const path = docPath(LOC, 2, "png");
    h.files.set(path, { size: 300, contentType: "image/png" });
    const res = await actions.addImportPayment(LOC, { amount: "1500", paidOn: TODAY, method: "transferencia", voucher: { path, filename: "transferencia.png" } });
    expect(res.error).toBeUndefined();
    const doc = h.db.rows("import_documents").find((x) => x.storage_path === path)!;
    expect(doc).toMatchObject({ kind: "payment", filename: "transferencia.png" });
    expect(h.db.rows("import_payments").at(-1)).toMatchObject({ currency: "PEN", amount_pen: 1500, document_id: doc.id });
    expect(events("dinero").at(-1)!.note).toBe(`Pago registrado: S/ 1500.00 · Transferencia · ${formatDmy(TODAY)} · con comprobante.`);
    // El comprobante de un pago local no se quita mientras el pago exista.
    expect((await actions.removeImportDocument(VOUCHER)).error).toMatch(/quita primero el pago/);
  });
});

describe("«Pasar a Costos» de una compra local, sin tipo de cambio", () => {
  it("lleva el costo aterrizado en soles", async () => {
    seed({ locStatus: "recibido" });
    Object.assign(item(CREMA), { received_qty: 650, damaged_qty: 0 });
    Object.assign(item(GEL), { received_qty: 200, damaged_qty: 0 });
    const res = await actions.pushImportCosts(LOC);
    expect(res.error).toBeUndefined();
    // Crema: (4500 + 114.50 × 600/800) ÷ 650 = 7.0553… → 7.06; Gel: (800 + 28.625) ÷ 200 = 4.14.
    expect(h.db.rows("product_costs").map((r) => [r.sku, r.unit_cost, r.currency, r.batch])).toEqual([
      ["CREMA-1", 7.06, "PEN", "LOC-2026-001"],
      ["GEL-1", 4.14, "PEN", "LOC-2026-001"],
    ]);
  });
});

describe("los códigos de trazabilidad en las acciones", () => {
  it("cambiar de estado a mano los pide; cancelar y dejar una nota, no; una compra local, nunca", async () => {
    expect((await actions.setImportStatus(IMP, "pagado", "")).error).toMatch(/^Para pasar a «Pagado» faltan el código de la proforma invoice y la orden de Alibaba/);
    expect(imp(IMP).status).toBe("cotizacion");
    expect((await actions.setImportStatus(IMP, "cotizacion", "El proveedor confirma precio")).notice).toBe("Nota registrada.");
    await actions.updateImportHeader(IMP, { proformaNumber: "PI-2026-0042", platformOrder: "2045123456789" });
    expect(events("datos").at(-1)!.note).toBe("Datos actualizados: orden de Alibaba, código de la proforma.");
    expect((await actions.setImportStatus(IMP, "pagado", "")).notice).toBe("Estado: Pagado.");
    expect((await actions.setImportStatus(IMP, "en_transito", "")).error).toMatch(/falta la guía de envío/);
    expect((await actions.setImportStatus(IMP, "cancelado", "")).notice).toBe("Estado: Cancelado.");
    expect((await actions.setImportStatus(LOC, "en_transito", "")).notice).toBe("Estado: En tránsito.");
  });

  it("«Pasar a Costos» de una importación pide los tres", async () => {
    seed({ impStatus: "recibido" });
    Object.assign(item(ITEM_I), { received_qty: 100, damaged_qty: 0 });
    expect((await actions.pushImportCosts(IMP)).error).toMatch(/Faltan códigos de trazabilidad/);
    seed({ impStatus: "recibido", codes: true });
    Object.assign(item(ITEM_I), { received_qty: 100, damaged_qty: 0 });
    expect((await actions.pushImportCosts(IMP)).error).toBeUndefined();
  });

  it("aviso de posible duplicado: la misma proforma u orden de Alibaba en otra importación", async () => {
    seed({ codes: true });
    h.db.rows("imports").push({ id: "33333333-0000-4000-8000-000000000001", org_id: ORG, code: "IMP-2026-002", proforma_number: "pi-2026-0042 ", platform_order: "999" });
    const detail = (await loadImportDetail(IMP))!;
    expect(detail.traceDuplicates).toEqual({ proforma: ["IMP-2026-002"], alibaba: [] });
  });
});

describe("editar un costo y un pago (MOM §45.3)", () => {
  it("las mismas reglas que agregar, el hecho con lo que cambió y el mismo permiso", async () => {
    expect((await actions.updateImportCost(COST, { kind: "importacion", label: "AFORO FÍSICO", amount: "0", currency: "PEN" })).error).toBe("El monto debe ser mayor que 0.");
    const res = await actions.updateImportCost(COST, { kind: "importacion", label: "AFORO FÍSICO", amount: "114.50", currency: "PEN", allocation: "units" });
    expect(res.notice).toBe("Costo guardado.");
    expect(h.db.rows("import_costs").find((c) => c.id === COST)).toMatchObject({ kind: "importacion", amount_pen: 114.5, igv_treatment: "neto" });
    expect(events("dinero").at(-1)!.note).toBe("Costo «AFORO FÍSICO»: tipo Envío → Importación.");
    const before = events().length;
    expect((await actions.updateImportCost(COST, { kind: "importacion", label: "AFORO FÍSICO", amount: "114.5", currency: "PEN", allocation: "units" })).notice).toBe("Sin cambios.");
    expect(events()).toHaveLength(before);
    h.perms = new Set(["purchases.manage"]);
    expect((await actions.updateImportCost(COST, { kind: "envio", amount: "1" })).error).toMatch(/Montos de compras/);
    h.perms = new Set(ALL);
    imp(LOC).status = "cancelado";
    expect((await actions.updateImportCost(COST, { kind: "envio", amount: "1" })).error).toMatch(/cancelada/);
    expect((await actions.updateImportPayment(PAY, { amount: "1", paidOn: TODAY, method: "efectivo" })).error).toMatch(/cancelada/);
  });

  it("un pago editado conserva su comprobante; en una compra local no se puede dejar sin él", async () => {
    const res = await actions.updateImportPayment(PAY, { amount: "2100", currency: "PEN", paidOn: "2026-11-02", method: "transferencia" });
    expect(res.notice).toBe("Pago guardado.");
    expect(h.db.rows("import_payments").find((p) => p.id === PAY)).toMatchObject({ amount_pen: 2100, document_id: VOUCHER });
    expect(events("dinero").at(-1)!.note).toBe("Pago del 02/11/2026: monto S/ 2000.00 → S/ 2100.00.");
    expect((await actions.updateImportPayment(PAY, { amount: "2100", currency: "PEN", paidOn: "2026-11-02", method: "transferencia", documentId: "" })).error).toBe(PAYMENT_VOUCHER_REQUIRED);
    expect(h.db.rows("import_payments").find((p) => p.id === PAY)!.document_id).toBe(VOUCHER);
  });
});

// ---------------------------------------------------------------------------
// El fuente: la migración, las pruebas de la base, el MOM y DEPLOY.md
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("la migración 0343", () => {
  const sql = read("db/migrations/0343_compras_locales_entregas.sql");

  it("tablas nuevas solo del servidor; nada se borra (solo se reemplazan CHECK y un drop not null)", () => {
    for (const t of ["import_deliveries", "import_delivery_lines"]) expect(sql, t).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    expect(sql).toContain("revoke all on public.import_deliveries, public.import_delivery_lines from anon, authenticated;");
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/drop (table|column|index|trigger|function)/i);
    const drops = [...sql.matchAll(/^[^-\n]*\bdrop\b.*$/gim)].map((m) => m[0].trim());
    expect(drops).toEqual([
      "execute format('alter table public.imports drop constraint %I', r.conname);",
      "execute format('alter table public.imports drop constraint %I', r.conname);",
      "execute format('alter table public.import_events drop constraint %I', r.conname);",
      "alter table public.import_items alter column unit_cost_usd drop not null;",
    ]);
  });

  it("la serie por tipo, «Recibido parcial», el costo en soles, la cortesía, la proforma y el IGV con CHECK", () => {
    expect(sql).toContain("(kind = 'importacion' and code ~ '^IMP-[0-9]{4}-[0-9]{3,}$')");
    expect(sql).toContain("or (kind = 'local' and code ~ '^LOC-[0-9]{4}-[0-9]{3,}$'));");
    expect(sql.match(/'en_camino_bodega', 'recibido_parcial', 'recibido'/g)).toHaveLength(2);
    expect(sql).toContain("(unit_cost_currency = 'USD' and unit_cost_usd is not null and unit_cost_pen is null)");
    expect(sql).toContain("check (courtesy_qty between 0 and 10000000)");
    expect(sql).toContain("check (proforma_number is null or char_length(btrim(proforma_number)) between 1 and 80)");
    expect(sql).toContain("check (igv_treatment in ('neto', 'con_igv', 'inafecto'))");
    expect(sql).toContain("check ((igv_treatment = 'con_igv') = includes_igv)");
    expect(sql).toContain("check (delivery_id is null or kind = 'photo')");
    expect(sql).toContain("references public.import_deliveries (id, import_id) on delete set null (delivery_id)");
  });

  it("el backfill de la recepción de antes va antes del trigger y es idempotente", () => {
    const backfill = sql.indexOf("insert into public.import_deliveries");
    const trigger = sql.indexOf("create or replace trigger import_delivery_lines_sync");
    expect(backfill).toBeGreaterThan(0);
    expect(trigger).toBeGreaterThan(backfill);
    expect(sql).toContain("and not exists (select 1 from public.import_deliveries d where d.import_id = i.id and d.legacy)");
    expect(sql).toContain("and not exists (select 1 from public.import_delivery_lines l where l.item_id = it.id);");
    expect(sql).toContain("perform 1 from public.import_items where id = v_item for update;");
    expect(sql).not.toMatch(/security definer/i);
  });

  it("la prueba de la base corre en verify-db y DEPLOY.md lleva la 0343 arriba, antes del código", () => {
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/compras_locales_smoke.sql"');
    const deploy = read("DEPLOY.md");
    expect(deploy.indexOf("### ")).toBe(deploy.indexOf("### 14-11-2026 · Compras locales"));
    const entry = deploy.slice(0, deploy.indexOf("\n### ", 4));
    expect(entry).toContain("0343_compras_locales_entregas");
    expect(entry).toMatch(/ANTES del código/);
  });
});

describe("el MOM", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");
  const section = mom.slice(mom.indexOf("## 45. Compras: importaciones")).replace(/\s+/g, " ");

  it("compras locales, cortesía, entregas, códigos de trazabilidad, IGV y editar costos", () => {
    for (const s of [
      "### 45.12 Compras locales",
      "### 45.13 Cortesía",
      "### 45.14 Entregas parciales",
      "### 45.15 Códigos de trazabilidad",
      "| `recibido_parcial` | Recibido parcial |",
      "LOC-<año>-<NNN>",
      "Llegaron 400 de 600 (+50 cortesía) · faltan 250",
      "Inafecto a IGV",
      "«Editar»",
      "0343",
    ]) {
      expect(section, s).toContain(s);
    }
  });
});
