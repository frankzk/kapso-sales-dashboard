import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { courierRouteHref } from "@/lib/courier-navigation";
const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));
import LegacyRoutesPage from "@/app/dashboard/rutas/page";
const read = (path: string) => readFileSync(path, "utf8");

describe("Rutas pertenece a Grupo GF Courier", () => {
  it("preserva id, fecha y parámetros repetidos de enlaces antiguos", () => {
    expect(courierRouteHref({ id: "roy-route", dia: "2026-09-13", filter: ["a", "b"] }))
      .toBe("/dashboard/courier/reparto?id=roy-route&dia=2026-09-13&filter=a&filter=b");
  });
  it("redirige el acceso antiguo sin crear ni modificar una ruta", async () => {
    await LegacyRoutesPage({ searchParams: Promise.resolve({ id: "existing" }) });
    expect(redirect).toHaveBeenCalledWith("/dashboard/courier/reparto?id=existing");
  });
  it("no acepta un destino de redirección suministrado por query", () => {
    expect(courierRouteHref({ next: "https://example.test" })).toMatch(/^\/dashboard\/courier\/reparto\?/);
  });
  it("no ofrece una entrada Rutas independiente", () => {
    expect(read("components/sidebar.tsx")).not.toContain('href: "/dashboard/rutas"');
  });
  it("conserva el control de permisos: la página redirige y la acción del panel vuelve a comprobar", () => {
    const page = read("app/dashboard/courier/reparto/page.tsx");
    expect(page).toContain('perms.can("routes.manage")');
    expect(page).toContain('perms.can("routes.report_others")');
    const actions = read("app/dashboard/courier/actions.ts");
    const report = actions.slice(actions.indexOf("export async function loadCourierRouteReport("));
    expect(report).toContain('permissions.can("routes.manage")');
    expect(report).toContain("routeReportAccess(id)");
  });
  it("sin ruta abierta, Reparto manda a la lista única de Rutas; con ruta, al panel lateral (MOM §29.14)", () => {
    const page = read("app/dashboard/courier/reparto/page.tsx");
    expect(page).toContain('if (!sp.id) redirect("/dashboard/courier/rutas")');
    expect(page).toContain("legacyReportHref(sp.id");
    expect(read("components/courier-route-report-drawer.tsx")).toContain("detailOnly");
    expect(read("components/grupo-gf-courier.tsx")).not.toContain("Reparto y cierre diario");
    expect(read("components/grupo-gf-courier.tsx")).not.toContain("Cajas y cotejos");
  });
  it("reparto y cierre se abre desde la columna Liquidación de la lista, no desde la caja", () => {
    const ledger = read("components/courier-routes-ledger.tsx");
    expect(ledger).toContain("courierReportHref(r.routeId, location)");
    expect(ledger).toContain("Reparto y liquidación");
    expect(read("components/courier-box-drawer.tsx")).not.toContain("Reparto y liquidación");
    expect(read("components/dispatch-workspace.tsx")).not.toContain("Ver reparto y liquidación");
    expect(read("components/dispatch-workspace.tsx")).not.toContain("Ir a tomar y asignar pedidos");
    expect(read("components/settlements.tsx")).toContain("/dashboard/courier/reparto");
    for (const path of ["components/courier-box-drawer.tsx", "components/dispatch-workspace.tsx", "components/settlements.tsx"]) {
      expect(read(path)).not.toContain("`/dashboard/rutas?");
    }
  });
  it("actualiza el cierre visible después de reportar o aprobar", () => {
    for (const path of ["app/reparto/actions.ts", "app/dashboard/rutas/pay-actions.ts", "app/dashboard/rutas/actions.ts"]) {
      expect(read(path)).toContain('revalidatePath("/dashboard/courier/reparto")');
    }
  });
});
