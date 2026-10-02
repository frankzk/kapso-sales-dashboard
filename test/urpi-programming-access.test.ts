import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), stores: vi.fn(), permission: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: mocks.user, getAccessibleStores: mocks.stores }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: mocks.permission }));
import { requireUrpiStore } from "@/lib/urpi-programming-access";
describe("Urpi permissions", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: "actor" }); mocks.stores.mockResolvedValue([{ id: "store-a", org_id: "org-a" }]); mocks.permission.mockResolvedValue(true); });
  it("rejects another store before consulting elevated permissions", async () => {
    await expect(requireUrpiStore("store-b")).rejects.toThrow("acceso");
    expect(mocks.permission).not.toHaveBeenCalled();
  });
  it("checks permissions in the selected store's organization", async () => {
    await requireUrpiStore("store-a", true);
    expect(mocks.permission).toHaveBeenCalledWith("org-a", "sheets.manage");
  });
  it("requires edit permission to import", async () => {
    mocks.permission.mockResolvedValue(false);
    await expect(requireUrpiStore("store-a")).rejects.toThrow("importar");
    expect(mocks.permission).toHaveBeenCalledWith("org-a", "sheets.edit");
  });
  it("does not allow an unauthenticated request", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(requireUrpiStore("store-a")).rejects.toThrow("sesión");
  });
});
