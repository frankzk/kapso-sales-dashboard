import { beforeEach, describe, expect, it, vi } from "vitest";

const { maybeSingle, membershipUserEq, membershipOrgEq, permissionOrgEq, permissionUserEq, roleUserEq } = vi.hoisted(() => {
  const maybeSingle = vi.fn(async () => ({ data: { role: "owner" }, error: null }));
  const membershipUserEq = vi.fn(() => ({ maybeSingle }));
  const membershipOrgEq = vi.fn(() => ({ eq: membershipUserEq }));
  const permissionUserEq = vi.fn(async () => ({ data: [], error: null }));
  const permissionOrgEq = vi.fn((column: string) => column === "user_id"
    ? Promise.resolve({ data: [], error: null }) : { eq: permissionUserEq });
  // Roles acumulables (0250): una vendedora de Liquidaciones en la org.
  const roleUserEq = vi.fn(async () => ({ data: [{ org_id: "org-aurela", role: "liquidaciones" }], error: null }));
  return { maybeSingle, membershipUserEq, membershipOrgEq, permissionOrgEq, permissionUserEq, roleUserEq };
});

vi.mock("@/lib/access", () => ({
  getCurrentUser: vi.fn(async () => ({ id: "user-frankz", email: "frankz@example.com" })),
  getUserRoleSummary: vi.fn(async () => ({
    roles: ["owner"],
    isVendedoraOnly: false,
    isRiderOnly: false,
  })),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: vi.fn(async () => ({
    from(table: string) {
      if (table === "memberships") {
        return { select: () => ({ eq: membershipOrgEq }) };
      }
      if (table === "user_permissions") {
        return { select: () => ({ eq: permissionOrgEq }) };
      }
      if (table === "membership_roles") {
        return { select: () => ({ eq: roleUserEq }) };
      }
      throw new Error(`Tabla inesperada: ${table}`);
    },
  })),
}));

describe("hasOrgPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("los permisos globales tampoco heredan concesiones de otros miembros visibles por RLS", async () => {
    const { getMasterPermissions } = await import("@/lib/permissions-access");
    await getMasterPermissions();
    expect(permissionOrgEq).toHaveBeenCalledWith("user_id", "user-frankz");
  });

  it("limita la membresía al usuario actual antes de exigir una sola fila", async () => {
    const { hasOrgPermission } = await import("@/lib/permissions-access");

    await expect(hasOrgPermission("org-aurela", "payments.validate")).resolves.toBe(true);
    expect(membershipOrgEq).toHaveBeenCalledWith("org_id", "org-aurela");
    expect(membershipUserEq).toHaveBeenCalledWith("user_id", "user-frankz");
    expect(maybeSingle).toHaveBeenCalledOnce();
    expect(permissionOrgEq).toHaveBeenCalledWith("org_id", "org-aurela");
    expect(permissionUserEq).toHaveBeenCalledWith("user_id", "user-frankz");
  });

  it("los roles acumulables se leen solo los PROPIOS y cuentan en su organización", async () => {
    maybeSingle.mockResolvedValue({ data: { role: "vendedora" }, error: null });
    const { hasOrgPermission } = await import("@/lib/permissions-access");
    // Vendedora con Liquidaciones: cierra liquidaciones, ya no crea pedidos.
    await expect(hasOrgPermission("org-aurela", "settlements.close")).resolves.toBe(true);
    await expect(hasOrgPermission("org-aurela", "orders.create")).resolves.toBe(false);
    expect(roleUserEq).toHaveBeenCalledWith("user_id", "user-frankz");
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
  });
});
