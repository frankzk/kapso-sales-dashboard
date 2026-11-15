// «Compras»: cada costo y cada pago en su moneda, e «Incluye IGV» (0342, MOM
// §45.3), del lado del servidor:
//   - Las acciones guardan el monto en la columna de SU moneda, sin convertir, y
//     con «Incluye IGV» el monto con IGV y lo que entra al costo; el historial
//     lo dice con su moneda.
//   - Las lecturas normalizan (una fila sin moneda, de antes, es USD).
//   - «Pasar a Costos» lleva los soles tal cual.
//   - «Leer con IA» guarda en soles los cargos en soles y nunca agrega el IGV.
//   - El Excel: cada monto en su moneda, el IGV y «Falta el tipo de cambio».
//   - La 0342 (fuente), su smoke en verify-db.sh, el MOM y DEPLOY.md.
// La API de Anthropic NUNCA se llama: `fetch` está simulado.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  files: new Map<string, { size: number; contentType: string }>(),
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
    rpc: async (n: string, a: unknown) => {
      h.db.rpcCalls.push({ name: n, args: a });
      return { data: [], error: null };
    },
    storage: {
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({
        info: async (path: string) => {
          const f = h.files.get(path);
          return f ? { data: f, error: null } : { data: null, error: { message: "not found" } };
        },
        remove: async () => ({ data: null, error: null }),
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
import {
  addAiProposalRows,
  addImportCost,
  addImportPayment,
  pushImportCosts,
  readImportDocumentWithAi,
  removeImportCost,
  removeImportPayment,
} from "@/app/dashboard/compras/actions";
import { loadImportDetail, loadImportList, loadReportImports } from "@/lib/compras-server";
import { buildImportWorkbook } from "@/lib/exports/compras-importacion";

const ORG = "11111111-1111-4111-8111-111111111111";
const IMP = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "33333333-3333-4333-8333-33333333333a";
const ITEM_B = "33333333-3333-4333-8333-33333333333b";
const DOC = "99999999-9999-4999-8999-99999999999a";
const C1 = "77777777-7777-4777-8777-7777777777c1";
const C2 = "77777777-7777-4777-8777-7777777777c2";
const P1 = "88888888-8888-4888-8888-8888888888d1";
const P2 = "88888888-8888-4888-8888-8888888888d2";
const ALL = ["purchases.manage", "purchases.money", "costs.manage"];

function seed(overrides: { fx?: number | null; status?: string } = {}) {
  h.db = new FakeDb({
    stores: [],
    import_suppliers: [],
    imports: [
      {
        id: IMP,
        org_id: ORG,
        code: "IMP-2026-007",
        supplier_id: null,
        status: overrides.status ?? "en_aduana",
        arrived_on: "2026-11-12",
        ordered_on: "2026-11-01",
        fx_pen_per_usd: overrides.fx === undefined ? 3.75 : overrides.fx,
        transport: "courier",
        // Los tres códigos de trazabilidad (MOM §45.15): «Pasar a Costos» los pide.
        proforma_number: "PI-7",
        platform_order: "2045000007",
        tracking_number: "DHL7",
        created_at: "2026-11-01T15:00:00Z",
      },
    ],
    import_items: [
      { id: ITEM_A, org_id: ORG, import_id: IMP, store_id: null, sku: "SKU-A", name: "A", qty: 100, unit_cost_usd: 2, unit_weight_kg: 0.5, sale_price_pen: 20, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 1 },
      { id: ITEM_B, org_id: ORG, import_id: IMP, store_id: null, sku: "SKU-B", name: "B", qty: 50, unit_cost_usd: 12, unit_weight_kg: 0.2, sale_price_pen: 60, received_qty: null, damaged_qty: null, cost_pushed_at: null, position: 2 },
    ],
    // c1: una fila de antes de la 0342 (sin moneda). c2: en soles, con IGV.
    import_costs: [
      { id: C1, org_id: ORG, import_id: IMP, kind: "envio", label: "Flete", amount_usd: 120, allocation: "weight", item_id: null, created_at: "2026-11-02T10:00:00Z" },
      {
        id: C2,
        org_id: ORG,
        import_id: IMP,
        kind: "importacion",
        label: "DHL Express Perú",
        currency: "PEN",
        amount_usd: null,
        amount_pen: 427.25,
        includes_igv: true,
        gross_amount: 504.16,
        allocation: "value",
        item_id: null,
        created_at: "2026-11-03T10:00:00Z",
      },
    ],
    import_payments: [
      { id: P1, org_id: ORG, import_id: IMP, amount_usd: 500, paid_on: "2026-11-02", method: "transferencia", note: null, document_id: null, created_at: "2026-11-02T10:00:00Z" },
      { id: P2, org_id: ORG, import_id: IMP, currency: "PEN", amount_usd: null, amount_pen: 504.16, paid_on: "2026-11-14", method: "transferencia", note: "DHL", document_id: null, created_at: "2026-11-14T10:00:00Z" },
    ],
    import_documents: [
      { id: DOC, org_id: ORG, import_id: IMP, kind: "invoice", storage_path: `${ORG}/${IMP}/docs/dhl.pdf`, filename: "dhl.pdf", mime: "application/pdf", size_bytes: 2048, created_at: "2026-11-14T10:00:00Z" },
    ],
    import_events: [],
    product_costs: [],
  });
  h.files = new Map([[`${ORG}/${IMP}/docs/dhl.pdf`, { size: 2048, contentType: "application/pdf" }]]);
}

const events = (kind?: string) => h.db.rows("import_events").filter((e) => !kind || e.kind === kind);

beforeEach(() => {
  h.perms = new Set(ALL);
  seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("costos y pagos en su moneda", () => {
  it("un costo en soles con «Incluye IGV»: el monto con IGV y lo que entra, en soles, sin convertir", async () => {
    const res = await addImportCost(IMP, { kind: "importacion", label: "Nacionalización", amount: "504.16", currency: "PEN", includesIgv: true, allocation: "value" });
    expect(res).toEqual({ notice: "Costo agregado." });
    const row = h.db.rows("import_costs").at(-1)!;
    expect(row).toMatchObject({ currency: "PEN", amount_usd: null, amount_pen: 427.25, includes_igv: true, gross_amount: 504.16, allocation: "value", org_id: ORG });
    expect(events("dinero").at(-1)!.note).toBe("Costo agregado: Importación · Nacionalización · S/ 504.16 con IGV → S/ 427.25 sin IGV · por valor.");
  });

  it("un costo en USD sin la casilla, como siempre", async () => {
    await addImportCost(IMP, { kind: "envio", label: "Courier", amount: "20.07", currency: "USD", allocation: "units" });
    expect(h.db.rows("import_costs").at(-1)).toMatchObject({ currency: "USD", amount_usd: 20.07, amount_pen: null, includes_igv: false, gross_amount: null });
    expect(events("dinero").at(-1)!.note).toBe("Costo agregado: Envío · Courier · US$ 20.07 · por unidades.");
  });

  it("un pago en soles se guarda en soles; quitarlo y quitar un costo lo dicen con su moneda", async () => {
    await addImportPayment(IMP, { amount: "427.25", currency: "PEN", paidOn: "2026-11-14", method: "transferencia" });
    expect(h.db.rows("import_payments").at(-1)).toMatchObject({ currency: "PEN", amount_usd: null, amount_pen: 427.25 });
    expect(events("dinero").at(-1)!.note).toBe("Pago registrado: S/ 427.25 · Transferencia · 14/11/2026.");
    expect((await removeImportPayment(P2)).error).toBeUndefined();
    expect(events("dinero").at(-1)!.note).toBe("Pago quitado: S/ 504.16 del 14/11/2026.");
    expect((await removeImportCost(C2)).error).toBeUndefined();
    expect(events("dinero").at(-1)!.note).toBe("Costo quitado: DHL Express Perú · S/ 504.16 con IGV → S/ 427.25 sin IGV.");
    expect((await removeImportCost(C1)).error).toBeUndefined();
    expect(events("dinero").at(-1)!.note).toBe("Costo quitado: Flete · US$ 120.00.");
  });

  it("una moneda que no es USD ni soles no se guarda", async () => {
    expect((await addImportCost(IMP, { kind: "envio", amount: "5", currency: "CNY" })).error).toBe("Moneda inválida: US$ o S/.");
    expect((await addImportPayment(IMP, { amount: "5", currency: "EUR", paidOn: "2026-11-01", method: "otro" })).error).toBe("Moneda inválida: US$ o S/.");
    expect(h.db.opsOn("import_costs", "insert")).toEqual([]);
    expect(h.db.opsOn("import_payments", "insert")).toEqual([]);
  });
});

describe("las lecturas", () => {
  it("el detalle: cada costo y cada pago con su moneda y su monto; una fila de antes es USD", async () => {
    const d = (await loadImportDetail(IMP))!;
    expect(d.costs!.map((c) => [c.id, c.currency, c.amount, c.includes_igv, c.gross_amount])).toEqual([
      [C1, "USD", 120, false, null],
      [C2, "PEN", 427.25, true, 504.16],
    ]);
    expect(d.payments!.map((p) => [p.id, p.currency, p.amount])).toEqual([
      [P1, "USD", 500],
      [P2, "PEN", 504.16],
    ]);
    for (const op of h.db.opsOn("import_costs", "select")) expect(op.cols).toMatch(/currency,amount_usd,amount_pen,includes_igv,gross_amount/);
  });

  it("la lista: el total en USD con el tipo de cambio de la importación; sin él, null", async () => {
    const [row] = await loadImportList(ORG, true);
    // 800 del proveedor + 120 + 427,25 ÷ 3,75; pagado 500 + 504,16 ÷ 3,75.
    expect(row!.money!.total).toEqual({ usd: 920, pen: 427.25 });
    expect(row!.money!.totalUsd).toBeCloseTo(920 + 427.25 / 3.75, 9);
    expect(row!.money!.paidUsd).toBeCloseTo(500 + 504.16 / 3.75, 9);
    seed({ fx: null });
    const [noFx] = await loadImportList(ORG, true);
    expect(noFx!.money!.totalUsd).toBeNull();
    expect(noFx!.money!.pendingUsd).toBeNull();
  });

  it("los reportes: cada costo y cada pago con su moneda", async () => {
    const [r] = await loadReportImports(ORG, true);
    expect(r!.costs.map((c) => [c.currency, c.amount])).toEqual([
      ["USD", 120],
      ["PEN", 427.25],
    ]);
    expect(r!.payments).toEqual([
      { amount: 500, currency: "USD", paidOn: "2026-11-02" },
      { amount: 504.16, currency: "PEN", paidOn: "2026-11-14" },
    ]);
  });
});

describe("«Pasar a Costos» con costos en soles", () => {
  beforeEach(() => {
    seed({ status: "recibido" });
    // Solo un costo en soles por valor: A lleva ¼ y B ¾.
    h.db.tables.import_costs = [
      { id: "c9", org_id: ORG, import_id: IMP, kind: "importacion", label: "Aduana", currency: "PEN", amount_usd: null, amount_pen: 800, includes_igv: false, gross_amount: null, allocation: "value", item_id: null },
    ];
    for (const r of h.db.rows("import_items")) {
      r.received_qty = r.qty;
      r.damaged_qty = 0;
    }
  });

  it("los soles entran tal cual: A = (200 × 3,75 + 200) ÷ 100 y B = (600 × 3,75 + 600) ÷ 50", async () => {
    const res = await pushImportCosts(IMP);
    expect(res.error).toBeUndefined();
    expect(h.db.rows("product_costs").map((r) => [r.sku, r.unit_cost, r.currency])).toEqual([
      ["SKU-A", 9.5, "PEN"],
      ["SKU-B", 57, "PEN"],
    ]);
  });

  it("sin tipo de cambio, no pasa", async () => {
    h.db.rows("imports")[0]!.fx_pen_per_usd = null;
    expect((await pushImportCosts(IMP)).error).toMatch(/tipo de cambio/);
    expect(h.db.rows("product_costs")).toEqual([]);
  });
});

describe("«Leer con IA»: la factura de DHL en soles", () => {
  const AI_INPUT = {
    currency: "PEN",
    igv: 76.91,
    igv_currency: "PEN",
    lines: [],
    charges: [
      { kind: "importacion", label: "Gastos de nacionalización", amount: 37.6, currency: "PEN" },
      { kind: "importacion", label: "Aforo físico", amount: 114.5, currency: "PEN" },
      { kind: "importacion", label: "Rectificación de la declaración aduanera", amount: 189.7, currency: "PEN" },
      { kind: "importacion", label: "Cargo por aranceles e impuestos pagados", amount: 85.45, currency: "PEN" },
    ],
  };
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "registrar_documento", input: AI_INPUT }] }), { status: 200 }),
  );

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("la propuesta trae los cargos en soles y el IGV aparte; sin «Montos», ni el IGV", async () => {
    const res = await readImportDocumentWithAi(DOC);
    if ("error" in res) throw new Error(res.error);
    expect(res.charges.map((c) => c.currency)).toEqual(["PEN", "PEN", "PEN", "PEN"]);
    expect(res.igv).toEqual({ amount: 76.91, currency: "PEN" });
    h.perms = new Set(["purchases.manage"]);
    const stripped = await readImportDocumentWithAi(DOC);
    if ("error" in stripped) throw new Error(stripped.error);
    expect(stripped.igv).toBeNull();
    expect(JSON.stringify(stripped)).not.toMatch(/76\.91/);
  });

  it("«Agregar seleccionados» guarda los cargos en soles, sin convertir, y ningún IGV", async () => {
    const res = await addAiProposalRows(IMP, {
      documentId: DOC,
      currency: "PEN",
      fx: "",
      lines: [],
      charges: AI_INPUT.charges.map((c) => ({ ...c, amount: String(c.amount), allocation: "value" })),
    });
    expect(res).toEqual({ notice: "Agregados 0 productos y 4 cargos." });
    const added = h.db.rows("import_costs").filter((c) => c.id !== C1 && c.id !== C2);
    expect(added.map((c) => [c.currency, c.amount_usd, c.amount_pen, c.includes_igv])).toEqual([
      ["PEN", null, 37.6, false],
      ["PEN", null, 114.5, false],
      ["PEN", null, 189.7, false],
      ["PEN", null, 85.45, false],
    ]);
    expect(added.reduce((a, c) => a + Number(c.amount_pen), 0)).toBeCloseTo(427.25, 10);
    expect(events("dinero").at(-1)!.note).toBe("Costo agregado: Importación · Cargo por aranceles e impuestos pagados · S/ 85.45 · por valor.");
  });
});

describe("el Excel con montos en soles (MOM §45.9)", () => {
  async function workbook(): Promise<ExcelJS.Workbook> {
    const detail = (await loadImportDetail(IMP))!;
    const buf = await buildImportWorkbook(detail, { storeNames: new Map(), now: new Date("2026-11-14T15:00:00Z") });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    return wb;
  }
  const headers = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1).map(String);
  const cell = (ws: ExcelJS.Worksheet, row: number, name: string) => ws.getRow(row).getCell(headers(ws).indexOf(name) + 1).value;
  const kv = (ws: ExcelJS.Worksheet, key: string) => {
    let out: unknown;
    ws.eachRow((r) => {
      if (r.getCell(1).value === key) out = r.getCell(2).value;
    });
    return out;
  };

  it("cada costo y cada pago en su moneda, el IGV con los dos montos y su equivalente", async () => {
    const wb = await workbook();
    const costs = wb.getWorksheet("Costos")!;
    expect(cell(costs, 3, "Moneda")).toBe("S/");
    expect(cell(costs, 3, "Monto (sin IGV)")).toBe(427.25);
    expect(cell(costs, 3, "Incluye IGV")).toBe("Sí");
    expect(cell(costs, 3, "Monto con IGV")).toBe(504.16);
    expect(cell(costs, 3, "Detalle")).toBe("S/ 504.16 con IGV → S/ 427.25 sin IGV");
    expect(cell(costs, 3, "En USD")).toBe(113.93);
    expect(cell(costs, 3, "En S/")).toBe(427.25);
    expect(cell(costs, 2, "En S/")).toBe(450);
    const pays = wb.getWorksheet("Pagos")!;
    expect(cell(pays, 3, "Moneda")).toBe("S/");
    expect(cell(pays, 3, "En USD")).toBe(134.44);
    const head = wb.getWorksheet("Importación")!;
    expect(kv(head, "Costos repartidos en S/")).toBe(427.25);
    expect(kv(head, "Costo total (USD)")).toBe(1033.93);
    // En soles: 920 × 3,75 + 427,25, los soles tal cual.
    expect(kv(head, "Costo total (S/)")).toBe(3877.25);
  });

  it("sin tipo de cambio: «Falta el tipo de cambio» en lo que hay que convertir", async () => {
    seed({ fx: null });
    const wb = await workbook();
    const head = wb.getWorksheet("Importación")!;
    expect(kv(head, "Costo total (USD)")).toBe("Falta el tipo de cambio");
    expect(kv(head, "Costo total (S/)")).toBe("Falta el tipo de cambio");
    expect(kv(head, "Falta pagar (USD)")).toBe("Falta el tipo de cambio");
    // Lo de cada moneda, sin convertir, sí.
    expect(kv(head, "Costos repartidos en USD")).toBe(120);
    expect(kv(head, "Costos repartidos en S/")).toBe(427.25);
    const products = wb.getWorksheet("Productos")!;
    expect(cell(products, 2, "Costo aterrizado por unidad (USD)")).toBe("Falta el tipo de cambio");
    expect(cell(products, 2, "Costo aterrizado por unidad (S/)")).toBe("Falta el tipo de cambio");
    expect(cell(products, 2, "Margen por unidad (S/)")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lo que se comprueba leyendo el fuente
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("la migración 0342", () => {
  const sql = read("db/migrations/0342_compras_monedas_igv.sql");

  it("moneda por costo y por pago con CHECK, un monto por moneda, «Incluye IGV» y su monto con IGV", () => {
    for (const t of ["import_costs", "import_payments"]) {
      expect(sql).toContain(`constraint ${t}_currency_ck check (currency in ('USD', 'PEN'))`);
      expect(sql).toContain(`constraint ${t}_amount_pen_pos check (amount_pen is null or amount_pen > 0)`);
      expect(sql).toContain(`alter table public.${t} alter column amount_usd drop not null;`);
      expect(sql).toContain(`add constraint ${t}_amount_currency_ck check (`);
    }
    expect(sql.match(/add column if not exists currency text not null default 'USD'/g)).toHaveLength(2);
    expect(sql).toContain("(currency = 'USD' and amount_usd is not null and amount_pen is null)");
    expect(sql).toContain("or (currency = 'PEN' and amount_pen is not null and amount_usd is null)");
    expect(sql).toContain("add column if not exists includes_igv boolean not null default false");
    expect(sql).toContain("add column if not exists gross_amount numeric(14, 2)");
    expect(sql).toContain("(includes_igv and gross_amount is not null and gross_amount >= coalesce(amount_usd, amount_pen))");
    expect(sql).toContain("or (not includes_igv and gross_amount is null)");
  });

  it("sin drop suelto, sin políticas, idempotente y solo del servidor; el porqué en la cabecera", () => {
    expect(sql).not.toMatch(/^\s*drop\s/im);
    expect(sql).not.toMatch(/drop (table|column|constraint)/i);
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/^\s*(update|delete)\s/im);
    expect(sql.match(/if not exists \(\s*select 1 from pg_constraint/g)).toHaveLength(3);
    expect(sql).toContain("revoke all on public.import_costs, public.import_payments from anon, authenticated;");
    expect(sql).toContain("grant all privileges on public.import_costs, public.import_payments to service_role;");
    // La cabecera, sin los «--» de cada renglón.
    const header = sql.replace(/\s*\n--\s*/g, " ");
    for (const s of ["EL DISEÑO", "sin backfill", "504.16", "÷ 1,18", "drop not null"]) expect(header, s).toContain(s);
  });

  it("su smoke corre en verify-db.sh y va al bundle", () => {
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/compras_monedas_smoke.sql"');
    const smoke = read("scripts/sql/compras_monedas_smoke.sql");
    expect(smoke).toContain("\\ir ../../db/migrations/0342_compras_monedas_igv.sql");
    expect(smoke).toContain("rollback;");
    expect(read("db/apply_bundled.sql")).toContain("0342_compras_monedas_igv");
  });
});

describe("el código", () => {
  it("las pantallas y el Excel usan las dos vistas y dicen «Falta el tipo de cambio»", () => {
    const detail = read("components/compras/import-detail.tsx");
    expect(detail).toContain("landedCosts(items.map(landedItemOf), (detail.costs ?? []).map(landedCostOf), fx)");
    expect(detail).toContain("MISSING_FX");
    expect(detail).toContain("IGV_HELP");
    expect(detail).toContain("CURRENCIES.map((c) =>");
    // 0343: el IGV es un selector (neto, con IGV, inafecto) y el mismo formulario edita.
    expect(detail).toContain("addImportCost(detail.imp.id, { kind, label, amount, currency, igvTreatment, allocation, itemId })");
    expect(detail).toContain("updateImportCost(cost.id, { kind, label, amount, currency, igvTreatment, allocation, itemId })");
    // 0343: el comprobante se puede adjuntar en el mismo formulario (`voucher`).
    expect(detail).toContain("addImportPayment(detail.imp.id, { amount, currency, paidOn, method, note, documentId: uploaded ? \"\" : documentId, voucher: uploaded })");
    expect(read("lib/exports/compras-importacion.ts")).toContain("MISSING_FX");
    expect(read("components/compras/reports-view.tsx")).toContain("importsMissingFxForUsd(imports)");
    // «Pasar a Costos» con el tipo de cambio de la importación (la vista en soles).
    expect(read("app/dashboard/compras/actions.ts")).toContain("a.imp.fx_pen_per_usd ?? null,");
    expect(read("lib/compras.ts")).toContain("unitCostPen: round2(line.pen.unitCost)");
  });

  it("la propuesta de la IA muestra el IGV como dato y manda la moneda de cada cargo", () => {
    const ui = read("components/compras/ai-proposal.tsx");
    expect(ui).toContain("currency: chargeCur(c)");
    expect(ui).toContain("IGV del documento");
    expect(ui).toContain("No se agrega como");
  });
});

describe("el MOM y DEPLOY.md", () => {
  it("§45 tiene las reglas de monedas, IGV, IA y saldo", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const section = mom.slice(mom.indexOf("## 45. Compras: importaciones")).replace(/\s+/g, " ");
    for (const s of [
      "0342",
      "su propia moneda",
      "Falta el tipo de cambio",
      "Incluye IGV",
      "504.16",
      "427.25",
      "IGV_RATE",
      // 0343: la casilla pasó a un selector de tres opciones (neto, con IGV, inafecto).
      "Las líneas de la factura ya suelen venir sin IGV. Elige «Incluye IGV» solo si cargas el total con IGV, e «Inafecto» para lo que no lleva IGV, como el flete internacional.",
      "nunca se agrega como costo",
      "sin ida y vuelta",
    ]) {
      expect(section, s).toContain(s);
    }
  });

  it("DEPLOY.md: la entrada de la 0342, antes que el código", () => {
    const deploy = read("DEPLOY.md");
    // Por su título: la de la 0343 va encima.
    const first = deploy.indexOf("### 14-11-2026 · Compras: cada costo y cada pago en su moneda");
    const entry = deploy.slice(first, deploy.indexOf("\n### ", first + 4));
    expect(entry).toContain("0342_compras_monedas_igv");
    expect(entry).toMatch(/antes del código/i);
  });
});
