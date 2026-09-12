import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El cajón de Envíos: lo que responde una acción tiene que VERSE, y verse como
 * lo que es.
 *
 * Crítica del 12-09-2026 (22/40). Tres fallos de retroalimentación: el aviso
 * de éxito se borraba solo (cada acción recarga el detalle y la recarga lo
 * limpiaba), un error se pintaba igual que un aviso (gris, sin rol), y una
 * carga fallida dejaba «Cargando…» para siempre. Además, el historial quedaba
 * fuera del bloqueo de reserva, el error de exportación solo se mostraba en
 * «En ruta», y un F5 con el panel abierto bloqueaba la guía diez minutos.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

function between(start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  expect(i, start).toBeGreaterThan(-1);
  expect(j, end).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("la respuesta de una acción se queda hasta la siguiente", () => {
  it("solo se limpia al cambiar de guía, no en cada recarga del detalle", () => {
    // El efecto que limpia depende SOLO de shipmentId…
    expect(src).toContain("setFeedback(null);\n  }, [shipmentId]);");
    // …y el efecto de carga (shipmentId + reloadKey) ya no la toca.
    const loadEffect = between("loadShipmentDetail(shipmentId)", "}, [shipmentId, reloadKey]);");
    expect(loadEffect).not.toContain("setFeedback(null)");
    expect(src).not.toContain("setMsg(");
  });

  it("error y aviso llevan color y rol distintos", () => {
    const render = between("{feedback && (", "{feedback.text}");
    expect(render).toContain('role={feedback.kind === "error" ? "alert" : "status"}');
    expect(render).toContain("border-rose-200 bg-rose-50 text-rose-800");
    expect(render).toContain("border-emerald-200 bg-emerald-50 text-emerald-800");
    expect(render).toContain("break-words");
  });

  it("una acción que LANZA (red caída) también se ve como error", () => {
    const run = between("  function run(", "  const programDateInvalid");
    expect(run).toContain("r = await fn();");
    expect(run).toContain("} catch {");
    expect(run).toContain('setFeedback({ kind: "error", text: r.error });');
    expect(run).toContain('{ kind: "notice", text: r.notice }');
  });
});

describe("una carga fallida no deja «Cargando…» para siempre", () => {
  it("la promesa tiene catch y el error ofrece reintentar o cerrar", () => {
    expect(src).toContain("loadShipmentDetail(shipmentId)\n      .catch(() => ({");
    const errorView = between('{detail && "error" in detail ? (', ") : !detail ? (");
    expect(errorView).toContain('role="alert"');
    expect(errorView).toContain("onClick={refresh}");
    expect(errorView).toContain("Reintentar");
    expect(errorView).toContain("onClick={handleClose}");
  });
});

describe("lo que no se ve no se puede corregir", () => {
  it("el historial queda dentro del bloqueo de reserva", () => {
    const history = src.indexOf("<ShipmentGuideHistory guides={detail.guideHistory}");
    const fieldsetOpen = src.indexOf('<fieldset disabled={claimState !== "mine"}');
    const fieldsetClose = src.indexOf("</fieldset>", history);
    expect(fieldsetOpen).toBeGreaterThan(-1);
    expect(fieldsetOpen).toBeLessThan(history);
    expect(fieldsetClose).toBeGreaterThan(history);
  });

  it("el error de exportación se muestra en cualquier pestaña y se puede cerrar", () => {
    expect(src).not.toContain('fenixExportError && view === "en_ruta"');
    const block = between("{fenixExportError && (", "{fenixExportError}");
    expect(block).toContain('role="alert"');
    expect(src).toContain("onClick={() => setFenixExportError(null)}");
  });
});

describe("cerrar o recargar la pestaña suelta la reserva", () => {
  it("el panel manda un beacon en pagehide, solo mientras la reserva es suya", () => {
    const claimEffect = between("const onPageHide = () => {", "}, [shipmentId]);");
    expect(claimEffect).toContain('navigator.sendBeacon?.(\n        "/api/envios/release-claim"');
    expect(claimEffect).toContain('window.addEventListener("pagehide", onPageHide)');
    expect(claimEffect).toContain('window.removeEventListener("pagehide", onPageHide)');
    // Se registra DESPUÉS de que la reserva es nuestra, no antes.
    expect(claimEffect.indexOf('setClaimState("mine")')).toBeLessThan(
      claimEffect.indexOf('window.addEventListener("pagehide"'),
    );
  });

  it("la ruta solo suelta una reserva PROPIA y exige sesión", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/envios/release-claim/route.ts"), "utf8");
    expect(route).toContain("sb.auth.getClaims()");
    expect(route).toContain("return new Response(null, { status: 401 })");
    expect(route).toContain('.eq("claimed_by", userId)');
    expect(route).toContain("UUID.test(shipmentId)");
  });
});
