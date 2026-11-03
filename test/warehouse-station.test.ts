import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchShipment, WarehouseShipment, WarehouseStationData } from "@/lib/dispatch-access";
import type { SwaypScanHint, WarehouseSwaypData } from "@/lib/warehouse-swayp";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

/**
 * La estación pintada en servidor (sin montar): sus `setState` no hacen nada,
 * pero sus funciones y sus marcas (`useRef`) son las de verdad. Se recogen el
 * escaneo (vía la cámara), la relectura de «Swayp por salir» (vía su apartado)
 * y lo que devuelven el aviso del escáner y la copia local.
 */
const captured = vi.hoisted(() => ({
  scans: [] as Array<(value: string) => void>,
  refreshes: [] as Array<() => Promise<unknown>>,
  hints: [] as Array<SwaypScanHint | null>,
  applied: [] as Array<[string, string]>,
  markShipmentReady: vi.fn(),
  loadWarehouseStation: vi.fn(),
}));

vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({ markShipmentReady: captured.markShipmentReady }));
vi.mock("@/app/dashboard/pedidos/almacen/actions", () => ({ loadWarehouseStation: captured.loadWarehouseStation }));
vi.mock("@/components/dispatch-camera", () => ({
  DispatchCamera: ({ onScan }: { onScan: (value: string) => void }) => {
    captured.scans.push(onScan);
    return null;
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/almacen",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/warehouse-swayp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/warehouse-swayp")>();
  return {
    ...real,
    swaypHintAfterScan: async (...args: Parameters<typeof real.swaypHintAfterScan>) => {
      const hint = await real.swaypHintAfterScan(...args);
      captured.hints.push(hint);
      return hint;
    },
    applySwaypScan: (...args: Parameters<typeof real.applySwaypScan>) => {
      captured.applied.push([args[1], args[2]]);
      return real.applySwaypScan(...args);
    },
  };
});
vi.mock("@/components/warehouse-swayp", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/warehouse-swayp")>();
  const { createElement: h } = await import("react");
  return {
    ...real,
    WarehouseSwayp: (props: Parameters<typeof real.WarehouseSwayp>[0]) => {
      captured.refreshes.push(props.onRefresh as () => Promise<unknown>);
      return h(real.WarehouseSwayp, props);
    },
  };
});

import { getWarehouseStationData } from "@/lib/dispatch-access";
import { SWAYP_NOW as LOT_NOW, swaypInput, swaypLimaGuide, swaypLot } from "@/test/helpers/warehouse-swayp-fixtures";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

interface Call {
  table: string;
  eq: [string, unknown][];
  in: [string, unknown][];
  gte: [string, unknown][];
}

/**
 * Doble de PostgREST: registra las restricciones y deja que el caso decida qué
 * filas devuelve cada consulta. Lo que se comprueba es la REGLA de la cola, no
 * la base.
 */
function supabaseDouble(resolve: (call: Call) => unknown[]) {
  const calls: Call[] = [];
  return {
    calls,
    /** La consulta que trae las salidas por armar (la que acota por pedido). */
    pendingCall: () => calls.find((c) => c.table === "shipments" && c.in.some(([col]) => col === "order_id")),
    armedCall: () => calls.find((c) => c.table === "shipments" && c.gte.length > 0),
    client: {
      from(table: string) {
        const call: Call = { table, eq: [], in: [], gte: [] };
        calls.push(call);
        const builder: Record<string, unknown> = {};
        const chain = (fn?: (...args: unknown[]) => void) =>
          (...args: unknown[]) => {
            fn?.(...args);
            return builder;
          };
        Object.assign(builder, {
          select: chain(),
          order: chain(),
          limit: chain(),
          eq: chain((col, val) => call.eq.push([col as string, val])),
          in: chain((col, val) => call.in.push([col as string, val])),
          gte: chain((col, val) => call.gte.push([col as string, val])),
          then: (done: (value: unknown) => unknown) => done({ data: resolve(call), error: null }),
        });
        return builder;
      },
    },
  };
}

const salida = (id: string, orderId: string) => ({
  id,
  store_id: "store-1",
  courier: "por_definir",
  guide_code: `G-${id}`,
  output_code: `KP-${id}`,
  order_id: orderId,
  order_name: `#KP-${id}`,
  custody_state: "empresa",
  preparation_state: "rotulo_generado",
  ready_at: null,
  customer_name: "Cliente",
  district: "San Borja",
});

describe("getWarehouseStationData", () => {
  it("baja desde los pedidos Por armar a sus salidas, con la operación de cada uno", async () => {
    const double = supabaseDouble((call) => {
      if (call.table === "order_master") {
        return [
          { order_id: "pedido-lima", macro_operation: "lima" },
          { order_id: "pedido-provincia", macro_operation: "provincia_cod" },
        ];
      }
      if (call.gte.length) {
        return [{ ...salida("armada", "pedido-lima"), preparation_state: "listo_despacho", ready_at: "2026-08-07T15:00:00Z" }];
      }
      return [salida("s1", "pedido-lima"), salida("s2", "pedido-provincia")];
    });
    createServerSupabaseMock.mockResolvedValue(double.client);

    const data = await getWarehouseStationData();

    expect(data.pending.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(data.pending.map((s) => s.operation)).toEqual(["lima", "provincia_cod"]);
    expect(data.armedToday.map((s) => s.id)).toEqual(["armada"]);
    expect(data.pendingOmitted).toBe(0);
  });

  it("acota las salidas a los pedidos Por armar, en casa y sin escanear", async () => {
    const double = supabaseDouble((call) =>
      call.table === "order_master" ? [{ order_id: "pedido-lima", macro_operation: "lima" }] : [],
    );
    createServerSupabaseMock.mockResolvedValue(double.client);

    await getWarehouseStationData();

    const pending = double.pendingCall();
    expect(pending?.in).toContainEqual(["order_id", ["pedido-lima"]]);
    expect(pending?.eq).toContainEqual(["custody_state", "empresa"]);
    expect(pending?.in).toContainEqual(["preparation_state", ["rotulo_generado", "en_armado"]]);

    const armed = double.armedCall();
    expect(armed?.eq).toContainEqual(["preparation_state", "listo_despacho"]);
    // El corte del día de Lima es 05:00Z: sin él, "armados hoy" arrastraría ayer.
    expect(String(armed?.gte[0]?.[1])).toMatch(/T05:00:00\.000Z$/);
  });

  it("no busca salidas cuando ningún pedido está Por armar", async () => {
    const double = supabaseDouble(() => []);
    createServerSupabaseMock.mockResolvedValue(double.client);

    const data = await getWarehouseStationData();

    expect(double.pendingCall()).toBeUndefined();
    expect(data.pending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// «Swayp por salir · Lima» en la estación (fase 1, owner 03-11-2026): la celda
// de «Por empacar», el enlace de la cabecera, la chapa de «Armados hoy», el
// segundo aviso del escáner y la relectura que no pierde un escaneo.
// ---------------------------------------------------------------------------

const { WarehouseStation } = await import("@/components/warehouse-station");
const { applySwaypScan, emptyWarehouseSwayp, SWAYP_ERROR } = await import("@/lib/warehouse-swayp");

const stores = [{ id: "store-1", name: "Kenku Peru" }] as unknown as Parameters<typeof WarehouseStation>[0]["stores"];
const LOT = swaypLot();

function dispatchShipment(id: string, extra: Partial<DispatchShipment> = {}): DispatchShipment {
  return {
    id,
    store_id: "store-1",
    courier: "fenix",
    guide_code: `G-${id}`,
    output_number: 2,
    output_code: id.replace(/^sh-/, ""),
    qr_token: null,
    preparation_state: "no_iniciado",
    custody_state: "empresa",
    ready_at: null,
    order_id: `o-${id.replace(/^sh-/, "").split("-")[0]}`,
    order_name: null,
    customer_name: "Cliente",
    customer_phone: null,
    district: "Ate",
    province: null,
    product: null,
    ...extra,
  };
}

function station(armedToday: DispatchShipment[] = []): WarehouseStationData {
  return { pending: [], blocked: [], armedToday, pendingOmitted: 0 };
}

function renderStation(initialSwayp?: WarehouseSwaypData, data: WarehouseStationData = station()): string {
  return renderToStaticMarkup(createElement(WarehouseStation, { initialData: data, initialSwayp, stores }));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

/** Lo que va entre dos marcas del HTML. */
function slice(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = html.indexOf(end, from);
  expect(to, end).toBeGreaterThan(from);
  return html.slice(from, to);
}

const frameOf = (html: string) => slice(html, ">Por empacar<", ">Por armar<");
const navOf = (html: string) => slice(html, '<nav aria-label="Otras pantallas del almacén"', "</nav>");

beforeEach(() => {
  captured.scans.length = 0;
  captured.refreshes.length = 0;
  captured.hints.length = 0;
  captured.applied.length = 0;
  captured.markShipmentReady.mockReset();
  captured.loadWarehouseStation.mockReset().mockResolvedValue(station());
  // El lote es del martes 3 nov a las 17:42: el reloj de la estación también,
  // y corre (la relectura compara la hora del escaneo con la de la lectura).
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(LOT_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("la celda «Swayp · Lima» del marco «Por empacar»", () => {
  it("es la cuarta celda, lleva al apartado y no suma al número de Lima", () => {
    const frame = frameOf(renderStation(LOT));
    expect(frame).toContain("grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-2 xl:grid-cols-4");
    expect(frame).toContain('<a href="#swayp"');
    const t = text(frame);
    expect(t).toContain("Swayp · Lima ↓ Faltan 2 miércoles 4 nov · 4 programadas · 2 armadas");
    expect(t).toContain("Faltan 3 h 38 min para el corte de las 21:20: déjalo listo.");
    // Lo urgente de hoy (KP40-S01 sale hoy y sigue aquí) sube a la celda.
    expect(t).toContain("Hoy: 1 sin armar");
    // Lima, Agencia y Provincia COD siguen en cero: las guías Swayp no están en «Por armar».
    // Lima no dice «Nada por empacar» con faltas Swayp de Lima: esas cajas también se arman aquí.
    expect(t.match(/En cero\. Nada por empacar\./g)).toHaveLength(2);
    expect(t).toContain("Lima 0 En cero en «Por armar».");
    expect(frame.indexOf(">Lima<")).toBeLessThan(frame.indexOf("Swayp · Lima"));
    // Cuatro celdas llenan el marco: la de Swayp no se estira.
    expect(frame).not.toContain("col-span");
  });

  it("con «Sin clasificar» son cinco celdas: la de Swayp ocupa la última fila entera, sin huecos", () => {
    const unknown = { ...dispatchShipment("sh-KP88-S01", { courier: "propio" }), operation: "desconocida", delivery_status: "pendiente", created_at: "2026-11-03T15:00:00Z" } as WarehouseShipment;
    const frame = frameOf(renderStation(LOT, { ...station(), pending: [unknown] }));
    expect(frame).toMatch(/<a href="#swayp" class="[^"]*sm:col-span-2 xl:col-span-4/);
  });

  it("cargando, esqueleto; con error, «No se pudo leer»", () => {
    const loading = frameOf(renderStation(undefined));
    expect(loading).toContain('<a href="#swayp"');
    expect(loading).toContain("animate-pulse");
    const error = frameOf(renderStation(emptyWarehouseSwayp({ nowIso: LOT.nowIso, error: SWAYP_ERROR })));
    expect(text(error)).toContain("No se pudo leer");
  });

  it("la cabecera enlaza a «Swayp por salir» con lo que falta, solo con datos y sin error", () => {
    expect(text(navOf(renderStation(LOT)))).toContain("Swayp por salir · hoy: 1 sin armar · faltan 2 ↓");
    expect(navOf(renderStation(LOT))).toContain('<a href="#swayp" class="inline-flex');
    expect(navOf(renderStation(undefined))).not.toContain("#swayp");
    expect(navOf(renderStation(emptyWarehouseSwayp({ nowIso: LOT.nowIso, error: SWAYP_ERROR })))).not.toContain("#swayp");
  });

  it("el apartado va debajo de la estación y encima de «Reintentos por salir»", () => {
    const html = renderStation(LOT);
    const card = html.indexOf(">Armados hoy<");
    const swayp = html.indexOf('<section id="swayp"');
    const retries = html.indexOf('<section id="reintentos"');
    expect(swayp).toBeGreaterThan(card);
    expect(retries).toBeGreaterThan(swayp);
  });
});

describe("«Armados hoy»: la chapa del lote Swayp", () => {
  it("las cajas de un lote cargado dicen a qué lote van; las demás, nada", () => {
    const armed = [
      dispatchShipment("sh-KP30-S01", { preparation_state: "listo_despacho", ready_at: "2026-11-03T21:00:00Z" }),
      dispatchShipment("sh-KP201878-S01", { preparation_state: "listo_despacho", ready_at: "2026-11-03T12:00:00Z" }),
      dispatchShipment("sh-KP99-S01", { courier: "propio", preparation_state: "listo_despacho", ready_at: "2026-11-03T13:00:00Z" }),
    ];
    const list = slice(renderStation(LOT, station(armed)), ">Armados hoy<", '<section id="swayp"');
    const t = text(list);
    expect(t).toContain("KP30-S01 Swayp · mié 4 nov");
    expect(t).toContain("KP201878-S01 Swayp · mar 3 nov");
    expect(t).not.toMatch(/KP99-S01 Swayp/);
    expect(list).toMatch(/bg-info-bg text-info-fg[^"]*">Swayp · mié 4 nov/);
    // Sin lote cargado no hay chapa.
    expect(text(slice(renderStation(undefined, station(armed)), ">Armados hoy<", '<section id="swayp"'))).not.toContain("Swayp ·");
  });
});

describe("el escáner: el segundo aviso, con el lote cargado y sin tocar el servidor", () => {
  async function scan(lot: WarehouseSwaypData | undefined, code: string, result: Record<string, unknown>) {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    captured.markShipmentReady.mockResolvedValueOnce(result);
    renderStation(lot);
    const onScan = captured.scans.at(-1);
    if (!onScan) throw new Error("la estación no pintó la cámara");
    // El escaneo termina cuando relee la estación; el aviso Swayp llega aparte.
    const reloads = captured.loadWarehouseStation.mock.calls.length;
    const hints = captured.hints.length;
    onScan(code);
    await vi.waitFor(() => expect(captured.loadWarehouseStation.mock.calls.length).toBeGreaterThan(reloads));
    expect(captured.markShipmentReady).toHaveBeenLastCalledWith(code);
    await vi.waitFor(() => expect(captured.hints.length).toBeGreaterThan(hints));
    return captured.hints.at(-1) ?? null;
  }

  /** La relectura por GET de «Swayp por salir» (solo antes de decir «fuera»). */
  function stubSwaypRead(data: WarehouseSwaypData | Error) {
    const read = vi.fn(async () => {
      if (data instanceof Error) throw data;
      return { ok: true, status: 200, json: async () => data };
    });
    vi.stubGlobal("fetch", read);
    return read;
  }

  it("una salida del lote con otras por armar: cuántas van y cuál falta, con su distrito", async () => {
    const read = stubSwaypRead(new Error("no se relee"));
    const hint = await scan(LOT, "KP7-S02", { notice: "KP7-S02 quedó listo para despacho.", shipment: dispatchShipment("sh-KP7-S02") });
    expect(hint).toEqual({ kind: "lote", tone: "info", text: "Swayp miércoles 4 nov · 3 de 4 armadas · falta KP143987-S02 (San Bartolo)." });
    // Con lo cargado: sin pedir nada al servidor.
    expect(read).not.toHaveBeenCalled();
  });

  it("la que completa el lote: júntalas en el sitio de Swayp", async () => {
    const one = applySwaypScan(LOT, "sh-KP7-S02", "2026-11-03T22:50:00.000Z");
    const hint = await scan(one, "KP143987-S02", { notice: "listo", shipment: dispatchShipment("sh-KP143987-S02") });
    expect(hint).toEqual({ kind: "completo", tone: "ok", text: "Swayp miércoles 4 nov · 4 de 4 armadas. Lote completo: júntalas en el sitio de Swayp." });
  });

  it("el rótulo viejo de la hermana de Grupo GF: imprime el de Swayp", async () => {
    const shipment = dispatchShipment("sh-KP7-S01", { courier: "propio", output_code: "KP7-S01", preparation_state: "listo_despacho" });
    const hint = await scan(LOT, "KP7-S01", { notice: "KP7-S01 ya estaba listo para despacho.", shipment });
    expect(hint).toEqual({
      kind: "rotulo_viejo",
      tone: "warn",
      text: "Ese rótulo es KP7-S01 (Grupo GF). El pedido sale por Swayp con KP7-S02: imprime ese rótulo y escanéalo.",
    });
  });

  it("una que salió de la lista y una caja Swayp que no es de ningún lote (tras releer una vez)", async () => {
    const cancelled = await scan(LOT, "KP10-S01", { notice: "listo", shipment: dispatchShipment("sh-KP10-S01") });
    expect(cancelled).toEqual({ kind: "salio", tone: "crit", text: "Swayp canceló esta guía: no la juntes con el lote." });
    const moved = await scan(LOT, "KP14-S01", { notice: "listo", shipment: dispatchShipment("sh-KP14-S01") });
    expect(moved).toEqual({ kind: "salio", tone: "warn", text: "Esta guía ahora sale el viernes 6 nov: guárdala aparte." });
    const read = stubSwaypRead(LOT);
    const outside = await scan(LOT, "KP77-S01", { notice: "listo", shipment: dispatchShipment("sh-KP77-S01") });
    expect(read).toHaveBeenCalledTimes(1);
    expect(outside).toEqual({ kind: "fuera", tone: "warn", text: "Esta caja Swayp no sale hoy ni el miércoles 4 nov: guárdala aparte y revisa la fecha en el pedido." });
  });

  it("una guía agregada después de la última lectura no se manda a guardar aparte: la relectura la encuentra", async () => {
    const added = swaypLot(undefined, swaypInput([
      swaypLimaGuide("KP77-S01", { guide: "50000169999", district: "Lince", createdAt: "2026-11-03T22:30:00Z", emittedAt: "2026-11-03T22:30:00Z" }),
    ]));
    stubSwaypRead(added);
    const hint = await scan(LOT, "KP77-S01", { notice: "listo", shipment: dispatchShipment("sh-KP77-S01") });
    expect(hint).toMatchObject({ kind: "completo", tone: "ok" });
    // Si la relectura falla, ningún aviso antes que uno falso.
    stubSwaypRead(new TypeError("Failed to fetch"));
    expect(await scan(LOT, "KP77-S01", { notice: "listo", shipment: dispatchShipment("sh-KP77-S01") })).toBeNull();
  });

  it("con error del escaneo o sin lote cargado, no hay segundo aviso", async () => {
    expect(await scan(LOT, "KP7-S02", { error: "Ese paquete ya no figura en custodia de la empresa." })).toBeNull();
    expect(await scan(undefined, "KP7-S02", { notice: "listo", shipment: dispatchShipment("sh-KP7-S02") })).toBeNull();
  });
});

describe("«Swayp por salir»: una lectura a la vez, y la que salió antes de un escaneo no lo pierde", () => {
  function stubFetch() {
    const load = vi.fn<() => Promise<WarehouseSwaypData>>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const data = await load();
      return { ok: true, status: 200, json: async () => data };
    }));
    return load;
  }

  function mounted(lot: WarehouseSwaypData = LOT) {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    renderStation(lot);
    const refresh = captured.refreshes.at(-1);
    const onScan = captured.scans.at(-1);
    if (!refresh || !onScan) throw new Error("la estación no pintó «Swayp por salir» o la cámara");
    return { refresh, onScan };
  }

  it("dos avisos seguidos al volver a la pestaña piden una sola lectura; un fallo no lanza y suelta la marca", async () => {
    const { refresh } = mounted();
    const load = stubFetch();
    let finish!: (data: WarehouseSwaypData) => void;
    load.mockImplementationOnce(() => new Promise<WarehouseSwaypData>((done) => { finish = done; }));
    const first = refresh();
    await refresh();
    expect(load).toHaveBeenCalledTimes(1);
    finish(swaypLot());
    await first;
    load.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(refresh()).resolves.toBeNull();
    load.mockResolvedValueOnce(swaypLot());
    await refresh();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("un escaneo hecho mientras la lectura iba en camino se vuelve a aplicar sobre la respuesta", async () => {
    const { refresh, onScan } = mounted();
    const load = stubFetch();
    let finish!: (data: WarehouseSwaypData) => void;
    load.mockImplementationOnce(() => new Promise<WarehouseSwaypData>((done) => { finish = done; }));
    const pending = refresh();
    captured.markShipmentReady.mockResolvedValueOnce({ notice: "listo", shipment: dispatchShipment("sh-KP7-S02") });
    onScan("KP7-S02");
    await vi.waitFor(() => expect(captured.loadWarehouseStation).toHaveBeenCalled());
    captured.applied.length = 0;
    finish(swaypLot());
    await pending;
    expect(captured.applied.map(([id]) => id)).toEqual(["sh-KP7-S02"]);
  });

  it("un escaneo anterior a la lectura no se vuelve a aplicar: ya lo trae el servidor", async () => {
    const { refresh, onScan } = mounted();
    const load = stubFetch();
    captured.markShipmentReady.mockResolvedValueOnce({ notice: "listo", shipment: dispatchShipment("sh-KP7-S02") });
    onScan("KP7-S02");
    await vi.waitFor(() => expect(captured.loadWarehouseStation).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 5));
    captured.applied.length = 0;
    load.mockResolvedValueOnce(swaypLot());
    await refresh();
    expect(captured.applied).toEqual([]);
  });

  it("las cajas que no son de Swayp no se anotan", async () => {
    const { refresh, onScan } = mounted();
    const load = stubFetch();
    let finish!: (data: WarehouseSwaypData) => void;
    load.mockImplementationOnce(() => new Promise<WarehouseSwaypData>((done) => { finish = done; }));
    const pending = refresh();
    captured.markShipmentReady.mockResolvedValueOnce({ notice: "listo", shipment: dispatchShipment("sh-KP7-S01", { courier: "propio" }) });
    onScan("KP7-S01");
    await vi.waitFor(() => expect(captured.loadWarehouseStation).toHaveBeenCalled());
    captured.applied.length = 0;
    finish(swaypLot());
    await pending;
    expect(captured.applied).toEqual([]);
  });
});
