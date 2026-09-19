import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeCourierBoxHref,
  courierBoxHref,
  courierRouteDrawerHref,
  legacyManifestHref,
  readCourierBoxRequest,
} from "@/lib/courier-box-href";
import { ledgerSituation } from "@/lib/courier-route-ledger";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("la caja se abre al lado de Rutas (MOM §29.14)", () => {
  it("abre la caja conservando pestaña y filtros, y cerrar los devuelve", () => {
    const at = { pathname: "/dashboard/courier", search: "?tab=routes&motorizado=roy&dia=todas" };
    const open = courierBoxHref("m1", at);
    expect(open).toBe("/dashboard/courier?tab=routes&motorizado=roy&dia=todas&caja=m1");
    expect(readCourierBoxRequest({ pathname: at.pathname, search: open.split("?")[1] })).toEqual({ kind: "caja", manifestId: "m1" });
    expect(closeCourierBoxHref({ pathname: at.pathname, search: open.split("?")[1] })).toBe("/dashboard/courier?tab=routes&motorizado=roy&dia=todas");
  });
  it("una ruta sin caja abre por su id y nunca convive con una caja", () => {
    const withBox = "?tab=routes&caja=m1";
    const href = courierRouteDrawerHref("r1", { pathname: "/dashboard/courier", search: withBox });
    expect(href).toBe("/dashboard/courier?tab=routes&ruta=r1");
    expect(readCourierBoxRequest({ pathname: "/dashboard/courier", search: "tab=routes&ruta=r1" })).toEqual({ kind: "ruta", routeId: "r1" });
    expect(readCourierBoxRequest({ pathname: "/dashboard/courier", search: "tab=routes" })).toBeNull();
  });
  it("los enlaces antiguos a ?manifiesto= caen en la pestaña Rutas con la caja abierta", () => {
    expect(legacyManifestHref("m1")).toBe("/dashboard/courier?tab=routes&caja=m1");
    expect(legacyManifestHref(null)).toBe("/dashboard/courier?tab=routes");
    expect(read("app/dashboard/pedidos/despacho/page.tsx")).toContain("legacyManifestHref(requestedManifestId)");
    expect(read("app/dashboard/courier/rutas/page.tsx")).toContain("legacyManifestHref(params.manifiesto");
  });
  it("la situación de la fila va de borrador a liquidada sin saltos", () => {
    expect(ledgerSituation({ routeStatus: "planificada", manifestState: null, settlementStatus: null })).toBe("borrador");
    expect(ledgerSituation({ routeStatus: "planificada", manifestState: "office_check", settlementStatus: null })).toBe("cotejo_oficina");
    expect(ledgerSituation({ routeStatus: "planificada", manifestState: "ready_for_pickup", settlementStatus: null })).toBe("lista_para_recojo");
    expect(ledgerSituation({ routeStatus: "planificada", manifestState: "in_custody", settlementStatus: null })).toBe("en_poder_del_courier");
    expect(ledgerSituation({ routeStatus: "en_curso", manifestState: "in_custody", settlementStatus: null })).toBe("en_reparto");
    expect(ledgerSituation({ routeStatus: "cerrada", manifestState: "in_custody", settlementStatus: "borrador" })).toBe("cerrada");
    expect(ledgerSituation({ routeStatus: "cerrada", manifestState: null, settlementStatus: "aprobada" })).toBe("liquidada");
  });
  it("el panel reutiliza los tres pasos de la mesa de despacho y no la lista de rutas recientes", () => {
    const workspace = read("components/dispatch-workspace.tsx");
    const drawer = read("components/courier-box-drawer.tsx");
    expect(workspace).toContain("export function DispatchBoxPanel(");
    expect(workspace).toContain("<DispatchBoxPanel");
    expect(drawer).toContain("<DispatchBoxPanel");
    expect(drawer).not.toContain("Rutas recientes");
    for (const step of ['label="Agregar pedidos"', 'label="Verificar caja"', 'label="Recibir carga"']) expect(workspace).toContain(step);
    expect(drawer).toContain("window.history.replaceState(null, \"\", closeCourierBoxHref(");
  });
  it("Rutas es una sola lista agrupada por fecha con filtro de motorizado y fecha", () => {
    const ledger = read("components/courier-routes-ledger.tsx");
    const board = read("components/grupo-gf-courier.tsx");
    expect(board).toContain("<CourierRoutesLedger");
    expect(board).toContain("<CourierBoxDrawer />");
    expect(ledger).toContain('<option value="hoy">Hoy</option>');
    expect(ledger).toContain('<option value="todas">Todas</option>');
    expect(ledger).toContain('type="date"');
    expect(ledger).toContain("sticky top-[37px]");
    expect(ledger).toContain('<option value="">Todos</option>');
  });

  it("Rutas: dos barras con caja (oficina y motorizado) y lotes pequeños en las consultas", () => {
    const ledger = readFileSync(resolve(process.cwd(), "components/courier-routes-ledger.tsx"), "utf8");
    expect(ledger).toContain("Recibida por el motorizado");
    expect(ledger).toContain("sin recibir");
    // PostgREST corta en 1.000 filas: paradas e ítems se piden por pocas rutas a la vez.
    const lib = readFileSync(resolve(process.cwd(), "lib/courier-route-ledger.ts"), "utf8");
    // Solo las consultas uno-a-muchos (paradas por ruta, ítems por caja); las de
    // una fila por id pueden ir de 200 en 200.
    expect(lib).toMatch(/chunked\(routeIds, (\d|1\d|2[0-5]), \(ids\) => sb\.from\("delivery_stops"\)/);
    expect(lib).toMatch(/chunked\(manifestIds, (\d|1\d|2[0-5]), \(ids\) =>\s*sb\.from\("dispatch_manifest_items"\)/);
    expect(lib).toContain("if (error) throw new Error(error.message);");
  });
});
