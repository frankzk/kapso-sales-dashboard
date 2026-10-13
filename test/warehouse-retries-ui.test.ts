// Almacén · «Reintentos por salir», la pantalla (fase 1, entrega 1c; MOM §9.5).
// Lo que la pantalla tiene que cumplir, leído en el código y en el HTML que
// pinta: el apartado y el enlace de la cabecera, el escáner que no cambia, la
// cola de «Por armar» que sigue saliendo de `data.pending`, el aviso de error
// que no tumba la estación, los apartados de cada zona y la pista del escáner.

import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BOX_ACTION_LABEL,
  HANDOFF_GROUP,
  HANDOFF_LINE_DESARMAR,
  HANDOFF_LINE_GF,
  HANDOFF_NOTE,
  POR_ARMAR_CHIP,
  REPRO_NO_LO_QUIERE_CHIP,
  RETRY_DEFAULT_CHIP,
  RETRY_EMPTY_HOY,
  RETRY_EMPTY_MANANA,
  RETRY_ERROR,
  RETRY_FACTS_CHANGED,
  RETRY_HELP,
  RETRY_HOY_HELP,
  RETRY_MANANA_HELP,
  RETRY_NIGHT_BEFORE_MANANA,
  RETRY_NO_ANAQUEL_DESARMAR,
  RETRY_OVERDUE,
  emptyWarehouseRetries,
  retryCounts,
  type WarehouseHandoffRow,
  type WarehouseRetriesData,
  type WarehouseRetryRow,
} from "@/lib/warehouse-retries";
import type { WarehouseShipment, WarehouseStationData } from "@/lib/dispatch-access";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
// Las acciones de servidor y la cámara no se ejecutan al pintar en el servidor.
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({ markShipmentReady: vi.fn() }));
vi.mock("@/app/dashboard/pedidos/almacen/actions", () => ({ loadWarehouseStation: vi.fn(), loadWarehouseRetries: vi.fn() }));
vi.mock("@/components/dispatch-camera", () => ({ DispatchCamera: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/almacen",
  useSearchParams: () => new URLSearchParams(),
}));

const { WarehouseStation } = await import("@/components/warehouse-station");
const {
  RETRY_GROUP_LABEL,
  RETRY_PREPARE_TONIGHT,
  WarehouseRetries,
  retryActionText,
  retryScanHint,
  retryZoneGroups,
} = await import("@/components/warehouse-retries");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const retriesUi = read("components/warehouse-retries.tsx");
const station = read("components/warehouse-station.tsx");
const page = read("app/dashboard/pedidos/almacen/page.tsx");
const actions = read("app/dashboard/pedidos/almacen/actions.ts");
const pure = read("lib/warehouse-retries.ts");
const access = read("lib/warehouse-retries-access.ts");

/** Lo que va entre dos marcas del mismo archivo. */
function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return src.slice(from, to + end.length);
}

/** Cuántas veces aparece `needle` en `src`. */
function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** El texto de un HTML sin etiquetas ni entidades de comillas. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Datos de prueba: filas como las arma el servidor (lib/warehouse-retries.ts)
// ---------------------------------------------------------------------------

const TODAY = "2026-10-13";
const NOW_ISO = "2026-10-13T14:00:00.000Z";

function retryRow(over: Partial<WarehouseRetryRow> & Pick<WarehouseRetryRow, "orderId">): WarehouseRetryRow {
  return {
    storeId: "store-1",
    storeName: "Kenku",
    orderName: `#${over.orderId}`,
    customerName: "Rosa Quispe",
    district: "San Borja",
    bucket: "hoy",
    day: TODAY,
    dayLabel: "mar 13/10",
    overdue: false,
    dayFrom: "programa",
    courierName: "Grupo GF",
    action: "mantener",
    actionSource: "por_defecto",
    actionLine: "Mantener la caja: misma salida, QR y rótulo.",
    changesText: null,
    decidedLine: null,
    programReason: null,
    nightBefore: false,
    boxLabel: "En oficina desde lun 12/10",
    whereLine: "Debería estar en el anaquel del mar 13/10",
    inOffice: true,
    group: "anaquel",
    chips: [{ tone: "neutral", text: RETRY_DEFAULT_CHIP }],
    label: null,
    ...over,
  };
}

function handoffRow(over: Partial<WarehouseHandoffRow> & Pick<WarehouseHandoffRow, "orderId">): WarehouseHandoffRow {
  return {
    orderName: `#${over.orderId}`,
    storeName: "Kenku",
    customerName: "Luis Paz",
    district: "Surco",
    bucket: "hoy",
    day: TODAY,
    dayLabel: "mar 13/10",
    overdue: false,
    action: "salida_nueva_rearmar",
    courierName: "Grupo GF",
    line: HANDOFF_LINE_GF,
    salida: { code: "KP1-S03", armed: false, readyAt: null },
    ...over,
  };
}

function retriesData(rows: WarehouseRetryRow[], handoffs: WarehouseHandoffRow[] = [], over: Partial<WarehouseRetriesData> = {}): WarehouseRetriesData {
  return {
    ...emptyWarehouseRetries({ today: TODAY, nowIso: NOW_ISO, cutoffLabel: "12:00" }),
    rows,
    handoffs,
    counts: retryCounts(rows),
    ...over,
  };
}

const OVERDUE = retryRow({
  orderId: "KP-901",
  day: "2026-10-12",
  dayLabel: "lun 12/10",
  overdue: true,
  chips: [{ tone: "crit", text: RETRY_OVERDUE("lun 12/10") }, { tone: "neutral", text: RETRY_DEFAULT_CHIP }],
});
const NO_LO_QUIERE = retryRow({
  orderId: "KP-902",
  action: "desarmar_cerrar",
  actionSource: "cerrado",
  actionLine: "Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta.",
  group: "con_aviso",
  whereLine: "En el estante · bandeja del lun 12/10",
  chips: [{ tone: "crit", text: REPRO_NO_LO_QUIERE_CHIP }, { tone: "crit", text: RETRY_NO_ANAQUEL_DESARMAR }],
});
const WITH_RIDER = retryRow({
  orderId: "KP-903",
  boxLabel: "Con Roy desde lun 12/10",
  whereLine: null,
  inOffice: false,
  group: "fuera",
});
const DRIFT = retryRow({
  orderId: "KP-904",
  action: "salida_nueva_rearmar",
  actionSource: "acuerdo",
  actionLine: BOX_ACTION_LABEL.salida_nueva_rearmar,
  changesText: "dirección",
  decidedLine: "Decidió Diana 12/10 15:20",
  group: "con_aviso",
  chips: [{ tone: "crit", text: RETRY_FACTS_CHANGED }],
});
const REPRINT_1 = retryRow({
  orderId: "KP-905",
  bucket: "manana",
  day: "2026-10-14",
  dayLabel: "mié 14/10",
  action: "reimprimir_misma_salida",
  actionSource: "acuerdo",
  actionLine: "Reimprimir el rótulo de la misma salida: se retira el rótulo viejo.",
  nightBefore: true,
  chips: [{ tone: "warn", text: RETRY_NIGHT_BEFORE_MANANA }],
  label: { shipmentId: "ship-905", code: "KP1-S02" },
});
const REPRINT_2 = { ...REPRINT_1, orderId: "KP-906", orderName: "#KP-906", label: { shipmentId: "ship-906", code: "KP1-S04" } };
const REPRINT_WARNED = { ...REPRINT_1, orderId: "KP-907", orderName: "#KP-907", group: "con_aviso" as const, label: null };
const TOMORROW_PLAIN = retryRow({ orderId: "KP-908", bucket: "manana", day: "2026-10-14", dayLabel: "mié 14/10" });

const HANDOFF = handoffRow({ orderId: "KP-950" });

function stationData(pending: Partial<WarehouseShipment>[] = []): WarehouseStationData {
  return {
    pending: pending.map((p, i) => ({
      id: `s${i}`,
      store_id: "store-1",
      courier: "propio",
      guide_code: `G-${i}`,
      output_number: 3,
      output_code: `KP1-S0${i}`,
      qr_token: null,
      preparation_state: "rotulo_generado",
      custody_state: "empresa",
      ready_at: null,
      order_id: null,
      order_name: `#P${i}`,
      customer_name: "Cliente",
      customer_phone: null,
      district: "Surco",
      province: null,
      product: null,
      operation: "lima",
      delivery_status: null,
      created_at: "2026-10-13T13:00:00.000Z",
      ...p,
    })),
    blocked: [],
    armedToday: [],
    pendingOmitted: 0,
  };
}

const stores = [{ id: "store-1", name: "Kenku" }] as unknown as Parameters<typeof WarehouseStation>[0]["stores"];

function renderStation(initialRetries?: WarehouseRetriesData, data: WarehouseStationData = stationData()): string {
  return renderToStaticMarkup(createElement(WarehouseStation, { initialData: data, initialRetries, stores }));
}

function renderRetries(data: WarehouseRetriesData, busy = false): string {
  return renderToStaticMarkup(createElement(WarehouseRetries, { data, onRefresh: async () => {}, busy }));
}

// ---------------------------------------------------------------------------
// El código
// ---------------------------------------------------------------------------

describe("dónde vive y cómo se llega (§1)", () => {
  it("el apartado lleva id=\"reintentos\" y la cabecera de la estación enlaza a él con su cifra", () => {
    expect(retriesUi).toContain('<section id="reintentos"');
    expect(station).toContain('<a href="#reintentos" className={LINK_SECONDARY}>');
    expect(station).toContain("Reintentos por salir · <span className=\"tabular-nums\">{retries.counts.hoy.toLocaleString(\"es-PE\")}</span> hoy");
    // Solo con datos y sin error: una cifra que no se pudo leer no se enseña.
    expect(station).toContain("{retries && !retries.error && (");
  });

  it("va debajo de la tarjeta de la estación, dentro del mismo contenedor", () => {
    const layout = between(station, '<div className="mx-auto max-w-[1500px] space-y-5 pb-24">', "<DispatchCamera");
    const stationCard = layout.lastIndexOf("</section>");
    const retries = layout.indexOf("<WarehouseRetries data={retries} onRefresh={refreshRetries} busy={retriesBusy} />");
    expect(retries).toBeGreaterThan(stationCard);
  });

  it("la página lee la estación y los reintentos a la vez, después de su puerta", () => {
    const gate = page.indexOf('permissions.can("warehouse.prepare")');
    const load = page.indexOf("await Promise.all([getWarehouseStationData(), getWarehouseRetries()])");
    expect(gate).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(gate);
    expect(page).toContain("<WarehouseStation initialData={data} initialRetries={retries} stores={stores} />");
    expect(page).toContain('import { getWarehouseRetries } from "@/lib/warehouse-retries-access";');
  });
});

describe("el escáner y la cola de armado no cambian (§4, §6)", () => {
  const scan = between(station, "const executeScan = useCallback(async (raw: string) => {", "}, [busy, retries]);");

  it("markShipmentReady se llama una sola vez por escaneo", () => {
    expect(count(scan, "markShipmentReady(")).toBe(1);
    expect(count(station, "markShipmentReady(")).toBe(1);
  });

  it("el escaneo no relee los reintentos: solo busca en lo que ya está en pantalla", () => {
    expect(scan).not.toContain("loadWarehouseRetries");
    expect(scan).not.toContain("refreshRetries");
    expect(scan).toContain("setRetryHint(retryScanHint(retries, result.shipment?.order_id));");
    // La estación sí se relee tras el escaneo, como siempre.
    expect(scan).toContain("setData(await loadWarehouseStation());");
  });

  it("los recuadros y la cola siguen saliendo de data.pending; la chapa de «Por armar» solo se muestra", () => {
    expect(station).toContain("const panels = useMemo(() => warehousePanels(buildWarehouseQueue(data.pending)), [data.pending]);");
    expect(station).toContain("const pending = needle ? data.pending.filter((s) => matches(s, needle)) : data.pending;");
    expect(station).not.toContain("warehousePending");
    // Los reintentos no tocan la cola: ni `setData` ni `pending` salen de ellos.
    const refresh = between(station, "const refreshRetries = useCallback(async () => {", "}, []);");
    expect(refresh).not.toContain("setData");
    expect(refresh).not.toContain("pending");
  });

  it("los reintentos solo se releen al volver a la pestaña (5 minutos o día nuevo) o con «Actualizar»", () => {
    expect(retriesUi).toContain("const RETRY_STALE_MS = 5 * 60_000;");
    expect(retriesUi).toContain('document.addEventListener("visibilitychange", onWake);');
    expect(retriesUi).toContain('window.addEventListener("focus", onWake);');
    expect(retriesUi).toContain("limaClock(new Date()).day !== data.today");
    expect(count(retriesUi, "onRefresh()")).toBe(3);
  });
});

describe("solo lee (§5)", () => {
  it("el apartado no llama acciones de servidor ni guarda nada en el navegador", () => {
    expect(retriesUi.startsWith('"use client";')).toBe(true);
    expect(retriesUi).not.toMatch(/from "@\/app\//);
    expect(retriesUi).not.toContain("localStorage");
    expect(retriesUi).not.toContain("sessionStorage");
    expect(retriesUi).not.toContain("fetch(");
    // El rótulo es el GET de siempre, en otra pestaña.
    expect(retriesUi).toContain("href={retryLabelsHref([row.label.shipmentId])}");
    expect(count(retriesUi, 'target="_blank"')).toBe(2);
  });

  it("los componentes de cliente no importan el acceso de servidor", () => {
    for (const src of [retriesUi, station]) {
      expect(src).not.toContain("@/lib/warehouse-retries-access");
      expect(src).not.toContain("@/lib/repro-lima-access");
    }
  });
});

describe("DESIGN.md: táctil, cifras, radios y 360 px", () => {
  it("botones y enlaces suben a 44 px con puntero táctil; las cifras van tabulares", () => {
    expect(count(retriesUi, "pointer-coarse:h-11")).toBeGreaterThanOrEqual(4);
    expect(retriesUi).toContain("tabular-nums");
    expect(retriesUi).toContain('toLocaleString("es-PE")');
  });

  it("solo radios de 6 y 8 px o redondos", () => {
    for (const src of [retriesUi, station]) {
      const radii = src.match(/\brounded(?:-[a-z0-9]+)?\b/g) ?? [];
      expect(radii.length).toBeGreaterThan(0);
      for (const radius of radii) expect(["rounded-md", "rounded-lg", "rounded-full"]).toContain(radius);
    }
  });

  it("las filas parten en líneas (min-w-0) y las listas son hairlines, sin tarjeta dentro de tarjeta", () => {
    expect(count(retriesUi, '<li className="min-w-0 px-3 py-2.5">')).toBe(2);
    expect(count(retriesUi, '<ul className="divide-y divide-line rounded-lg ring-1 ring-line">')).toBe(1);
    expect(count(retriesUi, '<ul className="mt-2 divide-y divide-line rounded-lg ring-1 ring-line">')).toBe(1);
    // Una sola tarjeta con sombra: la del apartado.
    expect(count(retriesUi, "shadow-control")).toBe(1);
  });

  it("ningún «12:30» fijo en los archivos de 1c: el corte sale del proveedor", () => {
    for (const src of [retriesUi, station, page, actions, pure, access]) expect(src).not.toContain("12:30");
    expect(retriesUi).toContain("RETRY_HOY_HELP(data.cutoffLabel)");
  });
});

// ---------------------------------------------------------------------------
// Lo que se pinta
// ---------------------------------------------------------------------------

describe("el aviso de error no tumba la estación", () => {
  it("con error, la estación pinta entera y el apartado dice que no cargó con «Reintentar»", () => {
    const html = renderStation(emptyWarehouseRetries({ today: TODAY, nowIso: NOW_ISO, error: RETRY_ERROR }));
    expect(html).toContain("Dejar paquete listo");
    expect(html).toContain("Por empacar");
    expect(html).toContain("Armados hoy");
    expect(html).toContain('id="reintentos"');
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(RETRY_ERROR);
    expect(html).toContain("Reintentar");
    // Sin cifra que enseñar, la cabecera no enlaza.
    expect(html).not.toContain('href="#reintentos"');
    expect(text(html)).not.toContain(RETRY_EMPTY_HOY);
  });

  it("el motivo de la puerta también se lee como el mismo aviso", () => {
    const html = renderRetries(emptyWarehouseRetries({ today: TODAY, nowIso: NOW_ISO, error: "No tienes acceso al almacén." }));
    expect(text(html)).toContain(RETRY_ERROR);
  });

  it("sin reintentos (prop ausente), la estación se ve como siempre", () => {
    const html = renderStation(undefined);
    expect(html).toContain("Dejar paquete listo");
    expect(html).not.toContain('id="reintentos"');
    expect(html).not.toContain("Reintentos por salir");
  });
});

describe("la tarjeta «Reintentos por salir»", () => {
  it("título, ayuda, «Actualizar» y las dos zonas con sus ayudas y vacíos", () => {
    const html = renderRetries(retriesData([]));
    const t = text(html);
    expect(t).toContain("Reintentos por salir");
    expect(t).toContain(RETRY_HELP);
    expect(t).toContain("Actualizar");
    expect(t).toContain(RETRY_HOY_HELP("12:00"));
    expect(t).toContain(RETRY_MANANA_HELP);
    expect(t).toContain(RETRY_EMPTY_HOY);
    expect(t).toContain(RETRY_EMPTY_MANANA);
    expect(html).toContain("border-dashed");
    // Una sola cabecera de 28 px por página: aquí es de 16 px.
    expect(html).toContain('<h2 id="reintentos-titulo" class="text-base font-semibold');
  });

  it("la cabecera de la estación enlaza con la cifra de hoy", () => {
    const html = renderStation(retriesData([OVERDUE, NO_LO_QUIERE, TOMORROW_PLAIN]));
    expect(html).toContain('href="#reintentos"');
    expect(text(html)).toContain("Reintentos por salir · 2 hoy ↓");
  });

  it("cada zona dice su cifra y su línea; los de «Por armar» no cuentan", () => {
    const data = retriesData([OVERDUE, NO_LO_QUIERE, WITH_RIDER, REPRINT_1, TOMORROW_PLAIN], [HANDOFF]);
    const t = text(renderRetries(data));
    expect(data.counts).toEqual({ hoy: 3, manana: 2, hoyEnOficina: 2, hoyFuera: 1, mananaNoche: 1 });
    expect(t).toContain("2 en oficina · 1 fuera");
    expect(t).toContain("1 se prepara esta noche");
    expect(t).toContain(HANDOFF_GROUP);
    expect(t).toContain(HANDOFF_NOTE);
  });

  it("los apartados de «Hoy» van en orden y el vencido se dice una sola vez", () => {
    const t = text(renderRetries(retriesData([NO_LO_QUIERE, DRIFT, OVERDUE, WITH_RIDER])));
    const aviso = t.indexOf("Con aviso");
    const anaquel = t.indexOf("Al anaquel");
    const fuera = t.indexOf("Todavía fuera");
    expect(aviso).toBeGreaterThan(-1);
    expect(anaquel).toBeGreaterThan(aviso);
    expect(fuera).toBeGreaterThan(anaquel);
    expect(count(t, RETRY_OVERDUE("lun 12/10"))).toBe(1);
    expect(t).toContain(REPRO_NO_LO_QUIERE_CHIP);
    expect(t).toContain(RETRY_NO_ANAQUEL_DESARMAR);
  });

  it("la fila: pedido que abre la ficha, acción en su chapa, por qué, dónde está y sus chapas", () => {
    const html = renderRetries(retriesData([DRIFT, OVERDUE]));
    const t = text(html);
    expect(html).toContain('href="/dashboard/pedidos/almacen?ficha=KP-904"');
    expect(t).toContain("Rosa Quispe · San Borja");
    // La chapa ya dice la acción guardada: la línea no la repite.
    expect(count(t, BOX_ACTION_LABEL.salida_nueva_rearmar)).toBe(1);
    expect(html).toContain("bg-warn-bg text-warn-fg");
    expect(t).toContain("Cambió: dirección · Decidió Diana 12/10 15:20");
    expect(t).toContain(RETRY_FACTS_CHANGED);
    expect(t).toContain("En oficina desde lun 12/10 · Debería estar en el anaquel del mar 13/10");
    expect(t).toContain(RETRY_DEFAULT_CHIP);
    expect(t).toContain("Mantener la caja: misma salida, QR y rótulo.");
  });

  it("«Desarmar y cerrar» va en rojo y el motivo del programa se lee entre comillas", () => {
    const html = renderRetries(retriesData([{ ...NO_LO_QUIERE, programReason: "Programado por Grupo GF" }]));
    expect(html).toMatch(/bg-crit-bg text-crit-fg[^"]*">Desarmar y cerrar</);
    expect(text(html)).toContain("Motivo: «Programado por Grupo GF»");
  });

  it("la tienda solo se nombra con más de una tienda a la vista", () => {
    expect(text(renderRetries(retriesData([OVERDUE])))).not.toContain("San Borja · Kenku");
    expect(text(renderRetries(retriesData([OVERDUE], [], { showStore: true })))).toContain("Rosa Quispe · San Borja · Kenku");
  });

  it("«Imprimir rótulo» abre el de la misma salida en otra pestaña", () => {
    const html = renderRetries(retriesData([REPRINT_1]));
    expect(html).toContain('href="/api/pedidos/rotulos?ids=ship-905"');
    expect(html).toContain('target="_blank"');
    expect(text(html)).toContain("Imprimir rótuloKP1-S02");
    // Con un solo rótulo no hay tanda.
    expect(text(html)).not.toContain("Imprimir los");
    expect(text(renderRetries(retriesData([OVERDUE])))).not.toContain("Imprimir rótulo");
  });

  it("en «Mañana», «Prepárala hoy» va primero, con la tanda de rótulos desde dos", () => {
    const html = renderRetries(retriesData([TOMORROW_PLAIN, REPRINT_WARNED, REPRINT_1, REPRINT_2]));
    const t = text(html);
    const tonight = t.indexOf(RETRY_PREPARE_TONIGHT);
    expect(tonight).toBeGreaterThan(-1);
    expect(t.indexOf("Con aviso")).toBeGreaterThan(tonight);
    expect(t.indexOf("Al anaquel")).toBeGreaterThan(t.indexOf("Con aviso"));
    expect(t).toContain("Imprimir los 2 rótulos");
    expect(html).toContain('href="/api/pedidos/rotulos?ids=ship-905,ship-906"');
  });

  it("«Ya en «Por armar»»: sin cifra, con lo que se hace con la caja del estante y su salida nueva", () => {
    const armed = handoffRow({ orderId: "KP-951", action: "desarmar_rearmar", line: HANDOFF_LINE_DESARMAR, salida: { code: "KP1-S05", armed: true, readyAt: "2026-10-13T15:12:00.000Z" } });
    const html = renderRetries(retriesData([], [HANDOFF, armed]));
    const t = text(html);
    expect(t).toContain(RETRY_EMPTY_HOY);
    expect(t).toContain(HANDOFF_GROUP);
    expect(t).toContain(HANDOFF_LINE_GF);
    expect(t).toContain(HANDOFF_LINE_DESARMAR);
    expect(t).toContain("Falta armarla · KP1-S03");
    expect(t).toContain("Armada 10:12 · KP1-S05");
    // El título del apartado no lleva chapa de cifra.
    expect(html).toMatch(/<h4 class="text-sm font-semibold text-ink-600">Ya en «Por armar»<\/h4><p/);
  });

  it("mientras actualiza, el botón lo dice y la lista se atenúa", () => {
    const html = renderRetries(retriesData([OVERDUE]), true);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Actualizando…");
    expect(html).toContain("opacity-60");
  });

  it("lo que el tope dejó fuera se dice", () => {
    expect(text(renderRetries(retriesData([OVERDUE], [], { omitted: 12 })))).toContain("Hay 12 pedidos más con fecha hasta mañana fuera de este corte.");
  });
});

describe("la chapa de «Por armar»", () => {
  it("la salida nueva de un reintento lleva «Reintento · …» y qué hacer con la caja vieja", () => {
    const html = renderStation(retriesData([], [HANDOFF]), stationData([{ order_id: "KP-950" }, { order_id: "otro" }]));
    const t = text(html);
    expect(count(t, POR_ARMAR_CHIP(BOX_ACTION_LABEL.salida_nueva_rearmar))).toBe(1);
    // Una vez en la cola y otra en el apartado de abajo.
    expect(count(t, HANDOFF_LINE_GF)).toBe(2);
  });

  it("con error, ninguna fila de la cola lleva la chapa", () => {
    const html = renderStation({ ...retriesData([], [HANDOFF]), error: RETRY_ERROR }, stationData([{ order_id: "KP-950" }]));
    expect(text(html)).not.toContain(POR_ARMAR_CHIP(BOX_ACTION_LABEL.salida_nueva_rearmar));
  });
});

// ---------------------------------------------------------------------------
// Reglas puras de la pantalla
// ---------------------------------------------------------------------------

describe("retryZoneGroups", () => {
  it("«Hoy»: «Con aviso», «Al anaquel» y «Todavía fuera», en el orden del servidor y sin vacíos", () => {
    const groups = retryZoneGroups([NO_LO_QUIERE, DRIFT, OVERDUE, WITH_RIDER, REPRINT_1], "hoy");
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.orderId)])).toEqual([
      [RETRY_GROUP_LABEL.con_aviso, ["KP-902", "KP-904"]],
      [RETRY_GROUP_LABEL.anaquel, ["KP-901"]],
      [RETRY_GROUP_LABEL.fuera, ["KP-903"]],
    ]);
    expect(retryZoneGroups([OVERDUE], "hoy").map((g) => g.key)).toEqual(["anaquel"]);
    expect(retryZoneGroups([], "manana")).toEqual([]);
  });

  it("«Mañana»: lo de la noche anterior sin aviso va primero; con aviso se queda en «Con aviso»", () => {
    const groups = retryZoneGroups([TOMORROW_PLAIN, REPRINT_WARNED, REPRINT_1, REPRINT_2, OVERDUE], "manana");
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.orderId)])).toEqual([
      ["preparala", ["KP-905", "KP-906"]],
      ["con_aviso", ["KP-907"]],
      ["anaquel", ["KP-908"]],
    ]);
  });

  it("«Hoy» no tiene «Prepárala hoy»: lo de la noche anterior que se programó hoy lleva su chapa", () => {
    const today = { ...REPRINT_1, bucket: "hoy" as const };
    expect(retryZoneGroups([today], "hoy").map((g) => g.key)).toEqual(["anaquel"]);
  });
});

describe("retryActionText", () => {
  it("no repite la chapa y deja la línea cuando dice más", () => {
    expect(retryActionText("salida_nueva_rearmar", BOX_ACTION_LABEL.salida_nueva_rearmar)).toBeNull();
    expect(retryActionText("mantener", "Mantener la caja: misma salida, QR y rótulo.")).toBe("Mantener la caja: misma salida, QR y rótulo.");
    expect(retryActionText(null, "Ya hay otra guía viva.")).toBe("Ya hay otra guía viva.");
    expect(retryActionText("mantener", null)).toBeNull();
  });
});

describe("retryScanHint (la pista del escáner)", () => {
  const data = retriesData([OVERDUE, NO_LO_QUIERE, DRIFT, REPRINT_1], [HANDOFF]);

  it("una caja de «Hoy»: la acción y su línea", () => {
    expect(retryScanHint(data, "KP-901")).toEqual({
      tone: "info",
      text: "Reintento de Lima · Hoy: Mantener — Mantener la caja: misma salida, QR y rótulo.",
    });
    expect(retryScanHint(data, "KP-905")?.text).toBe(
      "Reintento de Lima · Mañana: Reimprimir el rótulo de la misma salida — Reimprimir el rótulo de la misma salida: se retira el rótulo viejo.",
    );
  });

  it("«Desarmar y cerrar» o la chapa de «no lo quiere», en rojo", () => {
    expect(retryScanHint(data, "KP-902")?.tone).toBe("crit");
    const chipOnly = retriesData([{ ...OVERDUE, action: "mantener", chips: [{ tone: "crit", text: REPRO_NO_LO_QUIERE_CHIP }] }]);
    expect(retryScanHint(chipOnly, "KP-901")?.tone).toBe("crit");
  });

  it("no repite la acción cuando los hechos cambiaron; sin acción, solo el problema", () => {
    expect(retryScanHint(data, "KP-904")?.text).toBe("Reintento de Lima · Hoy: Salida nueva y rearmado");
    const problem = retriesData([{ ...OVERDUE, action: null, actionSource: null, actionLine: "Ya hay otra guía viva." }]);
    expect(retryScanHint(problem, "KP-901")?.text).toBe("Reintento de Lima · Hoy: Ya hay otra guía viva.");
  });

  it("la salida nueva de un acuerdo en «Por armar»: qué hacer con la caja del estante", () => {
    expect(retryScanHint(data, "KP-950")).toEqual({
      tone: "info",
      text: `Reintento de Lima · Hoy: Salida nueva y rearmado — ${HANDOFF_LINE_GF}`,
    });
  });

  it("nada que decir sin pedido, sin coincidencia, sin datos o con error", () => {
    expect(retryScanHint(data, "otro")).toBeNull();
    expect(retryScanHint(data, null)).toBeNull();
    expect(retryScanHint(data, undefined)).toBeNull();
    expect(retryScanHint(undefined, "KP-901")).toBeNull();
    expect(retryScanHint({ ...data, error: RETRY_ERROR }, "KP-901")).toBeNull();
  });
});
