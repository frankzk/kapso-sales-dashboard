import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * MOM §11.6: la regla de fecha futura pertenece a la función que acuña, no a la
 * pantalla desde la que se llegó.
 *
 * El arreglo del 12-09 cubrió «Cliente confirma» y dejó intacta la segunda
 * puerta: el formulario de guía a mano, que llama a la MISMA
 * `rescheduleGuideCode` y no tenía `min`, ni la fecha en el `disabled`, ni
 * guarda en `createFenixGuide`. Es además la puerta que el cajón abre a la
 * fuerza cuando el envío no tiene N° de pedido.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const server = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");
const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

describe("la puerta manual, en el cliente", () => {
  it("el campo tiene piso de mañana", () => {
    const bloque = ui.slice(ui.indexOf("Fecha de reprogramación (va en la guía)"));
    expect(bloque.slice(0, 500)).toContain("min={tomorrowDateInputValue()}");
  });

  it("la fecha entra en la condición del botón, y en la de «Autogenerar»", () => {
    expect(ui).toContain("const manualGuideDateInvalid = !manualGuideDate || manualGuideDate <= localDateInputValue();");
    expect(ui).toContain("disabled={pending || !fenixGuide.trim() || manualGuideDateInvalid}");
    expect(ui).toContain("disabled={!drawerOrderName || manualGuideDateInvalid}");
  });
});

describe("la puerta manual, en el servidor", () => {
  it("`createFenixGuide` valida antes de tocar la base", () => {
    const accion = server.slice(server.indexOf("export async function createFenixGuide"));
    const cuerpo = accion.slice(0, 1200);
    expect(cuerpo).toContain("if (!isFutureShipmentFollowup(input.nextFollowupAt ?? null)) {");
    // La guarda va ANTES de crear el cliente admin y de acuñar.
    expect(cuerpo.indexOf("isFutureShipmentFollowup")).toBeLessThan(cuerpo.indexOf("spinOffFenixGuide"));
  });
});

describe("el motivo del bloqueo se puede leer con teclado", () => {
  it("no vive dentro de la etiqueta de un botón deshabilitado", () => {
    // Un `<button disabled>` está fuera del orden de tabulación: quien navega
    // con lector de pantalla recorría el formulario y nada le decía qué faltaba.
    expect(ui).toContain("const gestionBlockReason = fenixAutoUnavailable");
    expect(ui).toContain('aria-describedby={gestionBlockReason ? "gestion-motivo" : undefined}');
    expect(ui).toContain('<p id="gestion-motivo" role="status"');
    expect(ui).toContain('<p id="guia-manual-motivo"');
    // Las etiquetas del botón vuelven a decir la acción.
    expect(ui).not.toContain('"Elige la fecha para confirmar"');
    expect(ui).not.toContain('"Swayp no disponible; usa una excepción manual"');
  });
});

describe("el MOM cuenta las dos puertas", () => {
  it("§11.6 ya no afirma que una sola era las dos", () => {
    expect(mom).toContain("Hay **dos puertas** que acuñan una guía con esa función");
    expect(mom).toContain("la regla pertenece a la\nfunción que acuña, no a la pantalla desde la que se llegó");
  });
});
