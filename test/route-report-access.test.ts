import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsFor, GRANTED_ONE_BY_ONE } from "@/lib/permissions";
const mock = vi.hoisted(() => ({
  user: { id: "chief", email: "chief@example.test" } as { id: string; email: string } | null,
  route: { id: "route", org_id: "org-a", rider_id: "roy", status: "en_curso" } as Record<string, string> | null,
  rider: { id: "roy", user_id: "roy-user", full_name: "Roy" },
  grant: vi.fn(), can: vi.fn(),
}));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => mock.user }));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: mock.grant, getMasterPermissions: async () => ({ can: mock.can }),
}));
vi.mock("@/lib/db", () => ({ createServerSupabase: async () => ({
  from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "delivery_routes" ? mock.route : mock.rider }) }) }) }),
}) }));
import { routeReportAccess } from "@/lib/route-report-access";

describe("route reporting permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.user = { id: "chief", email: "chief@example.test" };
    mock.route = { id: "route", org_id: "org-a", rider_id: "roy", status: "en_curso" };
    mock.can.mockReturnValue(true);
    mock.grant.mockResolvedValue(false);
  });
  it("appears in Equipo, is off for admins, and honors grants and revocations", () => {
    expect(GRANTED_ONE_BY_ONE.some((p) => p.permission === "routes.report_others")).toBe(true);
    for (const role of ["admin", "vendedora", "motorizado", "viewer"]) {
      expect(permissionsFor([role]).has("routes.report_others")).toBe(false);
    }
    expect(permissionsFor(["admin"], [{ permission: "routes.report_others" }]).has("routes.report_others")).toBe(true);
    expect(permissionsFor(["owner"], [{ permission: "routes.report_others", granted: false }]).has("routes.report_others")).toBe(false);
  });
  it("routes.deliver or routes.manage alone cannot report another rider's stop", async () => {
    expect(await routeReportAccess("route")).toBeNull();
    expect(mock.grant).toHaveBeenCalledWith("org-a", "routes.report_others");
  });
  it("accepts an org-scoped supervisor and retains the true actor", async () => {
    mock.grant.mockResolvedValue(true);
    expect(await routeReportAccess("route")).toMatchObject({ delegated: true, userId: "chief", riderName: "Roy" });
  });
  it("does not inherit a grant from another organization", async () => {
    mock.grant.mockImplementation(async (org: string) => org === "org-b");
    expect(await routeReportAccess("route")).toBeNull();
  });
  it("keeps the rider's own reporting, but respects deliver revocation", async () => {
    mock.user!.id = "roy-user";
    expect(await routeReportAccess("route")).toMatchObject({ delegated: false });
    expect(mock.grant).not.toHaveBeenCalled();
    mock.can.mockReturnValue(false);
    expect(await routeReportAccess("route")).toBeNull();
  });
  it.each(["cerrada", "planificada", "cancelada"])("blocks %s even for authorized supervisors", async (status) => {
    mock.route!.status = status; mock.grant.mockResolvedValue(true);
    expect(await routeReportAccess("route")).toBeNull();
  });
  it("fails closed for hidden routes or no session", async () => {
    mock.route = null;
    expect(await routeReportAccess("route")).toBeNull();
    mock.user = null;
    expect(await routeReportAccess("route")).toBeNull();
  });
});
