import { describe, expect, it } from "vitest";
import { limaHistoryFromReportedRoutes, type LimaReportedRoute } from "@/lib/lima-route-history-access";

describe("historial reconstruido desde visitas reportadas", () => {
  const proof: LimaReportedRoute = { status: "no_entregado", day: "2026-11-16", rider: "Motorizado A" };
  it("conserva todos los motorizados comprobados sin duplicarlos ni sumar intentos", () => {
    const stops = [proof, proof, { ...proof, status: "entregado", rider: "Motorizado B" }];
    const before = JSON.stringify(stops);
    expect(limaHistoryFromReportedRoutes(stops)).toEqual(["gf:Motorizado A", "gf:Motorizado B"]);
    expect(JSON.stringify(stops)).toBe(before);
  });
  it.each([
    [], [{ ...proof, status: "pendiente" }], [{ ...proof, day: null }],
    [{ ...proof, rider: null }], [proof, { ...proof, rider: " " }],
  ].map((stops) => ({ stops })))("con evidencia incompleta conserva la revisión", ({ stops }) => {
    expect(limaHistoryFromReportedRoutes(stops)).toBeNull();
  });
});
