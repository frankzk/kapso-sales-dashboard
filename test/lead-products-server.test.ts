import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/woocommerce-orders", () => ({ loadStoreOrderPlatform: vi.fn(async () => ({ ok: true, platform: "shopify" })), wooSaleClient: vi.fn() }));
vi.mock("@/lib/woocommerce", () => ({ wooGetPage: vi.fn() }));
vi.mock("@/lib/woocommerce-intake", () => ({ withWooAuthFallback: vi.fn() }));
import { backfillLeadProducts, saveCustomerProducts, withProductOpeners, markProductConversationAttempt, repairSevenProductNames } from "@/lib/lead-products-server";
import { readFileSync } from "node:fs";

const products = [{ handle: "astaxantina", title: "Astaxantina – Antioxidante" }];
function client(data: Record<string, unknown[]>, error: string | null = null) {
  const calls: { table: string; filters: unknown[] }[] = [];
  const rpc = vi.fn(async () => ({ error: null }));
  return { rpc, calls, admin: { rpc, from(table: string) {
    const call = { table, filters: [] as unknown[] }; calls.push(call);
    const builder = { select: () => builder, in: (...args: unknown[]) => { call.filters.push(args); return builder; }, update: (patch: unknown) => { call.filters.push({ patch }); return builder; }, eq: (...args: unknown[]) => { call.filters.push(args); return builder; },
      is: (...args: unknown[]) => { call.filters.push(args); return builder; }, gt: (...args: unknown[]) => { call.filters.push(args); return builder; }, upsert: (value: unknown) => { call.filters.push({ upsert: value }); return builder; }, order: () => builder, limit: () => builder, range: () => builder,
      maybeSingle: async () => ({ data: data[table]?.[0] ?? null, error }),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: data[table] ?? [], error }).then(resolve); } };
    return builder;
  } } as unknown as SupabaseClient };
}
describe("persistencia e historial de producto", () => {
  it("repara únicamente los IDs de la cohorte, sin cambiar estado ni interés posterior", async () => {
    const ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"];
    const cat = [{ handle: "restpro", title: "RestPro: Almohada de Tracción Inversa" }];
    const rows = [
      { id: ids[0], first_seen_at: "2026-01-01", first_inbound_text: "Quiero RestPro", category: "lost" },
      { id: ids[1], entry_product: { handle: "already-known" } },
      { id: ids[2], first_seen_at: "2026-01-01", first_inbound_text: "Hola" },
    ];
    const c = client({ sync_state: [{ cursor: JSON.stringify({ ids }) }], leads: rows });
    expect(await repairSevenProductNames(c.admin, "store", cat)).toMatchObject({ targeted: 3, repaired: 1, already_identified: 1, unresolved: 1, complete: false });
    expect(c.rpc).toHaveBeenCalledWith("record_lead_product_openers_v2", { p_store_id: "store", p_rows: [{ id: ids[0], entry: expect.objectContaining({ handle: "restpro" }), signals: [] }] });
    expect(c.calls.find(x => x.table === "leads")!.filters).toEqual([["store_id", "store"], ["id", ids]]);
    expect(c.calls.flatMap(x => x.filters).some(x => !!x && typeof x === "object" && "patch" in x)).toBe(false);
    c.rpc.mockClear();
    c.rpc.mockResolvedValueOnce({ error: { message: "offline" } } as never);
    await expect(repairSevenProductNames(c.admin, "store", cat)).rejects.toThrow("Repair batch failed");
  });
  it("sin cohorte de reparación no escanea ni modifica leads", async () => {
    const c = client({});
    await expect(repairSevenProductNames(c.admin, "store", products)).rejects.toThrow("Repair cohort unavailable");
    expect(c.calls.some(x => x.table === "leads")).toBe(false);
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("los intentos sin producto ceden el turno sin escribir evidencia ni tocar otras tiendas", async () => {
    const c = client({});
    await markProductConversationAttempt(c.admin, "store-A", "empty-conversation");
    expect(c.calls).toEqual([{ table: "leads", filters: [
      { patch: { product_conversation_checked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } },
      ["store_id", "store-A"], ["kapso_conversation_id", "empty-conversation"],
    ] }]);
    expect(c.rpc).not.toHaveBeenCalled();
    await expect(markProductConversationAttempt(client({}, "offline").admin, "store-A", "empty-conversation")).rejects.toThrow();
  });
  it("el bucle registra el intento antes de saltarse una conversación vacía o ilegible", () => {
    const source = readFileSync("lib/leads-ingest.ts", "utf8");
    const start = source.indexOf("stats.candidates += 1;", source.indexOf("async function enrichLeadsFromConversations"));
    const block = source.slice(start, source.indexOf("stats.fetched += 1;", start));
    expect(block.indexOf("markProductConversationAttempt(admin, storeId, convId)")).toBeGreaterThan(-1);
    expect(block.indexOf("markProductConversationAttempt(admin, storeId, convId)")).toBeLessThan(block.indexOf("if (!sig) continue;"));
    expect(block).not.toContain("sig.product_messages");
  });
  it("rellena solo entrada histórica; no reemplaza interés actual con un opener antiguo", async () => {
    const c = client({ leads: [{ id: "lead", first_inbound_text: "Quiero astaxantina", first_seen_at: "2026-01-01" }] });
    expect(await backfillLeadProducts(c.admin, "store", products, 500)).toEqual({ checked: 1, identified: 1 });
    expect(c.rpc).toHaveBeenCalledWith("record_lead_product_openers_v2", { p_store_id: "store", p_rows: [{ id: "lead", entry: expect.objectContaining({ handle: "astaxantina" }), signals: [] }] });
    expect(c.calls[0]!.filters).toContainEqual(["store_id", "store"]);
  });
  it("sin catálogo no marca progreso; un error de lectura no se da por terminado", async () => {
    const c = client({});
    await backfillLeadProducts(c.admin, "store", []);
    expect(c.rpc).not.toHaveBeenCalled(); expect(c.calls).toHaveLength(0);
    await expect(backfillLeadProducts(client({}, "offline").admin, "store", products)).rejects.toThrow();
  });
  it("envía evidencia cliente y conserva entrada, tienda y conversación", async () => {
    const c = client({ leads: [{ first_inbound_text: "Hola", first_seen_at: "2026-01-01" }] });
    await saveCustomerProducts(c.admin, "store", "conv", products, [
      { text: "Quiero astaxantina", at: "2026-11-10", id: "msg", direction: "inbound" },
      { text: "Te recomiendo otro", at: "2026-11-11", direction: "outbound" },
    ]);
    expect(c.rpc).toHaveBeenCalledWith("record_lead_products_v2", expect.objectContaining({ p_store_id: "store", p_conversation_id: "conv", p_entry: null, p_signals: [expect.objectContaining({ message_id: "msg", source: "customer_text" })] }));
  });
  it("proyección de lectura no escribe ni pierde campos del lead", async () => {
    const c = client({ shopify_history_products: products });
    const lead = { id: "x", store_id: "projection-test", first_seen_at: "2026-11-10", first_inbound_text: "Astaxantina", status: "nuevo" };
    const result = await withProductOpeners(c.admin, [lead]);
    expect(result[0]).toMatchObject({ ...lead, entry_product: { handle: "astaxantina" } });
    expect(c.rpc).not.toHaveBeenCalled();
    expect(lead).not.toHaveProperty("entry_product");
  });
  it("reprocesa un histórico con cursor propio y no avanza tras un lote fallido", async () => {
    const row = { id: "next", first_inbound_text: "Astaxantina", first_seen_at: "2026-01-01" };
    const c = client({ sync_state: [{ cursor: "last" }], leads: [row] });
    await backfillLeadProducts(c.admin, "store", products, 1);
    expect(c.calls.find((call) => call.table === "leads")!.filters).toContainEqual(["id", "last"]);
    expect(c.calls.some((call) => call.filters.some((filter) => JSON.stringify(filter).includes('"cursor":"next"')))).toBe(true);
    const fail = client({ sync_state: [{ cursor: "last" }], leads: [row] });
    fail.rpc.mockResolvedValueOnce({ error: { message: "offline" } } as never);
    await expect(backfillLeadProducts(fail.admin, "store", products)).rejects.toThrow();
    expect(fail.calls.some((call) => call.filters.some((filter) => JSON.stringify(filter).includes('"upsert"')))).toBe(false);
  });
});
