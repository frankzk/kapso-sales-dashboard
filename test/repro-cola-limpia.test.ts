import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { sinPedidoAnuladoEnShopify } from "@/lib/shipments-access";

/**
 * Lo que la cola de Repro Provincia listaba sin tener nada que ver (04-10-2026).
 *
 * EL CASO REAL. Con la cola abierta como la trabaja el equipo —sin Lima, «Swayp:
 * Fuera de cobertura», «Sin contactar hoy»— salían 341 filas y 47 no eran
 * trabajo de reprogramación: 15 de pedidos ANULADOS en Shopify, 12 de pedidos
 * cuyo primer despacho aún no salía, 17 guías Olva y 3 por cerrar. Y al revés:
 * 404 pedidos con la recuperación activa no aparecían, porque las cerradas se
 * leían con un tope de 1.000 filas.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const ACCESS = "lib/shipments-access.ts";

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start));
}

/** Un cliente mínimo: responde `orders` con los ids anulados que se le den. */
function fakeOrders(anulados: string[], opts: { error?: boolean } = {}) {
  const pedidos: string[][] = [];
  const sb = {
    from(table: string) {
      expect(table).toBe("orders");
      let ids: string[] = [];
      const q = {
        select: () => q,
        in: (_col: string, values: string[]) => {
          ids = values;
          pedidos.push(values);
          return q;
        },
        not: () =>
          Promise.resolve(
            opts.error
              ? { data: null, error: { message: "boom" } }
              : { data: ids.filter((id) => anulados.includes(id)).map((id) => ({ id })), error: null },
          ),
      };
      return q;
    },
  };
  return { sb: sb as unknown as SupabaseClient, pedidos };
}

describe("un pedido anulado en Shopify no se reprograma", () => {
  it("saca las guías cuyo pedido se anuló y deja las demás", async () => {
    const { sb } = fakeOrders(["o-anulado"]);
    const filas = [
      { id: "g1", order_id: "o-vivo" },
      { id: "g2", order_id: "o-anulado" },
      { id: "g3", order_id: "o-vivo" },
    ];
    const quedan = await sinPedidoAnuladoEnShopify(sb, filas);
    expect(quedan.map((f) => f.id)).toEqual(["g1", "g3"]);
  });

  it("una guía sin pedido vinculado se queda: no se esconde por no saber", async () => {
    const { sb, pedidos } = fakeOrders(["o-anulado"]);
    const quedan = await sinPedidoAnuladoEnShopify(sb, [
      { id: "g1", order_id: null },
      { id: "g2", order_id: "o-anulado" },
    ]);
    expect(quedan.map((f) => f.id)).toEqual(["g1"]);
    expect(pedidos.flat()).toEqual(["o-anulado"]);
  });

  it("si la lectura falla, no recorta nada", async () => {
    const { sb } = fakeOrders(["o-anulado"], { error: true });
    const filas = [{ id: "g2", order_id: "o-anulado" }];
    expect(await sinPedidoAnuladoEnShopify(sb, filas)).toEqual(filas);
  });

  it("pregunta por los pedidos en tandas, no en una URL gigante", async () => {
    const { sb, pedidos } = fakeOrders([]);
    const filas = Array.from({ length: 650 }, (_, i) => ({ id: `g${i}`, order_id: `o${i}` }));
    await sinPedidoAnuladoEnShopify(sb, filas);
    expect(pedidos.map((p) => p.length)).toEqual([300, 300, 50]);
  });

  it("la lista y el chip de Pendiente pasan por el MISMO recorte", () => {
    const source = read(ACCESS);
    const lista = bodyOf(source, "export async function getStoreShipments(");
    expect(lista).toContain("esColaDeReprogramacion(cats) ? await sinPedidoAnuladoEnShopify(sb, out) : out");
    const chip = bodyOf(source, "async function filasDeColaPendiente(");
    expect(chip).toContain("return sinPedidoAnuladoEnShopify(sb, out);");
  });
});

describe("una salida «por definir» es despacho, no reprogramación", () => {
  it("sale de Pendiente en la lista y en el chip, desde la misma constante", () => {
    const source = read(ACCESS);
    expect(source).toContain("const SALIDA_POR_DEFINIR = COURIER_TBD;");
    expect(source.match(/\.neq\("courier", SALIDA_POR_DEFINIR\)/g) ?? []).toHaveLength(2);
    // Nadie vuelve a escribir el nombre a mano.
    expect(source).not.toContain('"por_definir"');
  });

  it("solo en Pendiente: la pestaña Anulado sigue siendo el registro", () => {
    const source = read(ACCESS);
    const lista = bodyOf(source, "export async function getStoreShipments(");
    expect(lista).toContain(
      'if (esColaDeReprogramacion(cats)) query = query.or(YA_SALIO_O_NO_ES_ALICLIK).neq("courier", SALIDA_POR_DEFINIR);',
    );
    const contador = bodyOf(source, "async function countByCategory(");
    expect(contador).not.toContain("SALIDA_POR_DEFINIR");
  });
});

describe("las cerradas por recuperar se leen enteras", () => {
  const source = read(ACCESS);
  const fn = bodyOf(source, "async function guiasPorRecuperar(");

  it("pagina en vez de cortar en 1.000", () => {
    // Con `.limit(1000)` sobre 2.640 cerradas, 404 recuperables activas —todas
    // «En gestión Reproprovincia» en el Master— no llegaban a la cola.
    expect(fn).not.toContain(".limit(");
    expect(fn).toContain(".range(from, from + PAGE - 1)");
    expect(fn).toContain("if (rows.length < PAGE) break;");
  });

  it("pagina por id, que no se mueve entre página y página", () => {
    // Los barridos reescriben `updated_at` mientras se lee: paginar por esa
    // columna salta o repite filas.
    expect(fn).toContain('.order("id", { ascending: true })');
    expect(fn).not.toContain('.order("updated_at"');
  });

  it("y rehace el orden de antes en memoria: lo último que se movió, arriba", () => {
    expect(fn).toContain("cerradas.sort((a, b) => (b.updated_at ?? \"\").localeCompare(a.updated_at ?? \"\"));");
  });
});
