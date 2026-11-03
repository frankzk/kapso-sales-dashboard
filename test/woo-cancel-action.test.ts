// La acción «Anular pedido» de la ficha (MOM §38.15): solo quien tiene «Anular
// pedidos de WooCommerce» (`orders.cancel_woo`) en la organización de la tienda del pedido, y solo si ve el
// pedido (RLS). Sin el permiso no se llama a WooCommerce ni se escribe nada.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  visible: true as boolean,
  allowed: true as boolean,
  permissionAsked: [] as string[],
  cancel: vi.fn(async () => ({ ok: true as const, notice: "#KP200010 quedó anulado en WooCommerce." })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === "order_master") {
              return { data: h.visible ? { order_id: "o1", store_id: "s1" } : null, error: null };
            }
            return { data: { org_id: "org-1" }, error: null };
          },
        }),
      }),
    }),
  }),
  createAdminSupabase: () => ({ admin: true }),
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (_org: string, permission: string) => {
    h.permissionAsked.push(permission);
    return h.allowed;
  },
}));
vi.mock("@/lib/woo-cancel-server", () => ({ cancelWooOrderFromKapta: h.cancel }));

import { cancelWooOrder } from "@/app/dashboard/pedidos/woo-cancel-actions";
import { WOO_CANCEL_DENIED } from "@/lib/woo-cancel";

const input = { reasonCode: "duplicado", reasonText: "Se creó dos veces", requestId: "5d1c2f7e-0b1a-4c3d-9e8f-123456789abc" };

beforeEach(() => {
  h.visible = true;
  h.allowed = true;
  h.permissionAsked = [];
  h.cancel.mockClear();
});

describe("cancelWooOrder (acción del servidor)", () => {
  it("sin «Anular pedidos de WooCommerce» no anula ni llama a WooCommerce", async () => {
    h.allowed = false;
    expect(await cancelWooOrder("o1", input)).toEqual({ error: WOO_CANCEL_DENIED });
    // El permiso propio (26-10-2026), no «Registrar estado a mano».
    expect(h.permissionAsked).toEqual(["orders.cancel_woo"]);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("un pedido que no ve (RLS) no se anula", async () => {
    h.visible = false;
    expect(await cancelWooOrder("o1", input)).toEqual({ error: "Sin acceso a este pedido." });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("con el permiso, anula con el usuario, el motivo y el intento", async () => {
    expect(await cancelWooOrder("o1", input)).toEqual({ notice: "#KP200010 quedó anulado en WooCommerce." });
    expect(h.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", userId: "user-1", reasonCode: "duplicado", reasonText: "Se creó dos veces", requestId: input.requestId }),
    );
  });
});
