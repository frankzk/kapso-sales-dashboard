import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cashLimitBlock, cashLimitVerdict } from "@/lib/grupo-gf-courier";
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

  it("pasar el límite de efectivo exige administrar, aunque la pantalla lo pida, al asignar y al mover", () => {
    const assign = src.slice(src.indexOf("async function assignRouteCore("), src.indexOf("async function routeCashForecast("));
    expect(assign).toContain("cashLimitBlock(verdict, { override: opts.overrideCash === true, canAuthorize: auth.canManageLogistics, addingCod: cash.adding })");
    const move = body("moveManifestItem");
    expect(move).toContain("routeCashForecast(admin, orgId, rider.id, manifest.route_date, [shipment.order_id as string])");
    expect(move).toContain("cashLimitBlock(verdict, { override: opts.overrideCash === true, canAuthorize: auth.canManageLogistics, addingCod: cash.adding })");
    expect(move).toContain("if (cashBlock) return { error: cashBlock, cashBlocked: true };");
    // El chequeo va antes de tocar la caja de origen.
    expect(move.indexOf("cashLimitBlock(")).toBeLessThan(move.indexOf('admin.rpc("gf_dispatch_load_open"'));
    expect(move).toContain("cash_limit_overridden_by: auth.userId");
  });

  it("quien solo despacha opera solo las tiendas que tiene en Equipo; sin ninguna, no entra", () => {
    const page = readFileSync(resolve(root, "app/dashboard/courier/page.tsx"), "utf8");
    expect(src).toContain('if (!stores.length) return { error: "No tienes tiendas asignadas. Pide acceso en Equipo." };');
    expect(src).toContain(".filter((agreement) => storeAllowed(auth, agreement.store_id));");
    expect(body("takeGroupGfCourierOrders").length).toBeGreaterThan(0);
    const take = src.slice(src.indexOf("async function takeOrdersCore("), src.indexOf("\nexport ", src.indexOf("async function takeOrdersCore(")));
    expect(take).toContain("if (!storeAllowed(auth, row.store_id as string | null)) {");
    const assign = src.slice(src.indexOf("async function assignRouteCore("), src.indexOf("async function routeCashForecast("));
    expect(assign).toContain(".filter((request) => storeAllowed(auth, request.store_id));");
    expect(body("returnUndeliveredToOffice")).toContain("storeAllowed(auth, row.store_id)");
    expect(body("moveManifestItem")).toContain("if (!storeAllowed(auth, shipment.store_id as string | null)) return { error: OUTSIDE_STORE };");
    const scan = body("scanAssignToRider");
    // Fuera de alcance no devuelve ni el número ni el monto del pedido.
    expect(scan.indexOf("if (!storeAllowed(auth, om?.store_id as string | null | undefined)) {")).toBeGreaterThan(0);
    expect(scan.indexOf("if (!storeAllowed(auth, om?.store_id as string | null | undefined)) {")).toBeLessThan(scan.indexOf("const line: ScanAssignLine = {"));
    expect(body("returnUndeliveredByCode")).toContain("if (res.error) return res;");
    expect(page).toContain("getPendingReturns({ storeIds })");
    const ledger = readFileSync(resolve(root, "lib/courier-route-ledger.ts"), "utf8");
    expect(ledger).toContain('if (scope.storeIds) query = query.in("store_id", [...scope.storeIds]);');
    expect(src).toContain("await ordersOfOrg(admin, orgId, ids, auth);");
    expect(page).toContain('<EmptyState title="No tienes tiendas asignadas">');
  });

  it("al mover, quien administra puede autorizar el exceso en las tres pantallas; los demás ven el porqué", () => {
    const day = readFileSync(resolve(root, "components/dispatch-day-board.tsx"), "utf8");
    const box = readFileSync(resolve(root, "components/gf-box-add-packages.tsx"), "utf8");
    // Escaneo de Despacho del día, «Mover» de las cajas del día y caja del panel.
    expect(day).toContain("if (result.cashBlocked && props.canAuthorizeCash && !overrideCash && window.confirm(");
    expect(day).toContain("if (result.cashBlocked && canAuthorizeCash && window.confirm(");
    expect(day).toContain("canAuthorizeCash={props.canAuthorizeCash === true}");
    expect(box).toContain("if (res.cashBlocked && canAuthorizeCash && !overrideCash && window.confirm(");
    expect(day).toContain('{l.status === "bloqueado_efectivo" && !props.canAuthorizeCash && l.message && (');
    expect(box).toContain('canAuthorizeCash ? "Límite de efectivo → Autorizar" : "Límite de efectivo · lo autoriza Daysi o Frankz"');
  });

  it("la caja del motorizado solo ofrece «Autorizar» el efectivo a quien administra", () => {
    expect(src).toContain('canAuthorizeCash: permissions.can("logistics.manage"),');
    const box = readFileSync(resolve(root, "components/gf-box-add-packages.tsx"), "utf8");
    expect(box).toContain('{l.status === "bloqueado_efectivo" && !overrideCash && canAuthorizeCash && (');
    expect(box).toContain("{overrideCash && canAuthorizeCash && <p");
    expect(readFileSync(resolve(root, "components/courier-box-drawer.tsx"), "utf8")).toContain("canAuthorizeCash={detail.canAuthorizeCash}");
    expect(readFileSync(resolve(root, "components/dispatch-workspace.tsx"), "utf8")).toContain("canAuthorizeCash={canAuthorizeCash}");
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

describe("cashLimitBlock (§29.9): quién pasa el límite de efectivo", () => {
  const blocked = cashLimitVerdict({ currentCod: 8500, addingCod: 800, warningAmount: 4000, limitAmount: 9000 });
  const warning = cashLimitVerdict({ currentCod: 4000, addingCod: 800, warningAmount: 4000, limitAmount: 9000 });

  it("por debajo del límite nadie queda bloqueado, avise o no", () => {
    expect(warning.status).toBe("warning");
    expect(cashLimitBlock(warning, { override: false, canAuthorize: false })).toBeNull();
  });

  it("quien administra pasa solo si lo autoriza; sin autorizar ve la sugerencia de autorizar", () => {
    expect(blocked.status).toBe("blocked");
    expect(cashLimitBlock(blocked, { override: true, canAuthorize: true })).toBeNull();
    expect(cashLimitBlock(blocked, { override: false, canAuthorize: true })).toContain("autoriza superar el límite.");
  });

  it("quien solo despacha no pasa ni marcando autorizar, y no se le pide una autorización que no puede dar", () => {
    const message = cashLimitBlock(blocked, { override: true, canAuthorize: false })!;
    expect(message).not.toContain("autoriza superar el límite");
    expect(message).toContain("Pasar el límite lo autoriza quien administra Grupo GF (Daysi o Frankz).");
    // El escaneo la sigue marcando «bloqueado_efectivo».
    expect(/efectivo|límite/i.test(message)).toBe(true);
    expect(cashLimitBlock(blocked, { override: false, canAuthorize: false })).toBe(message);
  });

  it("lo que no suma efectivo no se frena aunque la ruta ya haya pasado el límite con permiso", () => {
    const over = cashLimitVerdict({ currentCod: 9500, addingCod: 0, warningAmount: 4000, limitAmount: 9000 });
    expect(over.status).toBe("blocked");
    expect(cashLimitBlock(over, { override: false, canAuthorize: false, addingCod: 0 })).toBeNull();
    expect(cashLimitBlock(blocked, { override: false, canAuthorize: false, addingCod: 800 })).not.toBeNull();
  });
});
