import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ check: vi.fn(), claim: vi.fn(), visible: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: async () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.visible }) }) }) }) }), createAdminSupabase: mocks.admin }));
vi.mock("@/lib/access", () => ({ getAccessibleStores: async () => [{ id: "store" }] }));
vi.mock("@/lib/leads-access", () => ({ getPedidosRecientesPorTelefono: async () => [] }));
vi.mock("@/app/dashboard/leads/manual-take-actions", () => ({ takeLeadManually: (...args: unknown[]) => args[2] ? mocks.check(...args) : mocks.claim(...args) }));
import { abrirClienteParaVenta, consultarClientePorTelefono } from "@/app/dashboard/leads/venta-telefonica-actions";
describe("phone sale reuses manual-take authorization", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.visible.mockResolvedValue({ data: { id: "existing-lead", name: "Customer" } }); mocks.check.mockResolvedValue({ manualException: true }); mocks.claim.mockResolvedValue({ manualException: true }); });
  it("previews without claiming, then rechecks at open without creating another lead", async () => {
    expect(await consultarClientePorTelefono("store", "957900573")).toMatchObject({ ok: true, existia: true, manualTakeRequired: true });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(await abrirClienteParaVenta({ storeId: "store", phone: "957900573" })).toMatchObject({ ok: true, leadId: "existing-lead" });
    expect(mocks.claim).toHaveBeenCalledWith("existing-lead", "venta_telefonica"); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("shows permission errors before opening and catches a claim race", async () => {
    mocks.check.mockResolvedValueOnce({ error: "Missing permission" });
    expect(await consultarClientePorTelefono("store", "957900573")).toMatchObject({ takeError: "Missing permission" });
    mocks.claim.mockResolvedValueOnce({ error: "Another advisor took it" });
    expect(await abrirClienteParaVenta({ storeId: "store", phone: "957900573" })).toMatchObject({ ok: false, error: "Another advisor took it" });
  });
});
