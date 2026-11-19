import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./woocommerce-fake-db";
const state = vi.hoisted(() => ({ db: null as unknown, visible: true, allowed: true, cancel: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => state.allowed }) }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => (state.db as FakeDb).client(),
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "asesora" } } }) },
    from: () => { const q: any = { select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: state.visible ? { order_id: "o1", store_id: "s1" } : null }) }; return q; },
  }),
}));
vi.mock("@/lib/gf-courier-guide", () => ({ cancelGfGuideFor: state.cancel, createGfGuideFor: vi.fn() }));
vi.mock("@/lib/gf-courier-track", () => ({ GF_COURIER: "gf_courier" }));
import { cancelGfCourierGuide } from "@/app/dashboard/pedidos/gf-courier-actions";
beforeEach(() => {
  vi.clearAllMocks(); state.visible = true; state.allowed = true;
  state.db = new FakeDb({ shipments: [
    { id: "g1", order_id: "o1", courier: "gf_courier", guide_code: "GF-ANTERIOR", delivery_status: "pendiente" },
    { id: "g2", order_id: "o1", courier: "gf_courier", guide_code: "GF-ELEGIDA", delivery_status: "pendiente" },
    { id: "ajena", order_id: "otro", courier: "gf_courier", guide_code: "GF-AJENA", delivery_status: "pendiente" },
  ] });
  state.cancel.mockResolvedValue({ ok: true, trackingId: "GF-ELEGIDA", cancelCost: 0 });
});
describe("resolver la guía GF elegida dentro de Atender", () => {
  it("resuelve la guía nombrada, aunque existan otras del mismo courier", async () => {
    expect((await cancelGfCourierGuide("o1", "La clienta canceló", "g2")).error).toBeUndefined();
    expect(state.cancel).toHaveBeenCalledWith("o1", "GF-ELEGIDA", expect.objectContaining({ userId: "asesora" }), expect.anything());
  });
  it("no puede resolver una guía de otro pedido", async () => {
    expect((await cancelGfCourierGuide("o1", "La clienta canceló", "ajena")).error).toBeTruthy();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it.each(["permiso", "acceso"])("sin %s no llega a GF", async (kind) => {
    if (kind === "permiso") state.allowed = false; else state.visible = false;
    expect((await cancelGfCourierGuide("o1", "La clienta canceló", "g2")).error).toBeTruthy();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it("GF aún no confirma: devuelve pendiente, sin afirmar que la guía se anuló", async () => {
    state.cancel.mockResolvedValue({ ok: true, trackingId: "GF-ELEGIDA", cancelCost: 0, requested: true });
    expect(await cancelGfCourierGuide("o1", "La clienta canceló", "g2")).toMatchObject({ pending: true });
  });
});
