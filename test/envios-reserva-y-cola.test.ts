import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Mirar no es trabajar, y «Siguiente» es la siguiente.
 *
 * Dos defectos que compartían origen: el cajón se comportaba igual con una guía
 * sobre la que hay algo que registrar y con una terminal que solo se consulta.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("la reserva se pide cuando hay algo que registrar", () => {
  it("una guía terminal entra en solo lectura", () => {
    // Se pedía al abrir, sin mirar el estado: auditar veinte guías Entregado
    // las bloqueaba diez minutos para quien trabajaba la cola.
    expect(ui).toContain('const eagerClaim = drawerStatus != null && (isCallable(drawerStatus) || drawerStatus === "anulado");');
    expect(ui).toContain("const shouldClaim = eagerClaim || claimRequested;");
    expect(ui).toContain("if (!shouldClaim) return;");
    expect(ui).toContain("}, [shipmentId, shouldClaim]);");
  });

  it("tocar un control la pide; tabular por el panel no", () => {
    expect(ui).toContain("onInputCapture={() => {");
    expect(ui).toContain('closest("input, select, textarea, button")');
    expect(ui).not.toContain("onFocusCapture={() => {");
  });

  it("el estado de solo lectura se dice, y no deshabilita el bloque", () => {
    expect(ui).toContain("<b>Solo lectura.</b>");
    expect(ui).toContain('disabled={claimState === "blocked" || (eagerClaim && claimState !== "mine")}');
  });

  it("cambiar de guía olvida la reserva pedida a mano", () => {
    expect(ui).toContain("setClaimRequested(false);");
  });
});

describe("«Siguiente» es la siguiente, no la primera", () => {
  it("la sucesora se anota mientras la guía abierta sigue en la lista", () => {
    expect(ui).toContain("const successorRef = useRef<{ openId: string; nextId: string | null } | null>(null);");
    expect(ui).toContain("successorRef.current = { openId, nextId: visibleOrder[openIndex + 1]?.id ?? null };");
  });

  it("y se usa cuando la abierta ya salió de la vista", () => {
    expect(ui).toContain("remembered?.openId === openId &&");
    expect(ui).toContain("visibleOrder.some((r) => r.id === remembered.nextId)");
  });

  it("el comentario ya no afirma lo que el código no hacía", () => {
    expect(ui).not.toContain("se ofrece la PRIMERA, que es la que ocupó su");
    expect(ui).toContain("es falso para toda\n   * fila menos la primera");
  });
});

describe("j/k mueven el foco de verdad", () => {
  it("el cursor enfoca el botón de la guía, no solo pinta un anillo", () => {
    expect(ui).toContain("id={`shipment-open-${s.id}`}");
    expect(ui).toContain("const target = document.getElementById(`shipment-open-${cursorId}`);");
    expect(ui).toContain("target.focus({ preventScroll: true });");
  });

  it("los atajos se anuncian en pantalla, no solo en los comentarios", () => {
    expect(ui).toContain("para moverte,");
    expect(ui).toContain("para la siguiente");
    expect(ui).toMatch(/<kbd className=/);
  });
});

describe("el orden del DOM es el orden visual", () => {
  it("ya no hay `order-*` invirtiendo el recorrido de Tab", () => {
    expect(ui).not.toMatch(/className="order-[1-5]/);
    expect(ui).not.toMatch(/ order-[1-5]"/);
  });

  it("y el comentario dice que aquello era el defecto, no la virtud", () => {
    expect(ui).toContain("Era el\n             defecto.");
    expect(ui).not.toContain("sigue siendo el de\n             siempre, de lo general a lo particular");
  });
});

describe("la cuarta salida también cierra una venta", () => {
  it("el resultado del courier que anula pide un segundo clic que nombra la guía", () => {
    expect(ui).toContain("const [confirmCourierClose, setConfirmCourierClose]");
    expect(ui).toContain("if (courierResultClosesSale && !confirmCourierClose) {");
    expect(ui).toContain("`Sí, anular la guía ${detail.shipment.guide_code}");
    expect(ui).toContain("<span className=\"font-semibold\">Esto termina la venta.</span>");
  });

  it("y el cebado no sobrevive a un cambio de opinión", () => {
    const cambios = ui.match(/setConfirmCourierClose\(false\)/g) ?? [];
    expect(cambios.length).toBeGreaterThanOrEqual(4);
  });
});
