import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lo que cierra una venta se confirma; lo que se escribió no se pierde.
 *
 * Segunda crítica (25/40). El P0: «Cliente cancela / anula» cerraba el pedido
 * con el mismo botón «Registrar llamada» que un «No contesta». Y dos P1 del
 * mismo tipo: con los intentos agotados, un «No contesta» más anulaba la guía
 * sin decirlo, y un clic fuera del cajón se llevaba la nota a medio escribir.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

function between(start: string, end: string): string {
  const i = ui.indexOf(start);
  const j = ui.indexOf(end, i);
  expect(i, start).toBeGreaterThan(-1);
  expect(j, end).toBeGreaterThan(i);
  return ui.slice(i, j);
}

describe("«Cliente cancela / anula» pide un segundo clic que nombra el pedido", () => {
  it("la confirmación nombra guía y pedido, y se puede cancelar", () => {
    expect(ui).toContain('const cancelNeedsConfirm = disposition === "cancela";');
    expect(ui).toContain("{cancelNeedsConfirm && confirmCancel ? (");
    expect(ui).toContain("`Sí, anular la guía ${detail.shipment.guide_code}");
    expect(ui).toContain("del pedido ${detail.shipment.order_name}");
    expect(ui).toContain('"Anular la guía…"');
    // El primer clic no registra: solo abre la confirmación.
    const button = between("if (cancelNeedsConfirm) {", "run(() =>");
    expect(button).toContain("setConfirmCancel(true);");
    expect(button).toContain("return;");
  });

  it("cambiar de resultado retira la confirmación pendiente", () => {
    expect(ui).toContain("setDisposition(e.target.value as RerouteDisposition);\n                      setConfirmCancel(false);");
  });
});

describe("el último intento avisa antes de anular", () => {
  it("se calcula con la misma constante que la transición y lo dice en ámbar", () => {
    expect(ui).toContain("const lastAttemptWillCancel =");
    expect(ui).toContain('disposition === "no_contesta" &&');
    expect(ui).toContain("(shipment.reroute_attempts ?? 0) >= MAX_INTENTOS;");
    expect(ui).toContain("{lastAttemptWillCancel && (");
    expect(ui).toContain("<b>Es el último intento.</b>");
    expect(ui).toContain('"Registrar y anular la guía"');
  });
});

describe("el cajón no se lleva lo escrito", () => {
  it("cerrar y saltar a otra guía pasan por la misma puerta", () => {
    expect(ui).toContain("const hasDraft = draftFields.some((v) => v.trim().length > 0) || showAddressEditor;");
    expect(ui).toContain("function requestExit(exit: { kind: \"close\" } | { kind: \"open\"; id: string }) {");
    expect(ui).toContain("requestExit({ kind: \"close\" });");
    expect(ui).toContain("requestExit({ kind: \"open\", id });");
    expect(ui).toContain("if (hasDraft) {\n      setPendingExit(exit);");
  });

  it("el aviso deja seguir o descartar, y nombra lo que va a pasar", () => {
    const alert = between("{pendingExit && (", 'role="status"');
    expect(alert).toContain('role="alert"');
    expect(alert).toContain("Seguir aquí");
    expect(alert).toContain('pendingExit.kind === "open" ? "Descartar y seguir" : "Descartar y cerrar"');
    expect(alert).toContain("onClick={() => doExit(pendingExit)}");
  });

  it("la nota del historial no deja «Guardando…» para siempre", () => {
    expect(ui).toContain("await updateShipmentCallNote(call.id, draft).catch(() => ({");
  });
});

describe("el MOM lo documenta", () => {
  it("§11.5 nombra las tres salidas terminales y el borrador", () => {
    expect(mom).toContain("### 11.5 Lo que cierra una venta se confirma, y se avisa antes");
    expect(mom).toContain("Sí, anular la guía AUR5X… del pedido #KP…");
    expect(mom).toContain("**El último intento.**");
  });
});
