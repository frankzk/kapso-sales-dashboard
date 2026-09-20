import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("reabrir una ruta cerrada (MOM §29.14)", () => {
  it("solo con liquidación en borrador y sin cálculo diario aprobado; descarta el borrador y no toca el Master", () => {
    const src = read("app/dashboard/rutas/actions.ts");
    const start = src.indexOf("export async function reopenRoute(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("\nexport ", start + 1) === -1 ? undefined : src.indexOf("\nexport ", start + 1));
    expect(body).toContain('from("rider_daily_pay_closures")');
    expect(body).toContain('s.status !== "borrador"');
    expect(body).toContain('from("rider_settlements").delete()');
    expect(body).toContain('status: "en_curso", closed_at: null');
    expect(body).toContain('kind: "route_reopened"');
    expect(body).not.toContain("applyDeliveriesToMaster");
  });

  it("el panel ofrece «Reabrir ruta» y el pago se recarga al cambiar el estado", () => {
    const panel = read("components/routes.tsx");
    expect(panel).toContain("Reabrir ruta");
    expect(panel).toContain("key={`${detail.route.id}:${detail.route.status}`}");
    expect(read("components/order-master-shared.tsx")).toContain('route_reopened: "Ruta reabierta"');
  });

  it("Rutas: una ruta cerrada muestra el resultado del reparto y las vacías abiertas no se listan", () => {
    expect(read("components/courier-routes-ledger.tsx")).toContain('r.routeStatus !== "cerrada" && r.officeCheckedCount != null');
    expect(read("lib/courier-route-ledger.ts")).toContain('r.assignedCount > 0 || r.routeStatus === "cerrada" || r.settlementStatus != null');
  });
});
