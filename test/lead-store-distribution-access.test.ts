import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), stores: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/access", () => ({ getCurrentUser: mocks.user, getAccessibleStores: mocks.stores }));
vi.mock("@/lib/db", () => ({ createAdminSupabase: () => ({ rpc: mocks.rpc }) }));
import { getLeadStoreDistribution } from "@/lib/lead-store-distribution-access";
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "session-actor" }); mocks.stores.mockResolvedValue([{ id: "allowed" }]); });
describe("private distribution reads", () => {
  it("derives actor from session and deduplicates authorized stores", async () => {
    mocks.rpc.mockResolvedValue({ data: { weights: null, completed: {} }, error: null });
    await getLeadStoreDistribution(["allowed", "allowed"]);
    expect(mocks.rpc).toHaveBeenCalledWith("lead_store_distribution", { p_actor: "session-actor", p_stores: ["allowed"] });
  });
  it("rejects ungranted stores before service reads", async () => {
    await expect(getLeadStoreDistribution(["foreign"])).rejects.toThrow("Sin acceso");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated reads", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(getLeadStoreDistribution(["allowed"])).rejects.toThrow("Sin sesión");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not silently drop the target on database errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    await expect(getLeadStoreDistribution(["allowed"])).rejects.toThrow("distribución");
  });
});
