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
    expect(ui).toContain('className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"');
  });

  it("y además hay un popup con rol de diálogo de alerta, alimentado por `banner`", () => {
    const popup = ui.slice(ui.indexOf('role="alertdialog"'));
    expect(popup.slice(0, 1400)).toContain('aria-live="assertive"');
    expect(popup.slice(0, 1400)).toContain('aria-labelledby="lead-claim-refused-title"');
    expect(popup.slice(0, 1400)).toContain('aria-describedby="lead-claim-refused-text"');
    expect(popup.slice(0, 1400)).toContain("{banner}");
  });

  it("es la misma cáscara que el aviso de Yape, no una tercera", () => {
    const yape = readFileSync(resolve(process.cwd(), "components/yape-alerts.tsx"), "utf8");
    const cascara =
      'className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-red-300 bg-white shadow-2xl ring-4 ring-red-500/10"';
    expect(ui).toContain(cascara);
    expect(yape).toContain(cascara);
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
