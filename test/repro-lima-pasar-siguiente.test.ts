// Owner, 24-11-2026 (Akemi: «cuando marco el estado y le doy a pasar al siguiente me devuelve al mismo»). El mismo
// «No contesta» quedaba registrado dos y tres veces (#AUR900995, #KP201989, #KP202284). La ficha ahora usa el siguiente
// que veía quien pulsó, no recarga la página entera al pasar, y si la URL vuelve al pedido guardado, reabre el
// siguiente una vez y lo deja en los logs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClientPerformanceMetric } from "@/lib/performance-metrics";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const drawer = read("components/order-drawer.tsx");
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf(to, start));
};

describe("«Guardar y pasar al siguiente» se queda en el siguiente", () => {
  const onSaved = between(drawer, "function onReproSaved(saved: ReproSaved, advance: boolean) {", "\n  }\n");

  it("usa el siguiente que se veía al pulsar si la lista ya no da uno", () => {
    expect(drawer).toContain("reproNextRef.current = reproNext;");
    expect(onSaved).toContain("reproLimaNext(saved.orderId) ?? reproNextRef.current");
  });

  it("al pasar no recarga la página entera: guardar ya la refrescó", () => {
    const advance = onSaved.slice(0, onSaved.indexOf("return;"));
    expect(advance).toContain("goToNextRepro(saved.orderId, next);");
    expect(advance).not.toContain("onSaved();");
    expect(advance).not.toContain("void reload();");
    // Sin pasar (error, Mesa de ruta o sin siguiente): sí se relee, como antes.
    const stay = onSaved.slice(onSaved.indexOf("return;"));
    expect(stay).toContain("void reload();");
    expect(stay).toContain("onSaved();");
    expect(stay).toContain('if (wantsNext) reportClientPerformanceMetric("repro:next-missing", 0);');
  });

  it("si la URL vuelve al pedido guardado, reabre el siguiente una vez y lo registra", () => {
    const go = between(drawer, "function goToNextRepro(savedId: string, next: string) {", "\n  }\n");
    expect(go).toContain("window.history.pushState(null, \"\", href);");
    expect(go).toContain("if (new URLSearchParams(window.location.search).get(DRAWER_PARAM) !== savedId) return;");
    expect(go).toContain('reportClientPerformanceMetric("repro:next-reverted", 0);');
    expect(drawer).toContain("const REPRO_NEXT_CHECK_MS = 1500;");
  });

  it("los tres avisos llegan a los logs", () => {
    for (const name of ["repro:next", "repro:next-missing", "repro:next-reverted"]) {
      expect(parseClientPerformanceMetric({ name, durationMs: 0 })).toEqual({ name, durationMs: 0 });
    }
  });
});
