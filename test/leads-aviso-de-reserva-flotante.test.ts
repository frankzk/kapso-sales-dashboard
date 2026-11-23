import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El aviso de «no se pudo tomar el lead» también flota.
 *
 * El banner vive en la cabecera de la lista. Quien pincha una fila cincuenta
 * más abajo no lo ve: solo nota que el cajón no se abrió. Con el tope de
 * MAX_OPEN_LEADS eso pasó de rareza a pregunta —«¿ya funciona?»—, y vale
 * igual para «X está atendiendo este lead».
 */

const ui = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");

describe("el mismo estado, dos sitios", () => {
  it("el banner en la cabecera sigue existiendo", () => {
    // El aviso de la página es el Banner del mundo de operación (DESIGN.md).
    expect(ui).toContain('<Banner tone="crit" role="alert" title="No se pudo tomar el lead">\n          {banner}');
  });

  it("y además hay un popup con rol de diálogo de alerta, alimentado por `banner`", () => {
    const popup = ui.slice(ui.indexOf('role="alertdialog"'));
    expect(popup.slice(0, 1400)).toContain('aria-live="assertive"');
    expect(popup.slice(0, 1400)).toContain('aria-labelledby="lead-claim-refused-title"');
    expect(popup.slice(0, 1400)).toContain('aria-describedby="lead-claim-refused-text"');
    expect(popup.slice(0, 1400)).toContain("{banner}");
  });

  it("es la misma cáscara que el aviso de Yape, no una tercera", () => {
    // Desde el 23-11-2026 la cáscara vive en un solo sitio (`FLOATING_ALERT`,
    // components/ops-ui.tsx) y los dos avisos la usan tal cual.
    const yape = readFileSync(resolve(process.cwd(), "components/yape-alerts.tsx"), "utf8");
    for (const src of [ui, yape]) {
      expect(src).toContain("className={FLOATING_ALERT}");
      expect(src).toContain("className={FLOATING_ALERT_ICON}");
    }
  });

  it("la cáscara es del mundo de operación: 8 px, sombra de popover y nada de rojo sólido", () => {
    const ops = readFileSync(resolve(process.cwd(), "components/ops-ui.tsx"), "utf8");
    const cascara = /export const FLOATING_ALERT =\s*"([^"]+)"/.exec(ops)?.[1] ?? "";
    expect(cascara).toContain("rounded-lg");
    expect(cascara).toContain("shadow-pop");
    expect(cascara).not.toMatch(/rounded-(xl|2xl)|shadow-(md|lg|xl|2xl)|red-|border-2|ring-4/);
  });

  it("el aviso de Yape tampoco usa emoji", () => {
    const yape = readFileSync(resolve(process.cwd(), "components/yape-alerts.tsx"), "utf8");
    const popup = yape.slice(yape.indexOf('role="alertdialog"'), yape.indexOf("export function YapeAssign"));
    expect(popup).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe("se cierra por las tres vías", () => {
  it("«Entendido», Escape, y abrir el siguiente lead", () => {
    expect(ui).toContain("onClick={() => setBanner(null)}");
    expect(ui).toContain('if (e.key === "Escape") {');
    // `abrirLeadPorId` ya limpiaba el banner al empezar; ahora eso también
    // cierra el popup, porque son el mismo estado.
    expect(ui).toContain("setBanner(null);\n    setSelected(previa ?? null);");
  });

  it("al aparecer, el foco va al botón", () => {
    expect(ui).toContain("bannerDismissRef.current?.focus();");
    expect(ui).toContain("ref={bannerDismissRef}");
  });

  it("el icono es dibujado, no un emoji", () => {
    const popup = ui.slice(ui.indexOf('role="alertdialog"'), ui.indexOf('role="alertdialog"') + 1400);
    expect(popup).toContain("<IconAlert");
    expect(popup).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
