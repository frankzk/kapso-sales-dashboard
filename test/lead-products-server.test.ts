import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/woocommerce-orders", () => ({ loadStoreOrderPlatform: vi.fn(async () => ({ ok: true, platform: "shopify" })), wooSaleClient: vi.fn() }));
vi.mock("@/lib/woocommerce", () => ({ wooGetPage: vi.fn() }));
vi.mock("@/lib/woocommerce-intake", () => ({ withWooAuthFallback: vi.fn() }));
import { backfillLeadProducts, saveCustomerProducts, withProductOpeners } from "@/lib/lead-products-server";

const products = [{ handle: "astaxantina", title: "Astaxantina – Antioxidante" }];
function client(data: Record<string, unknown[]>, error: string | null = null) {
  const calls: { table: string; filters: unknown[] }[] = [];
  const rpc = vi.fn(async () => ({ error: null }));
  return { rpc, calls, admin: { rpc, from(table: string) {
    const call = { table, filters: [] as unknown[] }; calls.push(call);
    const builder = { select: () => builder, eq: (...args: unknown[]) => { call.filters.push(args); return builder; },
      is: (...args: unknown[]) => { call.filters.push(args); return builder; }, order: () => builder, limit: () => builder, range: () => builder,
      maybeSingle: async () => ({ data: data[table]?.[0] ?? null, error }),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: data[table] ?? [], error }).then(resolve); } };
    return builder;
  } } as unknown as SupabaseClient };
}
describe("persistencia e historial de producto", () => {
  it("rellena solo entrada histórica; no reemplaza interés actual con un opener antiguo", async () => {
    const c = client({ leads: [{ id: "lead", first_inbound_text: "Quiero astaxantina", first_seen_at: "2026-01-01" }] });
    expect(await backfillLeadProducts(c.admin, "store", products, 500)).toEqual({ checked: 1, identified: 1 });
    expect(c.rpc).toHaveBeenCalledWith("record_lead_products", expect.objectContaining({ p_store_id: "store", p_lead_id: "lead", p_signals: [], p_entry: expect.objectContaining({ handle: "astaxantina" }) }));
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
    expect(c.rpc).toHaveBeenCalledWith("record_lead_products", expect.objectContaining({ p_store_id: "store", p_conversation_id: "conv", p_entry: null, p_signals: [expect.objectContaining({ message_id: "msg", source: "customer_text" })] }));
  });
  it("proyección de lectura no escribe ni pierde campos del lead", async () => {
    const c = client({ shopify_history_products: products });
    const lead = { id: "x", store_id: "projection-test", first_seen_at: "2026-11-10", first_inbound_text: "Astaxantina", status: "nuevo" };
    const result = await withProductOpeners(c.admin, [lead]);
    expect(result[0]).toMatchObject({ ...lead, entry_product: { handle: "astaxantina" } });
    expect(c.rpc).not.toHaveBeenCalled();
    expect(lead).not.toHaveProperty("entry_product");
  });
});
