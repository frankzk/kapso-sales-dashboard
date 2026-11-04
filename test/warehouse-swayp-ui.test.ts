// Almacén · «Swayp por salir · Lima», la pantalla (fase 1, solo lectura; owner
// 03-11-2026). Lo que la pantalla tiene que cumplir, leído en el código y en el
// HTML que pinta: dónde vive y cómo se llega, cuándo se lee (después de montar,
// una sola lectura a la vez, R10), que solo lee, las zonas con su cabecera-frase
// y su tono a la hora del equipo, las cifras que filtran, las faltas abiertas y
// con nombre, las armadas plegadas, lo que salió con su motivo, «Revisar», el
// pie de provincia, el vacío, el error y el esqueleto, y DESIGN.md a 390 px.
//
// La estación (la celda de «Por empacar», el aviso del escáner y la chapa de
// «Armados hoy») se prueba en test/warehouse-station.test.ts.

import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  SWAYP_AUTO_REFRESH_MS,
  SWAYP_CHIP_ARMADA_POR_DEFINIR,
  SWAYP_CHIP_SALIDA_NUEVA,
  SWAYP_CHIP_SIN_ARMAR,
  SWAYP_EMPTY,
  SWAYP_ERROR,
  SWAYP_HELP,
  SWAYP_REFRESH_ERROR,
  SWAYP_HOY_NOTE,
  SWAYP_REVISAR_HELP,
  SWAYP_SALIO_ARMADA,
  SWAYP_SALIO_CANCELADA,
  SWAYP_TITLE,
  SWAYP_TONE_COMPLETO,
  applySwaypScan,
  emptyWarehouseSwayp,
  type WarehouseSwaypData,
} from "@/lib/warehouse-swayp";
import { SWAYP_HOY_FALTA_ENTREGA } from "@/lib/swayp-handover";
import {
  SWAYP_NOW,
  limaAt,
  swaypInput,
  swaypLimaGuide,
  swaypLot,
} from "@/test/helpers/warehouse-swayp-fixtures";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
// «Abrir pedido» abre la ficha sobre la pantalla actual (components/order-link.tsx).
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/almacen",
  useSearchParams: () => new URLSearchParams(),
}));

const {
  SWAYP_AUTO_TICK_MS,
  SWAYP_FILTER_EMPTY,
  SWAYP_LINK_STALE,
  SWAYP_LIST_LABEL,
  SWAYP_LOADING,
  SWAYP_OPEN_ORDER,
  SWAYP_PRINT_LABEL,
  SWAYP_SALIERON_HELP,
  SWAYP_STALE,
  SWAYP_WAKE_STALE_MS,
  WarehouseSwayp,
  WarehouseSwaypCell,
  swaypHeaderLinkText,
  swaypLiveZone,
  swaypReadKey,
  swaypZoneView,
  watchSwaypRefresh,
} = await import("@/components/warehouse-swayp");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const ui = read("components/warehouse-swayp.tsx");
const station = read("components/warehouse-station.tsx");
const page = read("app/dashboard/pedidos/almacen/page.tsx");

/** Lo que va entre dos marcas del mismo archivo. */
function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return src.slice(from, to + end.length);
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** El texto de un HTML sin etiquetas ni entidades. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function render(data: WarehouseSwaypData | null, opts: { busy?: boolean; stale?: boolean; now?: Date | null } = {}): string {
  return renderToStaticMarkup(createElement(WarehouseSwayp, {
    data,
    onRefresh: async () => {},
    busy: opts.busy ?? false,
    stale: opts.stale,
    now: opts.now === undefined ? SWAYP_NOW : opts.now,
  }));
}

function renderCell(data: WarehouseSwaypData | null, now: Date | null = SWAYP_NOW, stale = false): string {
  return renderToStaticMarkup(createElement(WarehouseSwaypCell, { data, now, stale }));
}

const LOT = swaypLot();
/** El mismo lote con la falta de hoy (KP40-S01) ya armada: «Hoy» no tiene nada urgente. */
const CALM = applySwaypScan(LOT, "sh-KP40-S01", "2026-11-03T22:41:00Z");

// ---------------------------------------------------------------------------
// El código
// ---------------------------------------------------------------------------

describe("dónde vive y cómo se llega", () => {
  it("el apartado lleva id=\"swayp\" y la cabecera de la estación enlaza a él, solo con datos y sin error", () => {
    expect(ui).toContain('<section id="swayp" aria-labelledby="swayp-titulo"');
    expect(station).toContain('<a href="#swayp" className={LINK_SECONDARY}>');
    expect(station).toContain("Swayp por salir · <span className=\"tabular-nums\">{swaypHeaderLinkText(swaypNext, { hoy: swayp?.hoy, stale: swaypStale })}</span>");
    expect(station).toContain("const swaypNext = useMemo(() => (swayp && !swayp.error ? swaypLiveZone(swayp.proximo, now) : null), [swayp, now]);");
    expect(station).toContain("{swaypNext && (");
  });

  it("va entre la tarjeta de la estación y «Reintentos por salir»", () => {
    const layout = between(station, '<div className="mx-auto max-w-[1500px] space-y-5 pb-24">', "<DispatchCamera");
    const stationCard = layout.lastIndexOf("</section>");
    const swayp = layout.indexOf("<WarehouseSwayp data={swayp} onRefresh={refreshSwayp} busy={swaypBusy} stale={swaypStale} now={now} />");
    const retries = layout.indexOf("<WarehouseRetries data={retries}");
    expect(swayp).toBeGreaterThan(stationCard);
    expect(retries).toBeGreaterThan(swayp);
    // Se pinta igual mientras llega (en esqueleto): no espera a tener datos.
    expect(station).not.toContain("{swayp && <WarehouseSwayp");
  });

  it("la página no lo lee al pintar en servidor ni le pasa initialSwayp", () => {
    expect(page).toContain("<WarehouseStation initialData={data} stores={stores} />");
    expect(page).not.toContain("getWarehouseSwayp");
    expect(page).not.toContain("initialSwayp");
  });
});

describe("cuándo se lee (R10)", () => {
  it("después de montar, por GET sin caché (no por acción de servidor)", () => {
    expect(station).toContain("const [swayp, setSwayp] = useState<WarehouseSwaypData | null>(initialSwayp ?? null);");
    expect(station).toContain("useEffect(() => {\n    if (!swayp) void refreshSwayp();\n  }, [swayp, refreshSwayp]);");
    expect(station).toContain('fetch("/api/almacen/swayp", { cache: "no-store", credentials: "same-origin" })');
  });

  it("una sola lectura en vuelo: la marca se pone antes de esperar y se quita en el finally", () => {
    const refresh = between(station, "const refreshSwayp = useCallback(async (): Promise<WarehouseSwaypData | null> => {", "}, []);");
    const guard = refresh.indexOf("if (swaypInFlight.current) return null;");
    const set = refresh.indexOf("swaypInFlight.current = true;");
    const wait = refresh.indexOf("await fetchWarehouseSwayp()");
    const fin = refresh.indexOf("} finally {");
    const clear = refresh.indexOf("swaypInFlight.current = false;");
    expect(guard).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(guard);
    expect(wait).toBeGreaterThan(set);
    expect(fin).toBeGreaterThan(wait);
    expect(clear).toBeGreaterThan(fin);
    // No toca la cola de armado.
    expect(refresh).not.toContain("setData");
    expect(refresh).not.toContain("pending");
  });

  it("el apartado instala la relectura después de montar y solo con lista; la cuenta es la de la lectura del servidor", () => {
    expect(ui).toContain("const readKey = swaypReadKey(data);");
    expect(ui).toContain("useEffect(() => {\n    readAt.current = Date.now();\n  }, [readKey]);");
    expect(ui).toContain("return watchSwaypRefresh(");
    // Sin lista todavía no se relee: la primera lectura ya va en camino.
    expect(count(ui, "if (!today) return;")).toBe(1);
    expect(SWAYP_WAKE_STALE_MS).toBe(60_000);
    expect(SWAYP_AUTO_REFRESH_MS).toBe(5 * 60_000);
    expect(SWAYP_AUTO_TICK_MS).toBe(60_000);
  });

  it("el escaneo no relee la lista: mueve la salida en la copia local y avisa con lo cargado (salvo antes de decir «fuera»)", () => {
    const scan = between(station, "const executeScan = useCallback(async (raw: string) => {", "}, [busy, retries, swayp, refreshSwayp]);");
    expect(scan).not.toContain("void refreshSwayp()");
    expect(scan).not.toContain("fetchWarehouseSwayp");
    expect(scan).toContain("setSwayp((prev) => (prev ? applySwaypScan(prev, scanned.id, at) : prev));");
    // La única relectura posible va por `swaypHintAfterScan` (una caja fuera de lo cargado, o un lote de otro día).
    expect(scan).toContain("void swaypHintAfterScan(swayp, scanned, { now: new Date(), reread: refreshSwayp }).then((hint) => {");
    expect(scan).toContain("if (scanSeq.current !== seq) return;");
    expect(count(station, "markShipmentReady(")).toBe(1);
  });
});

describe("la relectura sola, con reloj de verdad (watchSwaypRefresh, R10)", () => {
  /** Un navegador mínimo: `focus` en la ventana, `visibilitychange` en el documento y el intervalo de los temporizadores falsos. */
  function browser() {
    const win = new EventTarget() as EventTarget & { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
    win.setInterval = ((handler: () => void, ms: number) => setInterval(handler, ms)) as typeof setInterval;
    win.clearInterval = ((id: ReturnType<typeof setInterval>) => clearInterval(id)) as typeof clearInterval;
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    return { win, doc };
  }

  function watch(opts: { at: Date; readAt?: Date; today?: string; busy?: boolean }) {
    vi.useFakeTimers();
    vi.setSystemTime(opts.at);
    const { win, doc } = browser();
    const onRefresh = vi.fn();
    const readAt = { current: (opts.readAt ?? opts.at).getTime() };
    const stop = watchSwaypRefresh(
      { win: win as never, doc: doc as never, clock: () => new Date() },
      { today: opts.today ?? "2026-11-03", busy: opts.busy ?? false, readAt, onRefresh },
    );
    return { win, doc, onRefresh, readAt, stop };
  }

  afterEach(() => vi.useRealTimers());

  it("antes de las 16:00 no relee sola; de 16:00 a 21:30, cada 5 minutos de edad de lo leído, una vez", () => {
    const early = watch({ at: limaAt("2026-11-03", "15:30") });
    vi.advanceTimersByTime(29 * 60_000);
    expect(early.onRefresh).not.toHaveBeenCalled();
    early.stop();

    const evening = watch({ at: limaAt("2026-11-03", "16:00") });
    vi.advanceTimersByTime(4 * 60_000);
    expect(evening.onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(evening.onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4 * 60_000);
    expect(evening.onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(evening.onRefresh).toHaveBeenCalledTimes(2);
    evening.stop();
    vi.advanceTimersByTime(30 * 60_000);
    expect(evening.onRefresh).toHaveBeenCalledTimes(2);
  });

  it("con la pestaña oculta o una lectura en curso, no relee; pasadas las 21:30, tampoco", () => {
    const hidden = watch({ at: limaAt("2026-11-03", "20:00") });
    hidden.doc.visibilityState = "hidden";
    vi.advanceTimersByTime(20 * 60_000);
    expect(hidden.onRefresh).not.toHaveBeenCalled();
    hidden.stop();
    const busy = watch({ at: limaAt("2026-11-03", "20:00"), busy: true });
    vi.advanceTimersByTime(20 * 60_000);
    expect(busy.onRefresh).not.toHaveBeenCalled();
    busy.stop();
    const late = watch({ at: limaAt("2026-11-03", "21:31"), readAt: limaAt("2026-11-03", "21:00") });
    vi.advanceTimersByTime(60 * 60_000);
    expect(late.onRefresh).not.toHaveBeenCalled();
    late.stop();
  });

  it("los escaneos locales no aplazan la relectura: la cuenta es la de la lectura del servidor", () => {
    // `applySwaypScan` devuelve otro objeto, pero la misma lectura.
    const scanned = applySwaypScan(LOT, "sh-KP7-S02", "2026-11-03T23:00:00Z");
    expect(scanned).not.toBe(LOT);
    expect(swaypReadKey(scanned)).toBe(swaypReadKey(LOT));
    expect(swaypReadKey(swaypLot(limaAt("2026-11-03", "18:00")))).not.toBe(swaypReadKey(LOT));
    // Escaneando cada 3 minutos desde las 20:00, a las 20:05 relee igual.
    const w = watch({ at: limaAt("2026-11-03", "20:00") });
    vi.advanceTimersByTime(3 * 60_000);
    vi.advanceTimersByTime(2 * 60_000);
    expect(w.onRefresh).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it("al volver a la pestaña: con un minuto o más, una sola lectura aunque lleguen `visibilitychange` y `focus`; con menos, nada", () => {
    const w = watch({ at: limaAt("2026-11-03", "11:00") });
    vi.advanceTimersByTime(30_000);
    w.doc.dispatchEvent(new Event("visibilitychange"));
    expect(w.onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    w.doc.dispatchEvent(new Event("visibilitychange"));
    w.win.dispatchEvent(new Event("focus"));
    expect(w.onRefresh).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it("si cambió el día de Lima relee a cualquier hora, aunque la pestaña no se haya ido (la estación pasó la noche abierta)", () => {
    const w = watch({ at: limaAt("2026-11-03", "23:58"), readAt: limaAt("2026-11-03", "21:30") });
    vi.advanceTimersByTime(60_000);
    expect(w.onRefresh).not.toHaveBeenCalled();
    // 00:00 del miércoles, fuera de la franja de 16:00 a 21:30.
    vi.advanceTimersByTime(60_000);
    expect(w.onRefresh).toHaveBeenCalledTimes(1);
    w.stop();
  });
});

describe("lee; solo la entrega a Swayp escribe (fase 3, 04-11-2026)", () => {
  it("el apartado solo abre la entrega (las demás escrituras van en su panel), no lee por su cuenta ni guarda en el navegador", () => {
    expect(ui.startsWith('"use client";')).toBe(true);
    expect(ui.match(/from "@\/app\/[^"]+"/g)).toEqual(['from "@/app/dashboard/pedidos/despacho/actions"']);
    expect(ui).toContain('import { openSwaypHandover } from "@/app/dashboard/pedidos/despacho/actions";');
    expect(ui).not.toContain("fetch(");
    expect(ui).not.toContain("localStorage");
    expect(ui).not.toContain("sessionStorage");
    for (const src of [ui, station]) expect(src).not.toContain("@/lib/warehouse-swayp-access");
  });

  it("nunca hay «marcar armada» a mano: lo único que se pulsa es imprimir, abrir, filtrar, plegar y actualizar (R4)", () => {
    expect(ui).not.toContain("markShipmentReady");
    expect(ui).not.toMatch(/>\s*Marcar/);
    expect(count(ui, 'target="_blank"')).toBe(1);
    expect(ui).toContain("href={row.labelHref}");
    expect(count(ui, "<OrderLink ")).toBe(2);
  });
});

describe("DESIGN.md: táctil, cifras, radios, acentos y 390 px", () => {
  it("botones y enlaces suben a 44 px con puntero táctil; las cifras van tabulares", () => {
    expect(count(ui, "pointer-coarse:h-11")).toBeGreaterThanOrEqual(5);
    expect(ui).toContain("pointer-coarse:min-h-11");
    expect(count(ui, "tabular-nums")).toBeGreaterThanOrEqual(6);
    expect(ui).toContain('toLocaleString("es-PE")');
  });

  it("solo radios de 6 y 8 px o redondos; sin acentos de borde lateral ni sombras grandes", () => {
    const radii = ui.match(/\brounded(?:-[a-z0-9]+)?\b/g) ?? [];
    expect(radii.length).toBeGreaterThan(0);
    for (const radius of radii) expect(["rounded-md", "rounded-lg", "rounded-full"]).toContain(radius);
    expect(ui).not.toMatch(/\bborder-[lr]-/);
    expect(ui).not.toMatch(/\bborder-[lr]\b/);
    expect(ui).not.toMatch(/shadow-(?:md|lg|xl|2xl)/);
    // Una sola tarjeta con sombra: la del apartado. Las filas son hairlines.
    expect(count(ui, "shadow-control")).toBe(1);
    expect(count(ui, '<ul className="divide-y divide-line rounded-lg ring-1 ring-line">')).toBe(3);
  });

  it("sin emoji ni antetítulos", () => {
    expect(ui).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(ui).not.toMatch(/\buppercase\b/);
    expect(ui).not.toMatch(/tracking-(?:wide|wider|widest)/);
  });

  it("a 390 px: una columna, cifras en 2 × 2, filas que parten en líneas y botones que bajan de renglón", () => {
    expect(ui).toContain('"grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] transition-opacity duration-150", hoy && "xl:grid-cols-2"');
    expect(ui).toContain("grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-4");
    expect(count(ui, "min-w-0 break-words px-3")).toBe(4);
    expect(ui).toContain('<div className="mt-2 flex flex-wrap gap-2">');
    expect(ui).toContain("sm:flex-row");
    // Nada de anchos fijos ni de texto que no parta (salvo las chapas cortas).
    expect(ui).not.toMatch(/\bw-\[\d/);
    expect(ui).not.toMatch(/\bmin-w-\[\d/);
    expect(ui).not.toContain("whitespace-nowrap");
    // La FALTA mide más de 44 px (cinco renglones) y sus botones suben a 44 px.
    expect(ui).toContain('<li className="min-w-0 break-words px-3 py-3">');
  });

  it("el foco de las celdas va por dentro: el marco recorta lo que sale de él", () => {
    expect(count(ui, "outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Lo que se pinta
// ---------------------------------------------------------------------------

describe("esqueleto, error y lectura vieja", () => {
  it("antes de la primera lectura: título, ayuda y esqueleto; sin «Actualizar», sin vacíos y sin alerta", () => {
    const html = render(null);
    const t = text(html);
    expect(html).toContain('<section id="swayp" aria-labelledby="swayp-titulo" aria-busy="true"');
    expect(t).toContain(SWAYP_TITLE);
    expect(t).toContain(SWAYP_HELP);
    expect(html).toContain(`<p role="status" class="sr-only">${SWAYP_LOADING}</p>`);
    expect(count(html, "animate-pulse rounded-lg bg-wash")).toBe(6);
    expect(t).not.toContain("Actualizar");
    expect(t).not.toContain("Leído");
    expect(html).not.toContain('role="alert"');
  });

  it("con error: el aviso con «Reintentar»; ni zonas ni hora de lectura", () => {
    const html = render(emptyWarehouseSwayp({ nowIso: SWAYP_NOW.toISOString(), error: SWAYP_ERROR }));
    const t = text(html);
    expect(html).toContain('role="alert"');
    expect(t).toContain(SWAYP_ERROR);
    expect(t).toContain("Reintentar");
    expect(t).not.toContain("Leído");
    expect(t).not.toContain("Mañana ·");
  });

  it("el motivo de la puerta se lee como el mismo aviso", () => {
    const t = text(render(emptyWarehouseSwayp({ nowIso: SWAYP_NOW.toISOString(), error: "No tienes acceso al almacén." })));
    expect(t).toContain(SWAYP_ERROR);
    expect(t).not.toContain("No tienes acceso al almacén.");
  });

  it("si una relectura falla con un lote en pantalla, se sigue viendo con su hora, el aviso y «Reintentar»", () => {
    const html = render(LOT, { stale: true });
    const t = text(html);
    // «No pudimos actualizar», no «No pudimos cargar»: lo que se ve sí cargó.
    expect(t).toContain(SWAYP_REFRESH_ERROR);
    expect(t).not.toContain(SWAYP_ERROR);
    expect(t).toContain(SWAYP_STALE("17:42"));
    expect(t).toContain("Reintentar");
    expect(t).toContain("KP143987-S02");
  });

  it("mientras actualiza, el botón lo dice y la lista se atenúa", () => {
    const html = render(LOT, { busy: true });
    expect(html).toContain('aria-busy="true"');
    expect(text(html)).toContain("Actualizando…");
    expect(html).toContain("opacity-60");
  });
});

describe("las zonas: «Mañana» primero, «Hoy» para cuadrar", () => {
  const html = render(LOT);
  const t = text(html);

  it("cabecera del apartado con «Leído 17:42» y «Actualizar»", () => {
    expect(t).toContain("Leído 17:42");
    expect(t).toContain("Actualizar");
    expect(html).toContain('<h2 id="swayp-titulo" class="text-base font-semibold');
  });

  it("los títulos, la cabecera-frase y el tono de la víspera, en ese orden", () => {
    const manana = t.indexOf("Mañana · miércoles 4 nov");
    const hoy = t.indexOf("Hoy · martes 3 nov");
    expect(manana).toBeGreaterThan(-1);
    expect(hoy).toBeGreaterThan(manana);
    expect(t).toContain("Swayp miércoles 4 nov: 4 programadas · 2 armadas · faltan 2");
    expect(t).toContain("Faltan 3 h 38 min para el corte de las 21:20: déjalo listo.");
    // El ámbar va en su aviso, con la frase como título en su tono.
    expect(html).toMatch(/bg-warn-wash mt-2"><svg[\s\S]*?<\/svg><div class="min-w-0 flex-1"><p class="font-semibold text-warn-fg">Faltan 3 h 38 min/);
    expect(html).toContain("xl:grid-cols-2");
  });

  it("las cifras: un botón por cifra, «Programadas» elegida", () => {
    expect(html).toContain('role="group" aria-label="Cifras de Mañana · miércoles 4 nov"');
    expect(count(html, "aria-pressed=")).toBe(8);
    expect(t).toContain("Programadas 4 Armadas 2 Faltan 2 Agregadas tarde 1");
    expect(t).toContain("Programadas 2 Armadas 1 Faltan 1 Agregadas tarde 0");
    expect(count(html, 'aria-pressed="true"')).toBe(2);
    expect(html).toMatch(/aria-pressed="true"[^>]*ring-brand-600[^>]*><span class="[^"]*text-brand-700">Programadas/);
  });

  it("una FALTA: salida y guía con sus chapas, cliente, pedido, quién creó la guía, dónde está la caja y sus botones", () => {
    expect(t).toContain(`KP143987-S02 · guía 50000165022 ${SWAYP_CHIP_SIN_ARMAR} ${SWAYP_CHIP_SALIDA_NUEVA}`);
    expect(t).toContain("Cliente Ejemplo · San Bartolo");
    expect(t).toContain("#KP143987 · Kenku Peru · ASTAXANTINA – Antioxidante De Alta Potencia (120 Cápsulas)");
    expect(t).toContain("Creó la guía: Asesora B · martes 3 nov 00:11");
    expect(t).toContain("La KP143987-S01 (Aliclik) volvió a la oficina: si la caja está entera, úsala con el rótulo KP143987-S02; si no, ármala desde stock.");
    expect(t).toContain("La caja está armada como KP7-S01 (Grupo GF): ponle el rótulo KP7-S02, escanéalo y avisa a Despacho que la S01 no sale.");
    expect(html).toContain('href="/api/pedidos/rotulos?ids=sh-KP143987-S02" target="_blank" rel="noreferrer"');
    expect(html).toContain('href="/dashboard/pedidos/almacen?ficha=o-KP143987"');
    expect(count(t, SWAYP_PRINT_LABEL)).toBe(3);
    expect(t).toContain(SWAYP_OPEN_ORDER);
  });

  it("las faltas van abiertas y enteras; las armadas, plegadas con su cifra", () => {
    expect(t).toContain(`${SWAYP_LIST_LABEL.faltan} 2`);
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+"[^>]*>.*Armadas.*?>2<\/span><\/button>/);
    const fold = html.match(/<ul id="([^"]+)" hidden=""/g) ?? [];
    expect(fold).toHaveLength(2);
    // Plegadas pero en el HTML: la línea con el código en monoespaciada y su chapa tardía.
    expect(html).toContain('<span class="font-mono font-semibold text-ink-900">KP31-S01</span> · armada martes 3 nov 17:40 · Almacén A · Cliente · Los Olivos');
    expect(t).toContain("Agregada 17:30, después de las 17:00");
  });

  it("lo que salió, con su motivo y qué hacer si estaba armada (R8)", () => {
    expect(t).toContain(`${SWAYP_LIST_LABEL.salieron} 2`);
    expect(t).toContain(SWAYP_SALIERON_HELP);
    expect(t).toContain(`KP10-S01 · guía 50000165050 ${SWAYP_SALIO_CANCELADA}`);
    expect(t).toContain("Fecha cambiada: ahora sale el viernes 6 nov (cambió el martes 3 nov 17:20)");
    expect(count(t, SWAYP_SALIO_ARMADA)).toBe(2);
    expect(html).toMatch(/bg-crit-bg text-crit-fg[^"]*">Swayp la canceló/);
    expect(html).toMatch(/bg-warn-bg text-warn-fg[^"]*">Fecha cambiada/);
  });

  it("«Revisar» con su ayuda y «Abrir pedido»; el pie de provincia, que no cuenta", () => {
    expect(t).toContain("Revisar 1");
    expect(t).toContain(SWAYP_REVISAR_HELP);
    expect(t).toContain("Operación del pedido: Agencia");
    expect(html).toContain('href="/dashboard/pedidos/almacen?ficha=o-KP4"');
    expect(t).toContain("Provincia: 1 guía Swayp sale el miércoles 4 nov desde la bodega de Swayp (Arequipa 1). No se empaca aquí.");
  });

  it("«Hoy»: su cabecera, una sola vez el estado de la entrega a Swayp, el estado de Swayp y qué hacer con la que no se armó", () => {
    expect(t).toContain("Swayp hoy: 2 programadas · 1 armada · falta 1");
    // La cifra «Faltan» de «Hoy» va en rojo: sale hoy y sigue aquí.
    expect(html).toMatch(/aria-label="Cifras de Hoy · martes 3 nov"[\s\S]*?text-crit-fg">1<\/span><\/button>/);
    expect(count(t, SWAYP_HOY_NOTE)).toBe(1);
    expect(t).toContain("Swayp: Generada");
    expect(html).toContain(`<p class="mt-1 text-[13px] font-semibold text-crit-fg">${SWAYP_HOY_FALTA_ENTREGA}</p>`);
    expect(t).toContain(SWAYP_CHIP_ARMADA_POR_DEFINIR);
    // «Hoy» no lleva tono ni cifra de «recogidas».
    expect(t).not.toContain("recogidas");
  });

  it("la tienda solo se nombra fuera de la línea del pedido con más de una tienda a la vista", () => {
    expect(t).not.toContain("Cliente · Surco · #KP10 · Kenku Peru");
    expect(text(render({ ...LOT, showStore: true }))).toContain("Cliente · Surco · #KP10 · Kenku Peru");
  });
});

describe("el tono de «Próximo» va con el reloj del equipo, no con la hora de la lectura", () => {
  it("a las 20:10 faltan 1 h 10 min; a las 21:30, el turno noche cerró; lo leído sigue diciendo 17:42", () => {
    const at2010 = text(render(LOT, { now: limaAt("2026-11-03", "20:10") }));
    expect(at2010).toContain("Faltan 1 h 10 min para el corte de las 21:20: déjalo listo.");
    expect(at2010).toContain("Leído 17:42");
    const html = render(LOT, { now: limaAt("2026-11-03", "21:30") });
    expect(text(html)).toContain("El turno noche cerró con 2 sin armar: avisa a Seguimiento.");
    expect(html).toContain("bg-crit-wash");
    // Con el turno cerrado, la cifra y la chapa de las faltas pasan a rojo.
    expect(html).toMatch(/text-crit-fg">2<\/span><\/button>/);
  });

  it("sin reloj todavía (antes de montar) se queda el del servidor", () => {
    expect(text(render(LOT, { now: null }))).toContain("Faltan 3 h 38 min para el corte de las 21:20: déjalo listo.");
  });

  it("swaypLiveZone: solo cambia «Próximo» y solo si el tono cambió", () => {
    expect(swaypLiveZone(LOT.proximo, SWAYP_NOW)).toBe(LOT.proximo);
    expect(swaypLiveZone(LOT.hoy!, limaAt("2026-11-03", "21:30"))).toBe(LOT.hoy);
    const late = swaypLiveZone(LOT.proximo, limaAt("2026-11-03", "21:30"));
    expect(late.tone).toEqual({ kind: "crit", text: "El turno noche cerró con 2 sin armar: avisa a Seguimiento." });
    expect(late.cell.tone).toEqual(late.tone);
    expect(late.cell.big).toBe("Faltan 2");
  });
});

describe("sábado, domingo y vacío", () => {
  const monday = swaypLimaGuide("KP60-S01", { day: "2026-11-09", guide: "50000166000", createdAt: "2026-11-07T15:00:00Z", emittedAt: "2026-11-07T15:00:00Z" });

  it("el sábado: «Próximo despacho · lunes 9 nov», lo arma el turno noche del domingo, y «Hoy · sábado 7 nov»", () => {
    const now = limaAt("2026-11-07", "10:00");
    const t = text(render(swaypLot(now, swaypInput([monday])), { now }));
    expect(t).toContain("Próximo despacho · lunes 9 nov");
    expect(t).toContain("Lo arma el turno noche del domingo 8 nov, antes del corte de las 21:20.");
    expect(t).toContain("Hoy · sábado 7 nov");
    expect(t).toContain(SWAYP_EMPTY("sábado 7 nov"));
  });

  it("el domingo no hay «Hoy» y «Próximo» va a todo el ancho", () => {
    const now = limaAt("2026-11-08", "18:00");
    const html = render(swaypLot(now, swaypInput([monday])), { now });
    const t = text(html);
    expect(t).toContain("Mañana · lunes 9 nov");
    expect(t).not.toContain("Hoy ·");
    expect(html).not.toContain("xl:grid-cols-2\"");
    expect(html).not.toMatch(/class="grid grid-cols-1 shadow-\[inset_0_1px_0_var\(--color-line\)\] transition-opacity duration-150 xl:grid-cols-2/);
  });

  it("vacío: la frase una sola vez por zona, sin cifras ni tono", () => {
    const html = render(swaypLot(SWAYP_NOW, swaypInput([])));
    const t = text(html);
    expect(count(t, SWAYP_EMPTY("miércoles 4 nov"))).toBe(1);
    expect(count(t, SWAYP_EMPTY("martes 3 nov"))).toBe(1);
    expect(html).not.toContain('role="group"');
    expect(html).toContain("border-dashed");
  });
});

// ---------------------------------------------------------------------------
// Reglas puras de la pantalla
// ---------------------------------------------------------------------------

describe("swaypZoneView (las cifras filtran)", () => {
  const zone = LOT.proximo;

  it("«Programadas»: las faltas abiertas, las armadas plegadas y lo demás", () => {
    const view = swaypZoneView(zone, "programadas");
    expect(view.faltan?.map((r) => r.code)).toEqual(["KP143987-S02", "KP7-S02"]);
    expect(view.armadas?.map((r) => r.code)).toEqual(["KP30-S01", "KP31-S01"]);
    expect(view).toMatchObject({ armadasFolded: true, extras: true, empty: null });
  });

  it("«Faltan» y «Armadas» dejan solo su lista, abierta", () => {
    expect(swaypZoneView(zone, "faltan")).toMatchObject({ armadas: null, extras: false, empty: null });
    const armadas = swaypZoneView(zone, "armadas");
    expect(armadas.faltan).toBeNull();
    expect(armadas).toMatchObject({ armadasFolded: false, extras: false });
  });

  it("«Agregadas tarde»: las tardías de las dos listas", () => {
    const view = swaypZoneView(zone, "agregadasTarde");
    expect(view.faltan).toEqual([]);
    expect(view.armadas?.map((r) => r.code)).toEqual(["KP31-S01"]);
    expect(view.armadasFolded).toBe(false);
  });

  it("un filtro que no deja nada lo dice", () => {
    const done = applySwaypScan(applySwaypScan(LOT, "sh-KP143987-S02", "2026-11-03T23:00:00Z"), "sh-KP7-S02", "2026-11-03T23:01:00Z");
    expect(swaypZoneView(done.proximo, "faltan").empty).toBe(SWAYP_FILTER_EMPTY.faltan);
    expect(swaypZoneView(LOT.hoy!, "agregadasTarde").empty).toBe(SWAYP_FILTER_EMPTY.agregadasTarde);
    expect(swaypZoneView({ faltan: [], armadas: [] }, "armadas").empty).toBe(SWAYP_FILTER_EMPTY.armadas);
  });
});

describe("swaypHeaderLinkText", () => {
  it("delante lo urgente de hoy; detrás, si no se pudo actualizar", () => {
    expect(swaypHeaderLinkText(LOT.proximo, { hoy: LOT.hoy })).toBe("hoy: 1 sin armar · faltan 2");
    expect(swaypHeaderLinkText(CALM.proximo, { hoy: CALM.hoy })).toBe("faltan 2");
    expect(swaypHeaderLinkText(CALM.proximo, { hoy: CALM.hoy, stale: true })).toBe(`faltan 2 · ${SWAYP_LINK_STALE}`);
  });

  it("«falta 1», «faltan 2», «completo» o «sin guías»", () => {
    expect(swaypHeaderLinkText(LOT.proximo)).toBe("faltan 2");
    expect(swaypHeaderLinkText(LOT.hoy!)).toBe("falta 1");
    const done = applySwaypScan(applySwaypScan(LOT, "sh-KP143987-S02", "2026-11-03T23:00:00Z"), "sh-KP7-S02", "2026-11-03T23:01:00Z");
    expect(swaypHeaderLinkText(done.proximo)).toBe("completo");
    expect(swaypHeaderLinkText(swaypLot(SWAYP_NOW, swaypInput([])).proximo)).toBe("sin guías");
  });
});

// ---------------------------------------------------------------------------
// La celda «Swayp · Lima»
// ---------------------------------------------------------------------------

describe("la celda «Swayp · Lima» (marco «Por empacar»)", () => {
  it("toda la celda lleva al apartado; con faltas, ámbar con la cuenta atrás", () => {
    const html = renderCell(CALM);
    const t = text(html);
    expect(html.startsWith('<a href="#swayp"')).toBe(true);
    expect(html).toContain("bg-warn-wash");
    expect(t).toContain("Swayp · Lima");
    expect(t).toContain("Faltan 2");
    expect(t).toContain("miércoles 4 nov · 4 programadas · 2 armadas");
    expect(t).toContain("Faltan 3 h 38 min para el corte de las 21:20: déjalo listo.");
    // Sobre un lavado nada va en gris tenue.
    expect(html).not.toMatch(/text-ink-(?:500|600)/);
  });

  it("«Falta 1», «Completo» en verde y «0» en blanco", () => {
    const one = applySwaypScan(CALM, "sh-KP7-S02", "2026-11-03T23:00:00Z");
    expect(text(renderCell(one))).toContain("Falta 1");
    const done = applySwaypScan(one, "sh-KP143987-S02", "2026-11-03T23:01:00Z");
    const html = renderCell(done);
    expect(text(html)).toContain("Completo");
    expect(text(html)).toContain(SWAYP_TONE_COMPLETO);
    expect(html).toContain("bg-ok-wash");
    const zero = renderCell(swaypLot(SWAYP_NOW, swaypInput([])));
    expect(text(zero)).toMatch(/Swayp · Lima ↓ 0 miércoles 4 nov · 0 programadas · 0 armadas/);
    expect(zero).toContain("bg-white");
  });

  it("después de las 21:20 de la víspera con faltas, en rojo", () => {
    const html = renderCell(CALM, limaAt("2026-11-03", "21:25"));
    expect(html).toContain("bg-crit-wash");
    expect(text(html)).toContain("El turno noche cerró con 2 sin armar: avisa a Seguimiento.");
  });

  it("lo urgente de hoy sube a la celda en rojo, aunque «Próximo» vaya en ámbar; el tono de «Próximo» sigue, en tinta", () => {
    const html = renderCell(LOT);
    const t = text(html);
    expect(html).toContain("bg-crit-wash");
    expect(t).toContain("Faltan 2");
    expect(t).toContain("Faltan 3 h 38 min para el corte de las 21:20: déjalo listo.");
    expect(html).toContain('<p class="mt-1 text-xs font-semibold tabular-nums text-crit-fg">Hoy: 1 sin armar</p>');
    expect(html).toMatch(/text-ink-900">Faltan 3 h 38 min/);
    expect(html).not.toMatch(/text-ink-(?:500|600)/);
  });

  it("si la última relectura falló, la celda dice desde qué hora no se actualiza", () => {
    expect(text(renderCell(CALM, SWAYP_NOW, true))).toContain(SWAYP_STALE("17:42"));
    expect(text(renderCell(CALM))).not.toContain("Se ve lo leído");
  });

  it("cargando, esqueleto; con error, «No se pudo leer»", () => {
    const loading = renderCell(null);
    expect(count(loading, "animate-pulse")).toBe(2);
    expect(text(loading)).toContain("Swayp · Lima");
    const error = renderCell(emptyWarehouseSwayp({ nowIso: SWAYP_NOW.toISOString(), error: SWAYP_ERROR }));
    expect(text(error)).toContain("No se pudo leer");
    expect(error.startsWith('<a href="#swayp"')).toBe(true);
  });
});
