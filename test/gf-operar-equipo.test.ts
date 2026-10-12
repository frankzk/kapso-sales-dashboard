import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canOperateGroupGf, hasPermission, type Permission, type PermissionGrant } from "@/lib/permissions";

// Decisión del owner, 11-10-2026 («Reprogramación en Lima: quién hace qué»):
// cualquiera del equipo reprograma, programa y recibe en oficina. Despacho del
// día de Grupo GF es de quien despacha (`dispatch.manage`) o administra el
// courier (`logistics.manage`); el Tarifario, el pago de motorizados y pasar
// el límite de efectivo siguen siendo de `logistics.manage` (MOM §29.9, §29.10).

const root = process.cwd();
const can = (roles: string[], grants: PermissionGrant[] = []) => (p: Permission) => hasPermission(roles, p, grants);

describe("quién opera Grupo GF Courier", () => {
  it("una vendedora opera Despacho del día sin el permiso de administrar", () => {
    expect(hasPermission(["vendedora"], "logistics.manage")).toBe(false);
    expect(canOperateGroupGf(can(["vendedora"]))).toBe(true);
  });

  it("un admin también, y quien tiene «Administrar Grupo GF» aunque le quiten despachar", () => {
    expect(canOperateGroupGf(can(["admin"]))).toBe(true);
    expect(canOperateGroupGf(can(["viewer"], [{ permission: "logistics.manage" }]))).toBe(true);
  });

  it("un viewer, un motorizado o una vendedora sin despachar no operan", () => {
    expect(canOperateGroupGf(can(["viewer"]))).toBe(false);
    expect(canOperateGroupGf(can(["motorizado"]))).toBe(false);
    expect(canOperateGroupGf(can(["vendedora"], [{ permission: "dispatch.manage", granted: false }]))).toBe(false);
  });
});

describe("Despacho del día abierto al equipo; Tarifario y efectivo, no", () => {
  const src = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThan(0);
    return src.slice(start, src.indexOf("\nexport ", start + 1));
  };

  it("las acciones de operar piden operar, no administrar", () => {
    for (const name of [
      "loadCourierConfig",
      "takeGroupGfCourierOrders",
      "returnUndeliveredToOffice",
      "returnUndeliveredByCode",
      "rescheduleGroupGfCourierOrders",
      "clearGroupGfCourierPrograms",
      "takeAndAssignGroupGfCourierOrders",
      "assignGroupGfCourierRoute",
      "moveManifestItem",
      "scanAssignToRider",
    ]) {
      expect(body(name), name).toContain("await requireOperator(");
      expect(body(name), name).not.toContain("await requireManager(");
    }
  });

  it("tarifario, contratos y pago de motorizados siguen pidiendo administrar", () => {
    for (const name of ["activateGroupGfCourier", "saveDistrictTariff", "setDistrictAvailability", "loadRiderPayRates", "saveRiderDistrictPay"]) {
      expect(body(name), name).toContain("await requireManager(");
    }
    expect(src).toContain('const allowed = level === "administrar" ? permissions.can("logistics.manage") : canOperateGroupGf(permissions.can);');
  });

  it("pasar el límite de efectivo exige administrar, aunque la pantalla lo pida", () => {
    expect(src).toContain('if (verdict.status === "blocked" && !(opts.overrideCash && auth.canManageLogistics)) {');
    expect(src).toContain("Solo quien administra Grupo GF puede autorizar pasar el límite.");
  });

  it("la página deja entrar a quien opera y solo muestra el Tarifario a quien administra", () => {
    const page = readFileSync(resolve(root, "app/dashboard/courier/page.tsx"), "utf8");
    expect(page).toContain("if (!canOperateGroupGf(permissions.can)) {");
    expect(page).not.toContain('if (!permissions.can("logistics.manage")) {');
    const board = readFileSync(resolve(root, "components/grupo-gf-courier.tsx"), "utf8");
    expect(board).toContain('if (value === "tariffs") return canManageLogistics ? value : "dispatch";');
    expect(board).toContain('{tab === "tariffs" && canManageLogistics && (');
    expect(board).toContain("canAuthorizeCash={canManageLogistics}");
    const day = readFileSync(resolve(root, "components/dispatch-day-board.tsx"), "utf8");
    expect(day).toContain("{props.canAuthorizeCash && (");
  });

  it("Rutas manda a la pestaña a todo el que opera, no solo a quien administra", () => {
    const rutas = readFileSync(resolve(root, "app/dashboard/courier/rutas/page.tsx"), "utf8");
    expect(rutas).toContain("if (canOperateGroupGf(permissions.can)) redirect(");
    const reparto = readFileSync(resolve(root, "app/dashboard/courier/reparto/page.tsx"), "utf8");
    expect(reparto).toContain("canOperateGroupGf(perms.can) ? ROUTES_TAB_HREF");
  });
});
