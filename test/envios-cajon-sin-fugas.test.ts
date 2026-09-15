import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lo que se escribió de una clienta no puede aparecer en la ficha de la
 * siguiente.
 *
 * `setNote("")` y `setNextDate("")` no existían en el archivo, y `git log -S`
 * confirma que NUNCA existieron. Como el cajón tampoco se remontaba al cambiar
 * de guía —se pasaba `shipmentId` a la misma instancia—, los 39 `useState`
 * sobrevivían: la guía B abría con la nota de A en el textarea, la fecha de A
 * en el campo y el botón habilitado. Un clic escribía la llamada de A en el
 * expediente de B y la despachaba con la fecha de A.
 *
 * El aviso ámbar decía «se descarta» y no descartaba. Y como la nota vieja
 * seguía ahí después de registrar bien, el aviso saltaba en cada «Siguiente»
 * del camino feliz: a doscientas guías por turno, eso enseña a descartarlo sin
 * leer, que es el hábito que un día se come una nota de verdad.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("una guía, un cajón", () => {
  it("cambiar de guía remonta el componente", () => {
    // Es el arreglo POR CONSTRUCCIÓN: el próximo estado que alguien añada al
    // cajón no puede filtrarse aunque olvide su reseteo.
    const mount = ui.slice(ui.indexOf("{openId && ("), ui.indexOf("{openId && (") + 1800);
    expect(mount).toContain("key={openId}");
    expect(mount).toContain("shipmentId={openId}");
  });

  it("la key va sobre el cajón, no sobre otra cosa", () => {
    const i = ui.indexOf("key={openId}");
    expect(i).toBeGreaterThan(-1);
    expect(ui.slice(Math.max(0, i - 2200), i)).toContain("<ShipmentDrawer");
  });
});

describe("cada acción limpia lo suyo", () => {
  it("LAS DOS llamadas a registrar vacían la nota y la fecha", () => {
    // Son dos sitios: el botón normal y el confirmar de «Cliente cancela».
    // La primera versión de este arreglo solo tocó uno, y esta prueba
    // encontró el otro.
    const sitios = [...ui.matchAll(/registerRerouteCall\(shipmentId, \{/g)].map((m) => m.index ?? 0);
    expect(sitios).toHaveLength(2);
    for (const i of sitios) {
      const submit = ui.slice(i, i + 1100);
      expect(submit).toContain('setNote("");');
      expect(submit).toContain('setNextDate("");');
    }
  });

  it("crear la guía a mano vacía el número y su fecha", () => {
    // Un número ya usado choca contra el duplicado si se reenvía.
    const bloque = ui.slice(ui.indexOf("createFenixGuide(shipmentId, {"));
    const submit = bloque.slice(0, 900);
    expect(submit).toContain('setFenixGuide("");');
    expect(submit).toContain('setManualGuideDate("");');
  });

  it("las cinco acciones del cajón tienen reseteo", () => {
    for (const accion of [
      "registerRerouteCall(shipmentId, {",
      "createFenixGuide(shipmentId, {",
      "registerRecoveryCall(shipmentId, {",
      "registerCourierReportResult(shipmentId, {",
      "reprogramCancelledShipmentException(shipmentId, {",
    ]) {
      const i = ui.indexOf(accion);
      expect(i, accion).toBeGreaterThan(-1);
      // `run(fn, onSuccess)`: el segundo argumento es una flecha que resetea.
      expect(ui.slice(i, i + 1100), accion).toMatch(/\)\s*,\s*(\/\/[^\n]*\n\s*)*\(\) =>\s*\{/);
    }
  });
});
