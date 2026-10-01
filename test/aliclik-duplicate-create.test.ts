import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
const state = vi.hoisted(() => ({
  check: vi.fn(), createOrder: vi.fn(), writes: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ env: { aliclikWriteEnabled: () => true } }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: async () => ({ org_id: "org", aliclik_enabled: true, aliclik_api_token: "test" }) }));
vi.mock("@/lib/orders-master-access", () => ({ getOrderConfirmationBrief: async () => ({ doorRejections: 0, risk: { requirement: "ninguno" } }) }));
vi.mock("@/app/dashboard/pedidos/aliclik-duplicate-actions", () => ({ getAliclikDuplicateHold: state.check }));
vi.mock("@/lib/aliclik", () => ({ createOrder: state.createOrder }));
vi.mock("@/lib/db", () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "operator" } } }) },
    from: (table: string) => {
      const q: any = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { order_id: "new", store_id: "store", coverage: "provincia_cod", region: "Cusco", payment_state: "sin_pago" } }),
        insert: state.writes,
        then: (resolve: any) => Promise.resolve({ data: table === "stores" ? [{ id: "store" }] : [], error: null }).then(resolve),
      };
      return q;
    },
  };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import { createAliclikGuide } from "@/app/dashboard/pedidos/aliclik-actions";

beforeEach(() => { vi.clearAllMocks(); });
describe("llamada directa a createAliclikGuide", () => {
  it("no emite ni registra intención aunque el navegador mande una excepción de riesgo", async () => {
    state.check.mockResolvedValue({ hold: { allowed: false, message: "Otro envío sigue despachado" } });
    const result = await createAliclikGuide("new", { transportId: 1, riskExceptionReason: "Cliente confirmó que quiere ambos pedidos" });
    expect(result).toEqual({ error: "Otro envío sigue despachado" });
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
  it("un fallo de lectura impide la escritura externa", async () => {
    state.check.mockResolvedValue({ error: "No se pudo verificar el duplicado" });
    expect(await createAliclikGuide("new", { transportId: 1 })).toEqual({ error: "No se pudo verificar el duplicado" });
    expect(state.createOrder).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
});
