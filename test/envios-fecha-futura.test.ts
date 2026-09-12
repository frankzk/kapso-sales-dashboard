import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isFutureShipmentFollowup, isTodayOrLaterDelivery, ALICLIK_MAX_INTENTOS } from "@/lib/shipments";

/**
 * Una reprogramación confirmada no puede ser de ayer.
 *
 * Tercera crítica (28/40), el P0: el `min` del input solo cubría «programar»,
 * `requiredDateMissing` solo exigía que la fecha EXISTIERA, y el servidor
 * tampoco validaba futuro para «confirma». Resultado: se emitía una guía Swayp
 * con la fecha pasada ESTAMPADA EN SU NÚMERO (`rescheduleGuideCode`) y un
 * despacho agendado para un día que ya pasó, en la acción más frecuente de la
 * pantalla.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const server = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");
const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

const NOW = new Date("2026-09-12T18:00:00.000Z"); // 13:00 en Lima

describe("la regla, pura", () => {
  it("una llamada programada exige el día siguiente; hoy no vale", () => {
    expect(isFutureShipmentFollowup("2026-09-13T00:00:00.000Z", NOW)).toBe(true);
    expect(isFutureShipmentFollowup("2026-09-12T00:00:00.000Z", NOW)).toBe(false);
    expect(isFutureShipmentFollowup("2026-09-11T00:00:00.000Z", NOW)).toBe(false);
    expect(isFutureShipmentFollowup(null, NOW)).toBe(false);
  });

  it("una entrega informada por el courier admite HOY, pero no ayer", () => {
    // El motorizado puede reprogramar para más tarde el mismo día.
    expect(isTodayOrLaterDelivery("2026-09-12T00:00:00.000Z", NOW)).toBe(true);
    expect(isTodayOrLaterDelivery("2026-09-13T00:00:00.000Z", NOW)).toBe(true);
    expect(isTodayOrLaterDelivery("2026-09-11T00:00:00.000Z", NOW)).toBe(false);
    expect(isTodayOrLaterDelivery(null, NOW)).toBe(false);
  });
});

describe("las dos puertas: el botón y el servidor", () => {
  it("«confirma» y «programar» comparten la exigencia de futuro en el cliente", () => {
    expect(ui).toContain('const dateNeedsFuture = disposition === "programar" || disposition === "confirma";');
    expect(ui).toContain("const programDateInvalid = dateNeedsFuture && (!nextDate || nextDate <= localDateInputValue());");
    expect(ui).toContain('disposition === "programar" || disposition === "confirma"\n                        ? tomorrowDateInputValue()');
  });

  it("el servidor no se fía del `min` del navegador", () => {
    expect(server).toContain('if (input.disposition === "confirma" && !isFutureShipmentFollowup(input.nextFollowupAt)) {');
    expect(server).toContain("La fecha de reprogramación tiene que ser futura.");
    expect(server).toContain("if (!isTodayOrLaterDelivery(parsed.toISOString())) {");
  });

  it("la fecha del courier también tiene piso en el formulario", () => {
    const block = ui.slice(ui.indexOf("Nueva fecha de entrega informada por Swayp"));
    expect(block.slice(0, 400)).toContain("min={localDateInputValue()}");
  });
});

describe("los topes de intentos son constantes, no texto", () => {
  it("la métrica del cajón usa las mismas que la transición", () => {
    expect(ui).toContain("/ ${MAX_INTENTOS}`");
    expect(ui).toContain("/ ${ALICLIK_MAX_INTENTOS}`");
    expect(ui).not.toMatch(/\/ 7`/);
    expect(ui).not.toMatch(/\/ 3`/);
    expect(ALICLIK_MAX_INTENTOS).toBe(3);
  });
});

describe("el MOM lo dice", () => {
  it("§11.6 nombra la fecha futura y dónde se valida", () => {
    expect(mom).toContain("### 11.6 Una reprogramación confirmada no puede ser de ayer");
  });
});
