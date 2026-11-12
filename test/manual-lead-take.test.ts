import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claims: vi.fn(), rpc: vi.fn(), visible: vi.fn(), name: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: async () => ({ auth: { getClaims: mocks.claims }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.visible }) }) }) }), createAdminSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: mocks.name }));
import { takeLeadManually } from "@/app/dashboard/leads/manual-take-actions";
const lead = "00000000-0000-0000-0000-000000000001";
describe("manual claim server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.claims.mockResolvedValue({ data: { claims: { sub: "verified-session" } } });
    mocks.visible.mockResolvedValue({ data: { id: lead } }); mocks.rpc.mockResolvedValue({ data: { ok: true, manualException: true } }); mocks.name.mockResolvedValue("another-advisor");
  });
  it("uses the signed session and explicit origin, and keeps preview read-only", async () => {
    expect(await takeLeadManually(lead, "busqueda")).toEqual({ manualException: true });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_manual_lead", { p_actor: "verified-session", p_lead: lead, p_origin: "busqueda" });
    await takeLeadManually(lead, "venta_telefonica", true);
    expect(mocks.rpc).toHaveBeenLastCalledWith("lead_manual_take_check", { p_actor: "verified-session", p_lead: lead });
  });
  it("denies missing store access and unsigned requests before service calls", async () => {
    mocks.visible.mockResolvedValueOnce({ data: null }); expect((await takeLeadManually(lead, "busqueda")).error).toContain("tienda");
    mocks.claims.mockResolvedValueOnce({ data: null }); expect((await takeLeadManually(lead, "busqueda")).error).toContain("sesión");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["claimed", "appointment"])("names the holder on %s without taking the lead", async reason => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, reason, holder: "holder" } });
    expect((await takeLeadManually(lead, "busqueda")).error).toContain("another-advisor");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("explains missing permission and capacity, and fails closed on DB errors", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, reason: "permission" } }); expect((await takeLeadManually(lead, "busqueda")).error).toContain("Equipo → Leads");
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, reason: "capacity" } }); expect((await takeLeadManually(lead, "busqueda")).error).toContain("dos leads");
    mocks.rpc.mockResolvedValueOnce({ error: { message: "private error" } }); expect((await takeLeadManually(lead, "busqueda")).error).not.toContain("private error");
  });
});
