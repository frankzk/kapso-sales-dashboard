import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
const state = vi.hoisted(() => ({
  check: vi.fn(), createOrder: vi.fn(), writes: vi.fn(),
  detail: vi.fn(), outputs: [] as Record<string, unknown>[],
  shipmentError: null as { message: string } | null,
}));
vi.mock("@/lib/env", () => ({ env: { aliclikWriteEnabled: () => true } }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: async () => ({ org_id: "org", aliclik_enabled: true, aliclik_api_token: "test" }) }));
vi.mock("@/lib/orders-master-access", () => ({
  getOrderConfirmationBrief: async () => ({ doorRejections: 0, risk: { requirement: "ninguno" } }),
  getOrderMasterDetail: state.detail,
}));
// La creación vive en lib/aliclik-guide.ts desde el 16-10-2026 y lee la
// retención directamente (la misma para el botón y para la guía automática).
vi.mock("@/lib/aliclik-duplicate-access", () => ({
  DUPLICATE_READ_ERROR: "No se pudo verificar",
  loadAliclikDuplicateHold: state.check,
}));
vi.mock("@/lib/aliclik", () => ({ createOrder: state.createOrder }));
vi.mock("@/lib/db", () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "operator" } } }) },
    from: (table: string) => {
      const q: any = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { order_id: "new", store_id: "store", macro_operation: "lima", coverage: "lima", region: "Lima", payment_state: "sin_pago" } }),
        insert: state.writes,
        then: (resolve: any) => Promise.resolve({
          data: table === "stores" ? [{ id: "store" }] : table === "shipments" ? state.outputs : [],
          error: table === "shipments" ? state.shipmentError : null,
        }).then(resolve),
      };
      return q;
    },
  };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import { createAliclikGuide } from "@/app/dashboard/pedidos/aliclik-actions";

beforeEach(() => {
  vi.clearAllMocks();
  state.outputs = [];
  state.shipmentError = null;
  state.detail.mockResolvedValue(null);
});
describe("llamada directa a createAliclikGuide", () => {
  it("no emite ni registra intención aunque el navegador mande una excepción de riesgo", async () => {
    state.check.mockResolvedValue({ allowed: false, message: "Otro envío sigue despachado" });
    const result = await createAliclikGuide("new", { transportId: 1, riskExceptionReason: "Cliente confirmó que quiere ambos pedidos" });
    expect(result).toEqual({ error: "Otro envío sigue despachado" });
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
  it("un fallo de lectura impide la escritura externa", async () => {
    state.check.mockRejectedValue(new Error("No se pudo verificar el duplicado"));
    expect(await createAliclikGuide("new", { transportId: 1 })).toEqual({ error: "No se pudo verificar el duplicado" });
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("otra salida de Grupo GF exige motivo también en una llamada directa, antes del POST", async () => {
    state.check.mockResolvedValue({ allowed: true });
    state.outputs = [{ id: "gf", courier: "propio", guide_code: "GF-1", output_code: "KP200077-S01",
      delivery_status: "pendiente", custody_state: "courier", created_via: "grupo_gf_courier" }];
    const result = await createAliclikGuide("new", { transportId: 1 });
    expect(result.error).toContain("motivo de la salida adicional");
    expect(state.detail).not.toHaveBeenCalled();
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("con motivo avanza a las demás validaciones, sin saltarse la lectura del pedido", async () => {
    state.check.mockResolvedValue({ allowed: true });
    state.outputs = [{ id: "gf", courier: "propio", guide_code: "GF-1", delivery_status: "pendiente",
      custody_state: "courier", created_via: "grupo_gf_courier" }];
    const result = await createAliclikGuide("new", { transportId: 1, motivoSalidaAdicional: "Alexis sin reporte; preparar para mañana." });
    expect(state.detail).toHaveBeenCalled();
    expect(result.error).toBe("No se pudo cargar el detalle del pedido.");
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("sin poder leer las salidas no emite, aunque haya motivo", async () => {
    state.check.mockResolvedValue({ allowed: true });
    state.shipmentError = { message: "sin conexión" };
    expect((await createAliclikGuide("new", { transportId: 1, motivoSalidaAdicional: "preparar" })).error)
      .toContain("No se pudieron leer las salidas");
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
});
