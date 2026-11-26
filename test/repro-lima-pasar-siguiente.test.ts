// Owner, 24-11-2026 (Akemi: «cuando marco el estado y le doy a pasar al siguiente me devuelve al mismo»). El mismo
// «No contesta» quedaba registrado dos y tres veces (#AUR900995, #KP201989, #KP202284). La ficha ahora usa el siguiente
// que veía quien pulsó, no recarga la página entera al pasar, y si la URL vuelve al pedido guardado, reabre el
// siguiente una vez y lo deja en los logs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClientPerformanceMetric } from "@/lib/performance-metrics";
import {
  advanceReproLima,
  clearReproLimaAdvance,
  REPRO_ADVANCE_CONFIRM_MS,
  REPRO_ADVANCE_GUARD_MS,
  REPRO_ADVANCE_REFRESH_MS,
  reproAdvancePin,
  reproLimaAdvance,
  reproLimaRefreshOwed,
  reproLimaRefreshPaid,
  subscribeReproLimaAdvance,
} from "@/lib/repro-lima-queue";

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

// La usuaria principal, 25-11-2026, con video: «aún se queda en el mismo pedido». Guarda bien (la actividad pasa
// de 21 a 22), la ficha queda en blanco unos 4,5 s y vuelve a abrir el MISMO pedido, en «Operar».
//
// Reproducido en un navegador real con esta versión de Next y la misma secuencia (guardar → pushState):
//   1. El guardado revalidaba y su respuesta traía la pantalla entera. Al pasar al siguiente en ese instante el
//      router descartaba esa pantalla y la pedía dos veces más: tres lecturas enteras a la vez.
//   2. El cambio de URL ocurre con el guardado aún aplicándose y el router no se lo queda: sigue creyendo que la
//      página es la del pedido guardado. La siguiente lectura pide ESA página y, al llegar, repone su URL.
// La comprobación única a 1,5 s (24-11) no alcanzaba: la URL regresaba cuando llegaba la lectura, segundos después.
describe("«Guardar y pasar al siguiente»: la ficha se queda en el siguiente aunque la URL regrese", () => {
  const T0 = 1_000_000;

  it("mientras la URL diga el pedido recién guardado, la ficha enseña el siguiente", () => {
    const advance = { from: "guardado", to: "siguiente", at: T0 };
    expect(reproAdvancePin(advance, "guardado", T0)).toBe("siguiente");
    // El caso del video: la URL regresa 4,5 s después.
    expect(reproAdvancePin(advance, "guardado", T0 + 4_500)).toBe("siguiente");
    expect(reproAdvancePin(advance, "guardado", T0 + REPRO_ADVANCE_GUARD_MS - 1)).toBe("siguiente");
  });

  it("la URL manda en todo lo demás: el siguiente, otro pedido, sin ficha, o pasada la guarda", () => {
    const advance = { from: "guardado", to: "siguiente", at: T0 };
    expect(reproAdvancePin(advance, "siguiente", T0 + 100)).toBeNull();
    expect(reproAdvancePin(advance, "otro", T0 + 100)).toBeNull();
    expect(reproAdvancePin(advance, null, T0 + 100)).toBeNull();
    expect(reproAdvancePin(null, "guardado", T0 + 100)).toBeNull();
    // Pasados 30 s, abrir el pedido guardado es abrir el pedido guardado.
    expect(REPRO_ADVANCE_GUARD_MS).toBe(30_000);
    expect(reproAdvancePin(advance, "guardado", T0 + REPRO_ADVANCE_GUARD_MS)).toBeNull();
    // Un reloj que retrocede o un paso a sí mismo no fijan nada.
    expect(reproAdvancePin(advance, "guardado", T0 - 1)).toBeNull();
    expect(reproAdvancePin({ from: "a", to: "a", at: T0 }, "a", T0)).toBeNull();
  });

  it("el aviso entre la ficha y quien la monta: pasar, soltar, y la lista que se debe", () => {
    clearReproLimaAdvance();
    reproLimaRefreshPaid();
    let calls = 0;
    const off = subscribeReproLimaAdvance(() => { calls += 1; });
    advanceReproLima("a", "b", true, T0);
    expect(reproLimaAdvance()).toEqual({ from: "a", to: "b", at: T0 });
    expect(reproLimaRefreshOwed()).toBe(T0);
    expect(calls).toBe(1);
    // El mismo objeto mientras nada cambia (`useSyncExternalStore`).
    expect(reproLimaAdvance()).toBe(reproLimaAdvance());
    // Otro paso antes de pagar la lista: la espera vuelve a contar desde el nuevo.
    advanceReproLima("b", "c", true, T0 + 1_000);
    expect(reproLimaRefreshOwed()).toBe(T0 + 1_000);
    // Un paso cuyo guardado sí trajo la lista no borra lo que se debía.
    advanceReproLima("c", "d", false, T0 + 2_000);
    expect(reproLimaRefreshOwed()).toBe(T0 + 1_000);
    // Soltar la guarda (cerrar, abrir otro, ir atrás) no perdona la lista: el tablero la sigue necesitando.
    clearReproLimaAdvance();
    expect(reproLimaAdvance()).toBeNull();
    expect(reproLimaRefreshOwed()).toBe(T0 + 1_000);
    const before = calls;
    clearReproLimaAdvance();
    expect(calls).toBe(before);
    reproLimaRefreshPaid();
    expect(reproLimaRefreshOwed()).toBeNull();
    reproLimaRefreshPaid();
    expect(calls).toBe(before + 1);
    off();
  });

  it("los tiempos: confirmar la URL con el guardado asentado, y la lista bastante después", () => {
    expect(REPRO_ADVANCE_CONFIRM_MS).toBe(600);
    expect(REPRO_ADVANCE_REFRESH_MS).toBe(2_500);
    // La lista se pide después de confirmar la URL: si no, pide la página del pedido guardado y la repone.
    expect(REPRO_ADVANCE_REFRESH_MS).toBeGreaterThan(REPRO_ADVANCE_CONFIRM_MS * 2);
  });
});

describe("al pasar al siguiente, el guardado no trae la pantalla", () => {
  const actions = read("app/dashboard/pedidos/repro-lima/actions.ts");
  const panel = read("components/repro-lima-panel.tsx");
  const host = read("components/order-drawer-host.tsx");
  const link = read("components/order-link.tsx");

  it("el servidor solo lo cumple cuando la ficha de verdad va a pasar", () => {
    const record = actions.slice(actions.indexOf("async function recordCall("), actions.indexOf("async function clearPrograms("));
    // Con error o Mesa de ruta la ficha se queda; con venta anulada o programa cambiado, hay más que refrescar.
    expect(record).toContain("const refreshDeferred = Boolean(input.deferRefresh) && !saleNotice && !next.error && !next.href && !next.programChanged;");
    expect(record).toContain("if (!refreshDeferred) {\n      revalidatePath(REPRO_LIMA_PATH);\n      if (next.programChanged) revalidatePath(COURIER_PATH);\n    }");
    expect(record).toContain("...(refreshDeferred ? { refreshDeferred: true } : {}),");
    // «Desarmar y cerrar sin llamada» no lo pide: revalida como siempre.
    const close = actions.slice(actions.indexOf("export async function closeReproCase("), actions.indexOf("async function recordCall("));
    expect(close).not.toContain("deferRefresh");
  });

  it("la hoja lo pide solo si hay siguiente, y dice si la pantalla vino", () => {
    expect(panel).toContain("if (advance && hasNext) input.deferRefresh = true;");
    expect(panel).toContain("refreshed: Boolean(result.callId) && !result.refreshDeferred,");
  });

  it("la ficha cambia la URL y después anota el paso; si no pasa, pide la pantalla ella", () => {
    const advance = onSavedBody().slice(0, onSavedBody().indexOf("return;"));
    expect(advance.indexOf("goToNextRepro(saved.orderId, next);")).toBeGreaterThan(-1);
    expect(advance.indexOf("advanceReproLima(saved.orderId, next, !saved.refreshed);")).toBeGreaterThan(advance.indexOf("goToNextRepro(saved.orderId, next);"));
    // Sin siguiente (o con error), la ficha se queda y la pantalla se pide en el acto.
    expect(onSavedBody()).toContain("if (!saved.refreshed) onSaved();");
  });

  it("quien monta la ficha enseña el siguiente, corrige la URL, la confirma y pide la lista de fondo", () => {
    expect(host).toContain("const pinnedTo = reproAdvancePin(advance, request?.orderId, Date.now());");
    expect(host).toContain("key={pinnedTo ?? request.orderId}");
    expect(host).toContain("orderId={pinnedTo ?? request.orderId}");
    // Vuelve a la pestaña «Repro Lima», no a «Operar».
    expect(host).toContain('initialWorkspace={workspaceForDrawerSection(pinnedTo ? "reprolima" : request.section)}');
    expect(host).toContain('window.history.replaceState(null, "", orderDrawerHref(pinnedTo, "reprolima", { pathname, search }));');
    // No cuenta como «regresó» lo que solo es el hook atrasado.
    expect(host).toContain("if (bar?.orderId === pinnedTo) return;");
    expect(host).toContain("}, Math.max(0, advance.at + REPRO_ADVANCE_CONFIRM_MS - Date.now()));");
    const refresh = host.slice(host.indexOf("const refreshOwedAt = useSyncExternalStore("));
    expect(refresh.slice(0, refresh.indexOf("if (!request) return null;"))).toContain("reproLimaRefreshPaid();\n      router.refresh();\n    }, Math.max(0, refreshOwedAt + REPRO_ADVANCE_REFRESH_MS - Date.now()));");
  });

  it("decidir otra cosa suelta la guarda: cerrar, ir atrás, abrir un pedido", () => {
    const close = host.slice(host.indexOf("const close = useCallback(() => {"), host.indexOf("}, [pathname, search]);"));
    expect(close).toContain("clearReproLimaAdvance();");
    expect(host).toContain('window.addEventListener("popstate", onPop);');
    expect(host).toContain("if (advance && shownOrderId && shownOrderId !== advance.from && shownOrderId !== advance.to) clearReproLimaAdvance();");
    expect(link.match(/clearReproLimaAdvance\(\);\n\s+window\.history\.pushState\(/g)?.length).toBe(2);
  });

  it("MOM §9.5 lo cuenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    for (const text of [
      "**«Guardar y pasar al siguiente» pasa en el acto (25-11-2026, la usuaria principal: «aún se queda en el mismo pedido»).**",
      "el guardado ya no trae la lista en su respuesta",
      "la ficha sigue enseñando el siguiente y corrige la dirección",
      "La lista se pide una sola vez, de fondo, unos 2,5 segundos después",
    ]) expect(mom).toContain(text);
  });
});

function onSavedBody(): string {
  return between(drawer, "function onReproSaved(saved: ReproSaved, advance: boolean) {", "\n  }\n");
}
