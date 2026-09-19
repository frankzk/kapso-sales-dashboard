import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// La pantalla del motorizado abre el detalle de la parada en un panel al lado
// de la lista, anclado al ancho del contenedor (MOM §30.9, plan §7). Estas
// pruebas fijan la estructura para que un cambio de disposición no vuelva a
// desplegar el detalle debajo de la tarjeta ni a perder la URL.

const src = readFileSync(resolve(process.cwd(), "components/rider-route.tsx"), "utf8");

describe("detalle de la parada en panel lateral", () => {
  it("la parada abierta va en la URL y «atrás» la cierra", () => {
    expect(src).toContain('const STOP_PARAM = "parada"');
    expect(src).toContain("window.history.pushState(null, \"\", hrefWithStop(stopId))");
    expect(src).toContain("window.history.replaceState(null, \"\", hrefWithStop(null))");
    // Un id que ya no está en la ruta no deja un panel vacío.
    expect(src).toContain("stops.find((s) => s.id === wantedId) ?? null");
  });

  it("en el teléfono cubre el contenedor de la lista, no toda la web", () => {
    const panel = src.slice(src.indexOf("function StopPanel("), src.indexOf("function StopStatusLine("));
    expect(panel).toContain("fixed inset-y-0 left-1/2 z-20 w-full max-w-md -translate-x-1/2 overflow-hidden");
    expect(panel).toContain("lg:sticky");
    // Entra deslizándose desde la derecha; en pantalla ancha no anima.
    expect(panel).toContain("animate-slide-in-right lg:animate-none");
    expect(readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8")).toContain("@keyframes slide-in-right");
    expect(panel).toContain('aria-label="Volver a la lista"');
    expect(panel).toContain("overflow-y-auto");
    // El cuerpo de atrás no hace scroll mientras el panel está abierto.
    expect(src).toContain('document.body.style.overflow = "hidden"');
  });

  it("en pantalla ancha son dos columnas y la fila ya no despliega nada debajo", () => {
    expect(src).toContain("lg:grid lg:max-w-3xl lg:grid-cols-[28rem_minmax(0,1fr)]");
    const card = src.slice(src.indexOf("function StopCard("), src.indexOf("/**\n * «Lo llevo» abre el gesto único"));
    expect(card).not.toContain("ReportForm");
    expect(card).not.toContain("Abrir mapa");
    expect(card).toContain("onOpen");
  });

  it("guardar cierra el panel y refresca la lista sin competir con la URL", () => {
    expect(src).toContain("const finishStop = useCallback(() => {\n    closeStopPanel();\n    setRefreshTick((n) => n + 1);");
    expect(src).toContain("if (refreshTick) router.refresh();");
  });
});
