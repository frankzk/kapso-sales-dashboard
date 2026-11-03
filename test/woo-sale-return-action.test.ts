import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ visible: true, allowed: true, store: true, grantedOrg: "", permission: "", cancel: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(url); } }));
vi.mock("@/lib/db", () => ({ createAdminSupabase: () => ({ admin: true }), createServerSupabase: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: "diana" } } }) },
  from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: null,
    data: table === "order_master" ? (state.visible ? { store_id: "s1" } : null) : (state.store ? { org_id: "org-1" } : null),
  }) }) }) }),
}) }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async (org: string, permission: string) => {
  state.grantedOrg = org; state.permission = permission; return state.allowed;
} }));
vi.mock("@/lib/legacy-sale-cancel-server", () => ({ cancelHistoricalShopifySale: state.cancel }));
import { endWooSalePendingReturn } from "@/app/dashboard/pedidos/woo-sale-return-actions";
const input = { reasonCode: "entrega_no_lograda", reasonText: "No habrá otro intento", requestId: "request-123456" };
beforeEach(() => { vi.clearAllMocks(); state.visible = true; state.allowed = true; state.store = true;
  state.cancel.mockResolvedValue({ notice: "Venta anulada" }); });
describe("permiso y alcance de la anulación histórica", () => {
  it("Diana usa el mismo permiso concedido, dentro de la organización del pedido, sin ser admin", async () => {
    expect(await endWooSalePendingReturn("o1", input)).toEqual({ notice: "Venta anulada" });
    expect(state.permission).toBe("orders.cancel_woo"); expect(state.grantedOrg).toBe("org-1");
    expect(state.cancel).toHaveBeenCalledWith(expect.objectContaining({ orderId: "o1", userId: "diana", ...input, wooReturn:true }));
  });
  it("no accede al servidor de anulación si RLS oculta el pedido", async () => {
    state.visible = false; expect((await endWooSalePendingReturn("o1", input)).error).toBeTruthy();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it("no basta con tener el permiso en otra organización", async () => {
    state.allowed = false; expect((await endWooSalePendingReturn("o1", input)).error).toContain("organización");
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it("una tienda que no se puede leer no autoriza la anulación", async () => {
    state.store = false; expect((await endWooSalePendingReturn("o1", input)).error).toBeTruthy();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});

it('no deja sobrescribir pedido, usuario ni cliente de servicio desde el formulario',async()=>{
 await endWooSalePendingReturn('o1',{...input,orderId:'otra-org',userId:'owner',admin:'falso'} as typeof input);
 expect(state.cancel).toHaveBeenCalledWith(expect.objectContaining({orderId:'o1',userId:'diana',admin:{admin:true},wooReturn:true}));
});
