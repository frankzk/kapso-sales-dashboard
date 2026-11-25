import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  allCourierRows,
  allCourierRowsCounted,
  COURIER_ROWS_CONCURRENCY,
  COURIER_ROWS_SAFE_RESPONSE,
  COURIER_ROWS_WIDE_BATCH,
  courierRowsByIds,
  courierRowsByIdsWide,
  nextDispatchMode,
} from "../lib/courier-flow";

describe("next task, not repeated assignment", () => {
  it("preserves load membership and custody against legacy route actions", () => {
    const source = readFileSync(new URL("../app/dashboard/rutas/actions.ts", import.meta.url), "utf8");
    for (const name of ["addStops", "removeStop", "startRoute"]) {
      const body = source.split("export async function " + name)[1]?.split("export async function ")[0] ?? "";
      expect(body).toContain("await gfPlanningBlocker(");
      expect(body).toContain("if (gfBlocker) return");
    }
  });
  it("opens an assigned draft directly in office verification", () => {
    expect(nextDispatchMode({ state: "draft", kind: "reparto", items: [{}] }, true)).toBe("office");
  });
  it("opens an empty box for planning and ignores removed packages", () => {
    expect(nextDispatchMode({ state: "draft", kind: "reparto", items: [{ removed_at: "now" }] }, true)).toBe("build");
  });
  it("moves to receipt only after office completion", () => {
    expect(nextDispatchMode({ state: "ready_for_pickup", kind: "reparto", items: [{ office_checked_at: "now" }] }, true)).toBe("pickup");
    expect(nextDispatchMode({ state: "ready_for_pickup", kind: "entrega_courier", items: [{ office_checked_at: "now" }] }, true)).toBe("office");
  });
  it("does not offer assignment to pickup-only staff", () => {
    expect(nextDispatchMode({ state: "draft", kind: "reparto", items: [] }, false)).toBe("pickup");
  });
});

describe("whole eligible universe", () => {
  it("loads beyond 300 and beyond the database row cap", async () => {
    const source = Array.from({ length: 1247 }, (_, i) => i);
    const result = await allCourierRows(async (from, to) => ({ data: source.slice(from, to + 1), error: null }));
    expect(result).toEqual(source);
    expect(result.includes(1246)).toBe(true);
  });
  it("handles an exact full page and an empty source", async () => {
    const source = Array.from({ length: 500 }, (_, i) => i);
    expect(await allCourierRows(async (from, to) => ({ data: source.slice(from, to + 1), error: null }))).toEqual(source);
    expect(await allCourierRows(async () => ({ data: [], error: null }))).toEqual([]);
  });
  it("does not present a partial read as a complete list", async () => {
    await expect(allCourierRows(async () => ({ data: null, error: { message: "unavailable" } }))).rejects.toThrow("unavailable");
  });
  it("chunks dependent lookups without omitting older rows", async () => {
    const ids = Array.from({ length: 1107 }, (_, i) => String(i));
    const result = await courierRowsByIds(ids, async (batch) => {
      expect(batch.length).toBeLessThanOrEqual(100);
      return { data: batch, error: null };
    });
    expect(result.data).toEqual(ids);
  });
  // Owner, 21-11-2026: «Repro Lima anda cargando súper lento». Los lotes iban de a uno.
  it("lee hasta cuatro lotes a la vez y devuelve las filas en el orden de los lotes", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    let inFlight = 0;
    let peak = 0;
    const result = await courierRowsByIds(ids, async (batch) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // El primer lote tarda más: igual tiene que salir primero.
      await new Promise((resolve) => setTimeout(resolve, batch[0] === "0" ? 20 : 1));
      inFlight--;
      return { data: batch, error: null };
    });
    expect(peak).toBe(COURIER_ROWS_CONCURRENCY);
    expect(COURIER_ROWS_CONCURRENCY).toBe(4);
    expect(result.data).toEqual(ids);
  });
  it("un lote con error corta la lectura: nunca una lista parcial", async () => {
    const ids = Array.from({ length: 700 }, (_, i) => String(i));
    await expect(courierRowsByIds(ids, async (batch) => (
      batch[0] === "300" ? { data: null, error: { message: "caído" } } : { data: batch, error: null }
    ))).rejects.toThrow("caído");
    expect((await courierRowsByIds([], async () => ({ data: ["x"], error: null }))).data).toEqual([]);
  });
});

// Owner, 25-11-2026: «que Repro Lima quede con carga rápida». Medido ese día: unas 260 consultas pequeñas por
// carga (cada tabla de a 100 pedidos). Los lotes anchos son la cuarta parte, y lo que no puede pasar es que un
// lote ancho llegue cortado por el tope de filas del servidor sin que nadie lo note.
describe("lotes anchos: menos consultas y nunca una respuesta cortada", () => {
  /** Un servidor con tope de filas por respuesta, como PostgREST: corta sin avisar y solo el conteo lo delata. */
  const server = (rowsOf: (id: string) => string[], cap: number, withCount: boolean) => {
    const calls: number[] = [];
    const read = async (batch: string[]) => {
      calls.push(batch.length);
      const all = batch.flatMap(rowsOf);
      return { data: all.slice(0, cap), error: null, ...(withCount ? { count: all.length } : {}) };
    };
    return { calls, read };
  };

  it("lee de a 400 ids: 1.184 pedidos son 3 consultas, no 12", async () => {
    expect(COURIER_ROWS_WIDE_BATCH).toBe(400);
    const ids = Array.from({ length: 1184 }, (_, i) => String(i));
    const { calls, read } = server((id) => [id], 1000, true);
    const result = await courierRowsByIdsWide(ids, read);
    expect(result.data).toEqual(ids);
    expect(calls).toEqual([400, 400, 384]);
  });

  it("con el conteo: si hay más filas que las que llegaron, parte el lote y lo relee completo", async () => {
    // Tres filas por id: 400 ids son 1.200 filas y el servidor devuelve 1.000.
    const ids = Array.from({ length: 400 }, (_, i) => String(i));
    const { calls, read } = server((id) => [`${id}a`, `${id}b`, `${id}c`], 1000, true);
    const result = await courierRowsByIdsWide(ids, read);
    expect(result.data).toEqual(ids.flatMap((id) => [`${id}a`, `${id}b`, `${id}c`]));
    expect(calls).toEqual([400, 200, 200]);
  });

  it("con el conteo, una respuesta grande que llegó entera no se parte", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => String(i));
    const { calls, read } = server((id) => [`${id}a`, `${id}b`], 1000, true);
    expect((await courierRowsByIdsWide(ids, read)).data).toHaveLength(800);
    expect(calls).toEqual([400]);
  });

  it("sin el conteo: 500 filas o más se dan por posiblemente cortadas y el lote se parte", async () => {
    expect(COURIER_ROWS_SAFE_RESPONSE).toBe(500);
    // Un servidor con tope de 500: sin conteo no hay cómo saber si faltó algo.
    const ids = Array.from({ length: 400 }, (_, i) => String(i));
    const { calls, read } = server((id) => [`${id}a`, `${id}b`], 500, false);
    const result = await courierRowsByIdsWide(ids, read);
    expect(result.data).toEqual(ids.flatMap((id) => [`${id}a`, `${id}b`]));
    expect(calls).toEqual([400, 200, 200]);
    // Por debajo de 500 se confía en la respuesta: una sola consulta.
    const small = server((id) => [id], 500, false);
    expect((await courierRowsByIdsWide(ids, small.read)).data).toEqual(ids);
    expect(small.calls).toEqual([400]);
  });

  it("parte tantas veces como haga falta y conserva el orden de los ids", async () => {
    // Tope de 300 filas. El id «7» trae 250 y los demás 30: el lote de 16 no cabe, su primera mitad
    // tampoco, y la mitad de esa mitad tampoco.
    const ids = Array.from({ length: 16 }, (_, i) => String(i));
    const rowsOf = (id: string) => Array.from({ length: id === "7" ? 250 : 30 }, (_, i) => `${id}-${i}`);
    const { calls, read } = server(rowsOf, 300, true);
    const result = await courierRowsByIdsWide(ids, read);
    expect(result.data).toEqual(ids.flatMap(rowsOf));
    expect([...calls].sort((a, b) => b - a)).toEqual([16, 8, 8, 4, 4, 2, 2]);
  });

  it("un solo id que no cabe en una respuesta no se devuelve a medias: es un error", async () => {
    const { read } = server(() => Array.from({ length: 1500 }, (_, i) => String(i)), 1000, true);
    await expect(courierRowsByIdsWide(["a", "b"], read)).rejects.toThrow("tiene que ir paginada");
  });

  it("va de a cuatro lotes, un error corta la lectura y sin ids no consulta", async () => {
    const ids = Array.from({ length: 4000 }, (_, i) => String(i));
    let inFlight = 0;
    let peak = 0;
    const result = await courierRowsByIdsWide(ids, async (batch) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, batch[0] === "0" ? 20 : 1));
      inFlight--;
      return { data: batch, error: null, count: batch.length };
    });
    expect(peak).toBe(COURIER_ROWS_CONCURRENCY);
    expect(result.data).toEqual(ids);
    await expect(courierRowsByIdsWide(ids, async (batch) => (
      batch[0] === "800" ? { data: null, error: { message: "caído" }, count: null } : { data: batch, error: null, count: batch.length }
    ))).rejects.toThrow("caído");
    let asked = 0;
    expect((await courierRowsByIdsWide([], async () => { asked++; return { data: ["x"], error: null }; })).data).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe("páginas a la vez cuando se sabe cuántas faltan", () => {
  /**
   * Una fuente paginada; `count` es lo que dice el servidor (`"sin"`: la respuesta no lo trae).
   * Como PostgREST: con el conteo pedido, una página que empieza más allá de la última fila es un error.
   */
  const source = (total: number, count: number | null | "sin" = total) => {
    const rows = Array.from({ length: total }, (_, i) => i);
    const pages: number[] = [];
    const counted: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetchPage = async (from: number, to: number, withCount: boolean) => {
      pages.push(from / 500);
      if (withCount) counted.push(from / 500);
      if (withCount && from > total) return { data: null, error: { message: "Requested range not satisfiable" }, count: null };
      inFlight++;
      peak = Math.max(peak, inFlight);
      // La página 1 tarda más que las siguientes: igual va en su lugar.
      await new Promise((resolve) => setTimeout(resolve, from === 500 ? 15 : 1));
      inFlight--;
      return { data: rows.slice(from, to + 1), error: null, ...(count === "sin" ? {} : { count }) };
    };
    return { rows, pages, counted, fetchPage, peak: () => peak };
  };

  it("1.184 pedidos: la primera página y después las otras dos juntas, en orden", async () => {
    const s = source(1184);
    expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
    expect([...s.pages].sort()).toEqual([0, 1, 2]);
    expect(s.peak()).toBe(2);
  });

  it("solo la primera página pide el conteo: las demás no pueden caer en «fuera de rango»", async () => {
    // Con el conteo pedido, el servidor responde con error a una página que empieza después de la última fila.
    for (const s of [source(1184), source(1000), source(1100, 2400), source(1730, 1000), source(320), source(0)]) {
      expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
      expect(s.counted).toEqual([0]);
    }
  });

  it("una sola página no pide más", async () => {
    const s = source(320);
    expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
    expect(s.pages).toEqual([0]);
    const empty = source(0);
    expect(await allCourierRowsCounted(empty.fetchPage)).toEqual([]);
    expect(empty.pages).toEqual([0]);
  });

  it("sin conteo lee página por página, como `allCourierRows`", async () => {
    for (const count of [null, "sin"] as const) {
      const s = source(1247, count);
      expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
      expect(s.pages).toEqual([0, 1, 2]);
      expect(s.peak()).toBe(1);
    }
  });

  it("un múltiplo exacto de 500 termina con la página vacía, sin perder ni repetir filas", async () => {
    const s = source(1000);
    expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
    expect(s.pages).toEqual([0, 1, 2]);
    const one = source(500);
    expect(await allCourierRowsCounted(one.fetchPage)).toEqual(one.rows);
    expect(one.pages).toEqual([0, 1]);
  });

  it("si entraron filas mientras se leía (el conteo quedó corto), sigue hasta una página que no esté llena", async () => {
    // El servidor dijo 1.000 y hay 1.730: las páginas 2 y 3 se leen después, una por una.
    const s = source(1730, 1000);
    expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
    expect(s.pages).toEqual([0, 1, 2, 3]);
  });

  it("si salieron filas mientras se leía (el conteo quedó largo), corta en la primera página que no está llena", async () => {
    // El servidor dijo 2.400 y hay 1.100: la página 2 llega con 100 filas y ahí termina.
    const s = source(1100, 2400);
    expect(await allCourierRowsCounted(s.fetchPage)).toEqual(s.rows);
  });

  it("un error en cualquier página corta la lectura: nunca una lista parcial", async () => {
    await expect(allCourierRowsCounted(async () => ({ data: null, error: { message: "unavailable" }, count: null }))).rejects.toThrow("unavailable");
    await expect(allCourierRowsCounted(async (from) => (
      from === 1000 ? { data: null, error: { message: "caído" }, count: null } : { data: Array.from({ length: 500 }, () => 1), error: null, count: 1600 }
    ))).rejects.toThrow("caído");
  });
});
