import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/crypto", () => ({ decryptOrNull: vi.fn(() => "synthetic-key") }));
const save = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/lead-products-server", () => ({ saveCustomerProducts: save }));
import { reviewUnknownProductConversations } from "@/lib/lead-product-deep-review";

function client(options: { error?: boolean; cohort?: boolean } = {}) {
  const calls: { table: string; filters: unknown[] }[] = [];
  const id = "00000000-0000-0000-0000-000000000001";
  return { calls, admin: { from(table: string) {
    const call = { table, filters: [] as unknown[] }; calls.push(call);
    const b = { select: () => b, eq: (...x: unknown[]) => { call.filters.push(x); return b; }, in: (...x: unknown[]) => { call.filters.push(x); return b; },
      upsert: (x: unknown) => { call.filters.push({ upsert: x }); return b; },
      maybeSingle: async () => ({ data: table === "stores" ? { kapso_api_key_enc: "encrypted" } : call.filters.some(x => JSON.stringify(x).includes("targets")) && options.cohort !== false ? { cursor: JSON.stringify({ ids: [id] }) } : null, error: null }),
      then(resolve: (x: unknown) => unknown) { return Promise.resolve({ data: table === "leads" ? [{ id, kapso_conversation_id: "private-chat" }] : [], error: options.error ? "offline" : null }).then(resolve); },
    }; return b;
  } } as unknown as SupabaseClient };
}
describe("frozen server-only conversation review", () => {
  it("uses the authenticated store key and writes only customer product evidence", async () => {
    const c = client();
    const fetch = vi.fn(async () => ({ product_messages: [{ text: "Quiero Astaxantina", at: "2026-11-11", direction: "inbound", id: "private-message" }] }));
    const result = await reviewUnknownProductConversations(c.admin, "store", [{ handle: "astaxantina", title: "Astaxantina" }], fetch as never);
    expect(result).toEqual({ checked: 1, identified: 1, unreadable: 0, complete: true });
    expect(JSON.stringify(result)).not.toMatch(/private|Astaxantina|synthetic/);
    expect(fetch).toHaveBeenCalledWith({ apiKey: "synthetic-key" }, "private-chat");
    expect(save).toHaveBeenCalledWith(c.admin, "store", "private-chat", expect.any(Array), expect.any(Array));
    expect(c.calls.find(c => c.table === "leads")!.filters).toContainEqual(["store_id", "store"]);
  });
  it("does not read arbitrary conversations without the frozen cohort", async () => {
    const c = client({ cohort: false }); const fetch = vi.fn();
    await expect(reviewUnknownProductConversations(c.admin, "store", [], fetch)).rejects.toThrow("cohort unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports an unreadable page without inventing evidence; persistence errors retain the cursor", async () => {
    const c = client();
    expect(await reviewUnknownProductConversations(c.admin, "store", [], vi.fn(async () => null))).toMatchObject({ unreadable: 1, identified: 0 });
    const failure = client();
    save.mockRejectedValueOnce(new Error("private upstream failure"));
    await expect(reviewUnknownProductConversations(failure.admin, "store", [], vi.fn(async () => ({ product_messages: [{ text: "hello" }] })) as never)).rejects.toThrow();
    expect(failure.calls.flatMap(c => c.filters).some((x: any) => x.upsert)).toBe(false);
  });
});
