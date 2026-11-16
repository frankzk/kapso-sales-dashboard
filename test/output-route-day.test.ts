// «Salidas y guías» dice la fecha de la ruta de cada salida (owner, 16-11-2026:
// «en esta data falta la fecha de la ruta»).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { outputRouteDay } from "@/lib/output-route-day";

describe("la fecha de la ruta de cada salida", () => {
  it("Grupo GF: el día de la ruta del motorizado (parada o caja)", () => {
    expect(outputRouteDay({}, { box: { routeDate: "2026-11-14" }, stop: { routeDate: "2026-11-16" } })).toEqual({ day: "2026-11-16", text: "Ruta del lun 16/11" });
    expect(outputRouteDay({}, { box: { routeDate: "2026-11-14" }, stop: null })?.text).toBe("Ruta del sáb 14/11");
  });
  it("Aliclik: su fecha operativa; si no, el día en que salió; sin salida, cuándo se creó", () => {
    expect(outputRouteDay({ aliclik_service_date: "2026-11-04", dispatched_at: "2026-11-03T20:00:00Z" })?.text).toBe("Ruta del mié 04/11");
    expect(outputRouteDay({ dispatched_at: "2026-11-04T03:00:00Z" })?.text).toBe("Salió el mar 03/11"); // 22:00 del 03 en Lima
    expect(outputRouteDay({ created_at: "2026-11-12T15:00:00Z" })?.text).toBe("Creada el jue 12/11 · sin ruta todavía");
    expect(outputRouteDay({})).toBeNull();
  });
  it("la ficha la dice en cada salida", () => {
    expect(readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8")).toContain("const route = outputRouteDay(g, gf);");
  });
});
