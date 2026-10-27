import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: createServerSupabaseMock }));
import { getLeadWithCalls } from "@/lib/leads-access";

function db(options: { gid?: string | null; draftError?: boolean; noLead?: boolean } = {}) {
  const draftFilters: [string, unknown][] = [];
  const selects: [string, string][] = [];
  const from = vi.fn((table: string) => {
    const chain = {
      select: (columns: string) => { selects.push([table, columns]); return chain; },
      eq: (column: string, value: unknown) => {
        if (table === "draft_orders") draftFilters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => table === "leads"
        ? { data: options.noLead ? null : {
          id: "lead", store_id: "store-a", draft_order_gid: options.gid === undefined ? "cod-core://kp/formulario/3148" : options.gid,
          first_seen_at: "2026-10-27T18:00:00Z",
        }, error: null }
        : { data: options.draftError ? null : {
          created_at: "2026-10-27T13:02:00Z", line_items: [{ title: "Black Seed Oil", quantity: 3 }],
        }, error: options.draftError ? { message: "lectura fallida" } : null },
      order: async () => ({ data: [{ id: "call" }], error: null }),
    };
    return chain;
  });
  createServerSupabaseMock.mockResolvedValue({ from });
  return { from, draftFilters, selects };
}

describe("lectura del carrito en la ficha", () => {
  beforeEach(() => createServerSupabaseMock.mockReset());

  it.each(["cod-core://kp/formulario/3148", "gid://shopify/DraftOrder/123"])(
    "lee el carrito exacto en la misma tienda: %s", async (gid) => {
      const state = db({ gid });
      const result = await getLeadWithCalls("lead");
      expect(state.draftFilters).toEqual([["store_id", "store-a"], ["draft_order_gid", gid]]);
      expect(state.selects).toContainEqual(["draft_orders", "created_at,line_items"]);
      expect(result?.lead.cart_detail).toEqual({
        createdAt: "2026-10-27T13:02:00Z",
        lines: [{ title: "Black Seed Oil", quantity: 3, variant: null }],
      });
      expect(result?.lead.cart_detail?.createdAt).not.toBe(result?.lead.first_seen_at);
    },
  );

  it("sin carrito no hace una consulta extra", async () => {
    const state = db({ gid: null });
    expect((await getLeadWithCalls("lead"))?.lead.cart_detail).toBeNull();
    expect(state.from).not.toHaveBeenCalledWith("draft_orders");
  });

  it("una lectura fallida del carrito conserva el lead y sus llamadas", async () => {
    db({ draftError: true });
    const result = await getLeadWithCalls("lead");
    expect(result?.lead.id).toBe("lead");
    expect(result?.calls).toEqual([{ id: "call" }]);
    expect(result?.lead.cart_detail).toBeNull();
  });

  it("sin acceso al lead tampoco consulta su carrito", async () => {
    const state = db({ noLead: true });
    expect(await getLeadWithCalls("lead")).toBeNull();
    expect(state.from).not.toHaveBeenCalledWith("draft_orders");
  });
});
