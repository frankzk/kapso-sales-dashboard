import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readAllPages } from "@/lib/postgrest-pages";

// Un PostgREST de mentira: corta en `cap` filas como el de verdad.
function fakeTable(total: number, cap = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, from + cap);
    return Promise.resolve({ data: rows.slice(from, end), error: null });
  };
  return { page, calls };
}

describe("readAllPages", () => {
  // El caso del 03-11-2026: un lote con 1.105 hechos, y los dos «Entregado» a
  // mano eran las filas 1.104 y 1.105. Sin paginar, el recálculo no los veía.
  it("trae las filas que pasan de 1000", async () => {
    const t = fakeTable(1105);
    const { rows, error } = await readAllPages<{ id: number }>(t.page);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1105);
    expect(rows.at(-1)).toEqual({ id: 1104 });
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("con menos de una página pide una sola vez", async () => {
    const t = fakeTable(15);
    const { rows } = await readAllPages(t.page);
    expect(rows).toHaveLength(15);
    expect(t.calls).toHaveLength(1);
  });

  it("si la última página llega justa, pide una más y para en la vacía", async () => {
    const t = fakeTable(2000);
    const { rows } = await readAllPages(t.page);
    expect(rows).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
  });

  it("un error devuelve lo leído y el error", async () => {
    let n = 0;
    const { rows, error } = await readAllPages<{ id: number }>(() => {
      n += 1;
      return Promise.resolve(
        n === 1
          ? { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }
          : { data: null, error: { message: "timeout" } },
      );
    });
    expect(rows).toHaveLength(1000);
    expect(error).toEqual({ message: "timeout" });
  });
});

describe("el recálculo del Master pagina sus lecturas", () => {
  const source = readFileSync("lib/order-master.ts", "utf8");

  // Cada lectura por lote que puede pasar de 1000 filas tiene que ir por
  // readAllPages y ordenada por una clave única.
  it.each([
    ["order_events", '.order("id")'],
    ["shipments", '.order("id")'],
    ["shipment_calls", '.order("id")'],
    ["order_payments", '.order("id")'],
    ["pickup_key_shares", '.order("id")'],
    ["delivery_stops", '.order("id")'],
    ["urpi_report_rows", '.order("urpi_row")'],
  ])("%s", (table, order) => {
    const at = source.indexOf(`.from("${table}")`);
    expect(at).toBeGreaterThan(-1);
    const window = source.slice(Math.max(0, at - 300), at + 400);
    expect(window).toContain("readAllPages");
    expect(window).toContain(order);
    expect(window).toContain(".range(from, to)");
  });
});
