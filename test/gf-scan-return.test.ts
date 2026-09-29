import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxDayShort, pastBoxDecision, pastBoxMessage, receivedFromLabel } from "@/lib/gf-scan-return";

const today = "2026-09-29";

describe("escanear un paquete que sigue en la caja de otro día", () => {
  it("#KP136779: «No entregado · reprogramado» en la caja del 26/09 se recibe y se asigna", () => {
    expect(
      pastBoxDecision({ boxRouteDate: "2026-09-26", targetDay: today, stopStatus: "no_entregado", outcomeReason: "reprogramado" }),
    ).toBe("recibir_y_asignar");
  });

  it("cualquier motivo de no entregado que no sea rechazo se reprograma", () => {
    for (const reason of ["no_contesta", "no_estaba", "direccion_errada", "sin_dinero", "otro", null]) {
      expect(
        pastBoxDecision({ boxRouteDate: "2026-09-16", targetDay: today, stopStatus: "no_entregado", outcomeReason: reason }),
        String(reason),
      ).toBe("recibir_y_asignar");
    }
  });

  it("un rechazo se recibe como devuelto y no se asigna (0189)", () => {
    expect(
      pastBoxDecision({ boxRouteDate: "2026-09-26", targetDay: today, stopStatus: "no_entregado", outcomeReason: "rechazado" }),
    ).toBe("recibir_rechazado");
  });

  it("sin reporte no se toca: la parada es de la liquidación de ese motorizado", () => {
    expect(pastBoxDecision({ boxRouteDate: "2026-09-26", targetDay: today, stopStatus: "pendiente", outcomeReason: null })).toBe("sin_reporte");
    expect(pastBoxDecision({ boxRouteDate: "2026-09-26", targetDay: today, stopStatus: null, outcomeReason: null })).toBe("sin_reporte");
  });

  it("uno entregado no se vuelve a asignar", () => {
    expect(pastBoxDecision({ boxRouteDate: "2026-09-26", targetDay: today, stopStatus: "entregado", outcomeReason: null })).toBe("entregado");
  });

  it("la caja del MISMO día sigue la regla de siempre, aunque la parada diga no entregado", () => {
    expect(
      pastBoxDecision({ boxRouteDate: today, targetDay: today, stopStatus: "no_entregado", outcomeReason: "no_contesta" }),
    ).toBe("misma_caja");
  });

  it("armando la caja de mañana, la de hoy ya es «anterior»", () => {
    expect(
      pastBoxDecision({ boxRouteDate: today, targetDay: "2026-09-30", stopStatus: "no_entregado", outcomeReason: "no_contesta" }),
    ).toBe("recibir_y_asignar");
    // …pero lo que el motorizado todavía lleva sin reportar no se toca.
    expect(pastBoxDecision({ boxRouteDate: today, targetDay: "2026-09-30", stopStatus: "pendiente", outcomeReason: null })).toBe("sin_reporte");
  });
});

describe("lo que dice la línea", () => {
  it("nombra la caja con su día", () => {
    expect(boxDayShort("2026-09-26")).toBe("26/09");
    expect(receivedFromLabel("Yhoni", "2026-09-26")).toBe("Yhoni del 26/09");
    expect(pastBoxMessage("sin_reporte", "Yhoni", "2026-09-26")).toContain("la caja de Yhoni del 26/09");
    expect(pastBoxMessage("recibir_rechazado", "Yhoni", "2026-09-26")).toMatch(/devuelto y no se reprograma/);
    expect(pastBoxMessage("entregado", "Yhoni", "2026-09-26")).toMatch(/reportó entregado/);
  });
});

describe("el escaneo usa la regla antes de decir «Ya estaba»", () => {
  const src = readFileSync("app/dashboard/courier/actions.ts", "utf8");
  const scan = src.slice(src.indexOf("export async function scanAssignToRider"), src.indexOf("export interface CourierBoxDetail"));

  it("mira el día de la caja y recibe con el mismo RPC que «Devoluciones»", () => {
    const past = scan.indexOf("box.dispatch_manifests.route_date < boxDay");
    const already = scan.indexOf('status: "ya_en_caja"');
    expect(past).toBeGreaterThan(0);
    expect(already).toBeGreaterThan(past);
    expect(scan).toContain('admin.rpc("gf_return_to_office", { p_item_id: box.id');
    expect(scan).toContain("pastBoxDecision(");
  });

  it("la parada se lee de ESA caja, la más reciente", () => {
    expect(scan).toMatch(/\.eq\("dispatch_manifest_id", box\.manifest_id\)\s*\.order\("reported_at", \{ ascending: false, nullsFirst: false \}\)/);
  });

  it("un rechazo recibido no llega a tomarse ni asignarse", () => {
    const rejected = scan.indexOf('decision === "recibir_rechazado"');
    const take = scan.indexOf("takeOrdersCore(");
    expect(rejected).toBeGreaterThan(0);
    expect(take).toBeGreaterThan(rejected);
    expect(scan.slice(rejected, rejected + 300)).toContain("return {");
  });
});
