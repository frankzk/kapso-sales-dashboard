// El SKU que GF no tiene, al crear la guía (owner, 26-11-2026, #KP201969: «¿por qué el shampoo de cebolla de kenku.pe no
// está en GF Courier?… sí, así automatizamos»). Kapta sube ese SKU al catálogo de la tienda en GF y reintenta la guía con
// la misma clave; si no puede subirlo, el error dice por qué. Datos FICTICIOS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const createOrder = vi.fn(), productsBatch = vi.fn();
vi.mock("@/lib/gf-courier", async (orig) => ({ ...(await orig<typeof import("@/lib/gf-courier")>()), gfCourier: { createOrder, productsBatch } }));
vi.mock("@/lib/crypto", () => ({ decryptOrNull: (v: string | null) => (v ? "tok" : null) }));
vi.mock("@/lib/env", () => ({ env: { gfCourierWriteEnabled: () => true } }));
vi.mock("@/lib/salida-activa-server", () => ({ SALIDA_ACTIVA_COLUMNS: "id", withLastCourierChange: async (_a: unknown, _o: string, rows: unknown[]) => rows }));
const writeCourierGuide = vi.fn(async () => ({ id: "ship-1" }));
vi.mock("@/lib/route-output-fill", () => ({ writeCourierGuide }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: async () => undefined }));

const { createGfGuideFor } = await import("@/lib/gf-courier-guide");
const { gfMissingSkus, gfSkuNotFound, gfSkuUploadItem } = await import("@/lib/gf-courier-catalog");

const ORDER = "33333333-3333-4333-8333-333333333333";
const SKU = "453375647";
const NOT_FOUND = { ok: false, status: 422, timedOut: false,
  error: { code: "SKU_NOT_FOUND", field: "items.0.sku", message: `El SKU ${SKU} no está en el catálogo de GF de esta tienda.` } };
const CREATED = { ok: true, data: { tracking_id: "KENKU-KP900002", external_id: "#KP900002", shipping_cost: 10, estimated_delivery_date: "2026-11-27", label_url: null } };

/** Supabase de mentira: cada tabla responde lo mínimo que lee la creación, y guarda lo que se escribe. */
function fakeAdmin() {
  const writes: { table: string; op: string; row: any }[] = [];
  const reads: Record<string, any> = {
    order_master: { store_id: "store-1", order_id: ORDER, order_name: "#KP900002", customer_name: "Clienta Ficticia", customer_phone: "999999999",
      district: "Miraflores", address: "Av. Ficticia 123", reference: null, order_total: 59, dispatch_scheduled_on: null },
    stores: { id: "store-1", gf_courier_enabled: true, gf_courier_api_token_enc: "enc", gf_courier_webhook_secret_enc: null },
    orders: { name: "#KP900002", raw: {}, financial_status: "pending", payment_gateway: "cod", total_refunded: 0,
      line_items: [{ sku: SKU, title: "Shampoo de Cebolla REBROTA", variant_title: null, quantity: 1, price: 59 }] },
  };
  const from = (table: string) => {
    let op = "select", row: any = null;
    const q: any = {
      select: () => q, eq: () => q, neq: () => q, in: () => q, is: () => q, not: () => q, order: () => q, limit: () => q,
      insert: (r: any) => { op = "insert"; row = r; writes.push({ table, op, row: r }); return q; },
      update: (r: any) => { op = "update"; row = r; writes.push({ table, op, row: r }); return q; },
      maybeSingle: async () => ({ data: op === "select" ? reads[table] ?? null : null, error: null }),
      single: async () => ({ data: op === "insert" ? { id: "intent-1" } : reads[table] ?? null, error: null }),
      then: (resolve: (v: any) => void) => resolve({ data: op === "update" ? [{ id: "intent-1" }] : [], error: null, row }),
    };
    return q;
  };
  return { admin: { from } as any, writes };
}

describe("SKU que GF no tiene al crear la guía", () => {
  beforeEach(() => { createOrder.mockReset(); productsBatch.mockReset(); writeCourierGuide.mockClear(); });

  it("Kapta lo sube a su catálogo y reintenta la guía con la misma clave", async () => {
    createOrder.mockResolvedValueOnce(NOT_FOUND).mockResolvedValueOnce(CREATED);
    productsBatch.mockResolvedValue({ ok: true, data: { results: [{ sku: SKU, status: "created" }] } });
    const { admin, writes } = fakeAdmin();
    const r = await createGfGuideFor(ORDER, { userId: null }, admin);
    expect(r).toMatchObject({ ok: true, trackingId: "KENKU-KP900002" });
    expect(productsBatch).toHaveBeenCalledTimes(1);
    const [opts, items, key] = productsBatch.mock.calls[0]!;
    expect(opts).toMatchObject({ apiToken: "tok" });
    expect(items).toEqual([{ sku: SKU, name: "Shampoo de Cebolla REBROTA", sales_status: "IN_STOCK" }]);
    expect(String(key)).toMatch(/^KP-SKU-[0-9a-f]{40}$/);
    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(createOrder.mock.calls[1]![2]).toBe(createOrder.mock.calls[0]![2]);
    const event = writes.find((w) => w.table === "order_events")!;
    expect(event.row.payload.gf_catalog_uploaded).toEqual([SKU]);
  });

  it("sin el permiso para subirlo, no reintenta y el error lo explica", async () => {
    createOrder.mockResolvedValue(NOT_FOUND);
    productsBatch.mockResolvedValue({ ok: false, status: 403, timedOut: false, error: { code: "FORBIDDEN", message: "Sin permiso." } });
    const { admin, writes } = fakeAdmin();
    const r = await createGfGuideFor(ORDER, { userId: null }, admin);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(new RegExp(`El SKU ${SKU} no está.*Kapta intentó subir el SKU ${SKU} al catálogo de GF y no pudo: .*catalogue:write`));
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(writeCourierGuide).not.toHaveBeenCalled();
    const failed = writes.find((w) => w.table === "gf_order_requests" && w.row.status === "failed")!;
    expect(failed.row.error_code).toBe("SKU_NOT_FOUND");
    expect(failed.row.response.catalog_upload_error).toMatch(/catalogue:write/);
  });

  it("otro error de GF no sube nada", async () => {
    createOrder.mockResolvedValue({ ok: false, status: 422, timedOut: false, error: { code: "DISTRICT_NOT_COVERED", message: "Sin cobertura." } });
    const { admin } = fakeAdmin();
    const r = await createGfGuideFor(ORDER, { userId: null }, admin);
    expect(r).toMatchObject({ ok: false, error: "Sin cobertura." });
    expect(productsBatch).not.toHaveBeenCalled();
  });
});

describe("piezas puras", () => {
  it("qué SKU señala el error de GF", () => {
    const items = [{ sku: "A-1" }, { sku: "B-2" }];
    expect(gfSkuNotFound({ code: "SKU_NOT_FOUND", field: "items.1.sku", message: "x" }, items)).toBe("B-2");
    expect(gfSkuNotFound({ code: "SKU_NOT_FOUND", message: "El SKU Z-9 no está en el catálogo de GF de esta tienda." }, items)).toBe("Z-9");
    expect(gfSkuNotFound({ code: "OUT_OF_STOCK", field: "items.0.sku", message: "x" }, items)).toBeNull();
  });
  it("el producto que se sube lleva el nombre de la línea como la sincronización («título – variante»)", () => {
    expect(gfSkuUploadItem(" S-1 ", { title: "Faja", variantTitle: "M" })).toEqual({ sku: "S-1", name: "Faja – M", sales_status: "IN_STOCK" });
    expect(gfSkuUploadItem("S-2", null)).toEqual({ sku: "S-2", name: "S-2", sales_status: "IN_STOCK" });
  });
  it("qué SKU del pedido faltan en GF, sin distinguir mayúsculas y sin repetir", () => {
    expect(gfMissingSkus(["a-1", "B-2", "b-2", " "], [{ merchant_sku: "A-1", name: "A" }])).toEqual(["B-2"]);
  });
});

describe("la sincronización de cada hora deja su resultado", () => {
  const cron = readFileSync(join(process.cwd(), "app/api/cron/gf-catalog-sync/route.ts"), "utf8");
  const server = readFileSync(join(process.cwd(), "lib/gf-catalog-sync-server.ts"), "utf8");
  const actions = readFileSync(join(process.cwd(), "app/dashboard/[storeId]/settings/actions.ts"), "utf8");
  it("en sync_state (fuente gf_catalog) y en el log, desde el cron y desde «Sincronizar ahora»", () => {
    expect(server).toContain('export const GF_CATALOG_SYNC_SOURCE = "gf_catalog";');
    expect(server).toContain('{ onConflict: "store_id,source" }');
    expect(cron).toContain("await recordGfCatalogSync(admin, report);");
    expect(cron).toContain("(report.ok ? console.log : console.warn)(`[gf-catalog-sync]");
    expect(actions).toContain("await recordGfCatalogSync(ctx.admin, report);");
  });
});
