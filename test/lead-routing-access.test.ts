import { beforeEach, describe, expect, it, vi } from "vitest";
const { rpc, getClaims } = vi.hoisted(() => ({ rpc: vi.fn(), getClaims: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: async () => ({ auth: { getClaims } }), createAdminSupabase: () => ({ rpc }) }));
import { filterRoutedLeads, getLeadRoutingScope } from "@/lib/lead-routing-access";
const scope = { enabled: true, blockedIds: ["excluded"], blocks: ["recuperacion"], allowed: false, signature: "v1" };
describe("server-enforced routing", () => {
  beforeEach(() => { rpc.mockReset(); getClaims.mockReset(); getClaims.mockResolvedValue({ data: { claims: { sub: "session-user" } } }); });
  it("takes identity from verified claims, not from the browser scope", async () => {
    rpc.mockResolvedValue({ data: scope });
    const result = await getLeadRoutingScope(["store-b", "store-a"], "lead");
    expect(rpc).toHaveBeenCalledWith("lead_routing_scope", { p_actor: "session-user", p_stores: ["store-a", "store-b"], p_lead: "lead" });
    expect(filterRoutedLeads([{ id: "excluded" }, { id: "permitted" }], result)).toEqual([{ id: "permitted" }]);
  });
  it("fails closed on database/network errors", async () => {
    rpc.mockResolvedValue({ error: { code: "XX000" } });
    await expect(getLeadRoutingScope(["a"])).rejects.toThrow("asignación");
  });
  it("never grants access because the function or schema cache is missing", async () => {
    rpc.mockResolvedValue({ error: { code: "PGRST202" } });
    await expect(getLeadRoutingScope(["a"])).rejects.toThrow("asignación");
  });
  it("never queries privileged routing without a signed-in identity", async () => {
    getClaims.mockResolvedValue({ data: null });
    await expect(getLeadRoutingScope(["a"])).rejects.toThrow("sesión");
    expect(rpc).not.toHaveBeenCalled();
  });
});
