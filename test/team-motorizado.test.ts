import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES, canAddMember, canSetRole, invitableRoles, isRole } from "@/lib/team";
import { ACCESS_LABEL, permissionsFor } from "@/lib/permissions";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// 23-10-2026: Roy y Yhoni son «motorizado» en la base, pero Equipo los pintaba
// como «Dueño» porque el rol no estaba en la lista y el selector caía en la
// primera opción. Tampoco se podía invitar con él.
describe("el acceso Motorizado en Equipo (MOM §27)", () => {
  it("es un rol de la lista, con su nombre", () => {
    expect(ROLES).toContain("motorizado");
    expect(isRole("motorizado")).toBe(true);
    expect(ACCESS_LABEL.motorizado).toBe("Motorizado");
  });

  it("el dueño y los admins pueden invitarlo, como a una vendedora", () => {
    expect(canAddMember("motorizado", "owner").ok).toBe(true);
    expect(canAddMember("motorizado", "admin").ok).toBe(true);
    expect(invitableRoles("admin")).toContain("motorizado");
    expect(invitableRoles("admin")).not.toContain("owner");
  });

  it("cambiarle el rol sigue siendo solo del dueño", () => {
    const members = [
      { user_id: "owner", role: "owner" as const },
      { user_id: "roy", role: "motorizado" as const },
    ];
    expect(canSetRole(members, "roy", "vendedora", "admin").ok).toBe(false);
    expect(canSetRole(members, "roy", "vendedora", "owner").ok).toBe(true);
  });

  it("solo da su ruta: nada de dueño", () => {
    const perms = permissionsFor(["motorizado"]);
    expect([...perms]).toEqual(["routes.deliver"]);
  });

  it("Equipo dice «Solo su ruta» en vez de «Todas (por rol)»", () => {
    expect(read("components/team.tsx")).toContain('if (member.role === "motorizado") {');
  });

  it("el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**El acceso «Motorizado» en Equipo (23-10-2026).**");
  });
});
