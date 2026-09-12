import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Menos puertas, menos formularios: el cajón de Envíos destilado.
 *
 * Crítica del 12-09-2026, preguntas 2 y 3, y P2 de los dos formularios:
 *   * «Entregado (Fenix)» existía como resultado de llamada Y «Registrar
 *     resultado del courier» cerraba la guía como entregada: dos puertas al
 *     mismo estado terminal, una de ellas capaz de cerrar una guía que nunca
 *     salió del almacén. Queda una: la del courier.
 *   * «Paso 1 · elegir ruta» preguntaba Aliclik o Fenix cuando solo una opción
 *     estaba habilitada. Si no hay elección, no se pregunta.
 *   * El formulario manual de guía Fenix compartía `nextDate` con la llamada y
 *     vivía siempre desplegado. Tiene fecha propia y se pliega.
 *   * Las métricas de 30 días y el marcador por asesora iban encima de la cola.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const server = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");
const lib = readFileSync(resolve(process.cwd(), "lib/shipments.ts"), "utf8");
const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

describe("una sola puerta a «entregado»", () => {
  it("la llamada no ofrece «Entregado (Fenix)»", () => {
    expect(ui).not.toContain('{ key: "entregado", label: "Entregado (Fenix)" }');
    const dispositions = ui.slice(ui.indexOf("const DISPOSITIONS"), ui.indexOf("];", ui.indexOf("const DISPOSITIONS")));
    expect(dispositions).not.toMatch(/key: "entregado"/);
  });

  it("el tipo ya no la admite y el servidor la rechaza aunque llegue de una pestaña vieja", () => {
    expect(lib).not.toMatch(/\| "entregado"; \/\/ delivery confirmed/);
    expect(lib).not.toContain('case "entregado":\n      return { status: "entregado", attempts, deliveredSource: "fenix", closed: true };');
    expect(server).toContain('if ((input.disposition as string) === "entregado") {');
    expect(server).toContain("desde «Registrar resultado del courier», no desde la llamada");
  });

  it("el resultado del courier sigue siendo la puerta", () => {
    expect(lib).toContain('code: "entregado",\n    label: "Entregado",\n    optionLabel: "Entregado — cerrar la guía",');
    expect(server).toContain("export async function registerCourierReportResult(");
  });

  it("y el MOM lo dice", () => {
    expect(mom).toContain("Una sola puerta a «entregado»");
  });
});

describe("si no hay elección, no se pregunta", () => {
  it("el selector de ruta solo aparece con dos caminos reales", () => {
    expect(ui).toContain("const showRouteChooser =\n    canForceAliclik || (!!aliclikDecision?.eligible && fenixRouteAvailable);");
    expect(ui).toContain("{!showRouteChooser && (");
    expect(ui).toContain('"Ruta: Aliclik · misma guía" : "Ruta: Swayp · nueva guía"');
    expect(ui).toContain("{canForceAliclik && (");
  });
});

describe("el formulario manual tiene fecha propia y se pliega", () => {
  it("no comparte `nextDate` con la llamada", () => {
    const manual = ui.slice(ui.indexOf("Guía Swayp (antes Fénix) a mano</h3>"), ui.indexOf("Crear guía Swayp\n"));
    expect(manual).toContain("value={manualGuideDate}");
    expect(manual).not.toContain("value={nextDate}");
    expect(manual).not.toContain("nextDate ?");
  });

  it("plegado con pedido; abierto solo cuando no hay N° de pedido", () => {
    expect(ui).toContain("Ingresar una guía Swayp a mano");
    expect(ui).toContain("setShowManualGuide(!effectiveOrderName(d.shipment.order_name, d.order?.name));");
  });
});

describe("la cola va primero", () => {
  it("las métricas quedan plegadas en un resumen", () => {
    const summary = ui.slice(ui.indexOf("<details className=\"group rounded-xl"), ui.indexOf("</details>"));
    expect(summary).toContain("Resumen: reprogramaciones y gestión de hoy");
    expect(summary).toContain("<ReprogramStrip stats={reprogram} stores={stores} />");
    expect(summary).toContain("<TodayByAgentPanel rows={todayByAgent} />");
    expect(summary).not.toContain("<details open");
  });
});
