import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ visible: true, allowed: true, store: true, loggedIn: true, rpc: vi.fn(), admin: vi.fn(), recompute: vi.fn(), permission: "", org: "" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(url); } }));
vi.mock("@/lib/db", () => ({ createAdminSupabase: state.admin, createServerSupabase: async () => ({
  auth: { getUser: async () => ({ data: { user: state.loggedIn ? { id: "diana" } : null } }) },
  from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: null,
    data: table === "order_master" ? (state.visible ? { store_id: "store-1" } : null) : (state.store ? { org_id: "org-1" } : null),
  }) }) }) }),
}) }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async (org: string, permission: string) => {
  state.permission = permission; state.org = org; return state.allowed;
} }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: state.recompute }));
import { cancelGfOutputBeforeDispatch } from "@/app/dashboard/pedidos/gf-output-cancel-actions";
beforeEach(() => {
  vi.clearAllMocks(); state.visible = state.allowed = state.store = state.loggedIn = true;
  state.admin.mockReturnValue({ rpc: state.rpc }); state.rpc.mockResolvedValue({ error: null });
});
const cancel = () => cancelGfOutputBeforeDispatch("o1", "s1", "La clienta desiste");
describe("permiso individual para el retiro GF", () => {
  it("Diana usa su permiso en la organización objetivo y el RPC liga pedido y salida", async () => {
    expect((await cancel()).notice).toContain("pedido sigue vigente");
    expect(state.permission).toBe("orders.cancel_woo"); expect(state.org).toBe("org-1");
    expect(state.rpc).toHaveBeenCalledWith("gf_cancel_output_before_dispatch", {
      p_order_id: "o1", p_shipment_id: "s1", p_actor: "diana", p_reason: "La clienta desiste",
    });
    expect(state.recompute).toHaveBeenCalledWith(expect.anything(), ["o1"]);
  });
  it.each(["visible", "allowed", "store"] as const)("no crea cliente de servicio si falla %s", async (key) => {
    state[key] = false; expect((await cancel()).error).toBeTruthy(); expect(state.admin).not.toHaveBeenCalled();
  });
  it("requiere sesión", async () => {
    state.loggedIn = false; await expect(cancel()).rejects.toThrow("/login"); expect(state.admin).not.toHaveBeenCalled();
  });
  it("rechaza motivo vacío o largo antes de escribir", async () => {
    for (const reason of [" ", "x".repeat(501)]) expect((await cancelGfOutputBeforeDispatch("o1", "s1", reason)).error).toBeTruthy();
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("propaga el bloqueo físico del RPC sin anunciar éxito", async () => {
    state.rpc.mockResolvedValue({ error: { message: "El motorizado ya recibió el paquete" } });
    expect(await cancel()).toEqual({ error: "El motorizado ya recibió el paquete" });
    expect(state.recompute).not.toHaveBeenCalled();
  });
});
