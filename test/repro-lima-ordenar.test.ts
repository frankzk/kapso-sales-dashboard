// Owner, 23-11-2026: «dame la opción para ordenar por fecha de creación, fecha
// de última ruta y lo que creas conveniente. Ascendente y descendente». El orden
// del flujo sigue por defecto; los demás reordenan la misma lista.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LimaRowClass } from "@/lib/repro-lima-blocks";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import { LIMA_SORT_OPTIONS, limaSortLabel, readLimaSort, sortLimaRows, writeLimaSort } from "@/lib/repro-lima-sort";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const row = (orderId: string, over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId, storeId: "a", storeName: "Kenku", orderName: `#${orderId}`, customerName: "Ana", customerPhone: "51999000111",
  district: "Surco", orderTotal: 100, createdAt: null, macroSince: null, stage: "en_curso", substage: null, courier: null,
  dispatchedAt: null, attempts: 0, hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, salesChannel: null,
  address: null, reference: null, courierPickup: null, gf: null, scheduledOn: null, ops: null, ...over,
} as LimaPendingOrder);
const ids = (rows: LimaPendingOrder[]) => rows.map((r) => r.orderId);
const NO_CLASSES = new Map<string, LimaRowClass>();

describe("Ordenar la lista de Repro Lima", () => {
  it("por defecto, el orden del flujo, tal cual", () => {
    const rows = [row("b"), row("a")];
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "flujo", dir: "desc" }))).toEqual(["b", "a"]);
  });

  it("fecha de creación, en las dos direcciones; sin fecha, al final", () => {
    const rows = [row("sin"), row("nuevo", { createdAt: "2026-11-22T15:00:00Z" }), row("viejo", { createdAt: "2026-10-01T15:00:00Z" })];
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "creacion", dir: "asc" }))).toEqual(["viejo", "nuevo", "sin"]);
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "creacion", dir: "desc" }))).toEqual(["nuevo", "viejo", "sin"]);
  });

  it("última ruta: la última salida o, si no, el despacho; los que nunca salieron, al final", () => {
    const rows = [
      row("nunca"),
      row("despacho", { dispatchedAt: "2026-11-10T15:00:00Z" }),
      row("salida", { lastDepartureAt: "2026-11-20T15:00:00Z", dispatchedAt: "2026-11-01T15:00:00Z" }),
    ];
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "ultima_ruta", dir: "asc" }))).toEqual(["despacho", "salida", "nunca"]);
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "ultima_ruta", dir: "desc" }))).toEqual(["salida", "despacho", "nunca"]);
  });

  it("fecha agendada: el día de la Agenda; sin día, al final", () => {
    const rows = [row("sin"), row("mie"), row("lun")];
    const classes = new Map([
      ["mie", { agendaDay: "2026-11-25" } as LimaRowClass],
      ["lun", { agendaDay: "2026-11-23" } as LimaRowClass],
      ["sin", { agendaDay: null } as unknown as LimaRowClass],
    ]);
    expect(ids(sortLimaRows(rows, classes, { key: "fecha_agendada", dir: "asc" }))).toEqual(["lun", "mie", "sin"]);
    expect(ids(sortLimaRows(rows, classes, { key: "fecha_agendada", dir: "desc" }))).toEqual(["mie", "lun", "sin"]);
  });

  it("tiempo en la etapa: descendente, lo que más lleva primero", () => {
    const rows = [row("ayer", { macroSince: "2026-11-22T15:00:00Z" }), row("mes", { macroSince: "2026-10-20T15:00:00Z" })];
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "en_etapa", dir: "desc" }))).toEqual(["mes", "ayer"]);
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "en_etapa", dir: "asc" }))).toEqual(["ayer", "mes"]);
  });

  it("última llamada e intentos; empates en el orden del flujo", () => {
    const call = (at: string | null) => ({ hasCall: Boolean(at), lastCallAt: at, lastCallResult: null, movedToLimaAt: null });
    const rows = [row("sin", { management: call(null) }), row("hoy", { management: call("2026-11-23T14:00:00Z") }), row("ayer", { management: call("2026-11-22T14:00:00Z") })];
    expect(ids(sortLimaRows(rows, NO_CLASSES, { key: "ultima_llamada", dir: "asc" }))).toEqual(["ayer", "hoy", "sin"]);
    const tries = [row("uno", { attempts: 1 }), row("tres", { attempts: 3 }), row("otro-uno", { attempts: 1 })];
    expect(ids(sortLimaRows(tries, NO_CLASSES, { key: "intentos", dir: "desc" }))).toEqual(["tres", "uno", "otro-uno"]);
  });

  it("viaja en la URL; lo desconocido o el del flujo no dejan rastro", () => {
    expect(readLimaSort(new URLSearchParams("orden=creacion&dir=desc"))).toEqual({ key: "creacion", dir: "desc" });
    expect(readLimaSort(new URLSearchParams("orden=creacion"))).toEqual({ key: "creacion", dir: "asc" });
    expect(readLimaSort(new URLSearchParams("orden=otra&dir=desc"))).toEqual({ key: "flujo", dir: "asc" });
    const params = new URLSearchParams("atencion=programados&orden=intentos&dir=desc");
    writeLimaSort(params, { key: "flujo", dir: "asc" });
    expect(params.toString()).toBe("atencion=programados");
    writeLimaSort(params, { key: "ultima_ruta", dir: "desc" });
    expect(params.toString()).toBe("atencion=programados&orden=ultima_ruta&dir=desc");
  });

  it("la píldora dice qué va primero", () => {
    expect(limaSortLabel({ key: "flujo", dir: "asc" })).toBeNull();
    expect(limaSortLabel({ key: "creacion", dir: "asc" })).toBe("Creación · más antiguo primero");
    expect(limaSortLabel({ key: "ultima_ruta", dir: "desc" })).toBe("Última ruta · más reciente primero");
    expect(LIMA_SORT_OPTIONS.map((o) => o.key)).toEqual(["flujo", "creacion", "ultima_ruta", "fecha_agendada", "en_etapa", "ultima_llamada", "intentos"]);
  });

  it("el tablero ordena la lista ya armada, con su píldora, y «Quitar filtros» no lo toca", () => {
    const board = read("components/repro-lima-board.tsx");
    expect(board).toContain("const inQueue = useMemo(() => sortLimaRows(listInFlow, classes, sort), [listInFlow, classes, sort]);");
    expect(board).toContain('label="Ordenar"');
    expect(board).toContain('<Sheet look="ops" title="Ordenar la lista"');
    expect(board).toContain(":${sort.key}:${sort.dir}`}");
    expect(read("lib/repro-lima-pending.ts")).not.toMatch(/ROW_FILTER_PARAMS = \{[^}]*orden/);
  });
});
