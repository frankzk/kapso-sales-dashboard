import { describe, expect, it, vi } from "vitest";

/**
 * BUSCAR POR GUÍA TIENE QUE ENCONTRAR EL PEDIDO, SEA CUAL SEA LA GUÍA.
 *
 * `order_master.guide_code` es la guía ACTUAL del pedido, una sola. Un pedido
 * con historia tiene varias —#KP129183 acumula cuatro: la de Aliclik, una
 * interna y dos de Swayp— y la búsqueda del Master solo miraba esa columna, así
 * que las anteriores no devolvían nada. Medido contra producción el 15-09-2026:
 * **538 guías existían en `shipments` y la búsqueda no las encontraba.**
 *
 * Y es justo el momento en que uno busca por guía: con el número del courier
 * delante, llegando de su panel o de un reclamo, para saber de qué pedido se
 * habla. La respuesta «Sin coincidencias» sobre un pedido que sí está es peor
 * que no tener buscador, porque parece un hecho.
 */

const PEDIDO = {
  id: "m1",
  store_id: "s1",
  order_id: "o1",
  order_name: "#KP129183",
  guide_code: "AUR5X160312713879",
  last_movement_at: "2026-09-09T00:00:00Z",
};

/** Cliente mínimo que distingue las tres consultas que hace la búsqueda. */
function supabaseFalso(registro: { consultas: string[] }) {
  const from = (tabla: string) => {
    const estado = { tabla, usoIn: false, orFiltro: "" };
    const q: Record<string, unknown> = {};
    for (const metodo of ["select", "not", "order", "limit"]) q[metodo] = () => q;
    q.or = (filtro: string) => {
      estado.orFiltro = filtro;
      return q;
    };
    q.in = () => {
      estado.usoIn = true;
      return q;
    };
    q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
      let data: unknown[] = [];
      if (estado.tabla === "shipments") {
        registro.consultas.push(`shipments:${estado.orFiltro}`);
        // La guía vieja vive acá, no en `order_master`.
        data = estado.orFiltro.includes("50000118486") ? [{ order_id: "o1" }] : [];
      } else if (estado.usoIn) {
        registro.consultas.push("order_master:por_order_id");
        data = [PEDIDO];
      } else {
        registro.consultas.push("order_master:directa");
        // La guía actual sí la encuentra la consulta de siempre.
        data = estado.orFiltro.includes("AUR5X160312713879") ? [PEDIDO] : [];
      }
      return Promise.resolve({ data, error: null }).then(ok, fail);
    };
    return q;
  };
  return { from };
}

const registro = { consultas: [] as string[] };
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => supabaseFalso(registro),
}));

const { searchOrderMaster } = await import("@/lib/orders-master-access");

describe("searchOrderMaster encuentra el pedido por cualquiera de sus guías", () => {
  it("una guía ANTERIOR, que solo vive en shipments, devuelve su pedido", async () => {
    registro.consultas = [];
    const filas = await searchOrderMaster("50000118486");
    expect(filas).toHaveLength(1);
    expect(filas[0]?.order_name).toBe("#KP129183");
    // Y se buscó donde hay que buscar: también por el número que emite Swayp.
    expect(registro.consultas.some((c) => c.startsWith("shipments:"))).toBe(true);
    expect(registro.consultas.join(" ")).toContain("swayp_guide.ilike");
  });

  it("la guía actual sigue saliendo por el camino de siempre, sin duplicarse", async () => {
    registro.consultas = [];
    const filas = await searchOrderMaster("AUR5X160312713879");
    expect(filas).toHaveLength(1);
    expect(filas[0]?.order_id).toBe("o1");
    // Si ya vino por la consulta directa, no se vuelve a pedir por order_id.
    expect(registro.consultas).not.toContain("order_master:por_order_id");
  });

  it("lo que no existe en ningún lado sigue sin existir", async () => {
    registro.consultas = [];
    expect(await searchOrderMaster("50000130683")).toEqual([]);
  });

  it("una búsqueda demasiado corta no va a la base", async () => {
    registro.consultas = [];
    expect(await searchOrderMaster("5")).toEqual([]);
    expect(registro.consultas).toEqual([]);
  });
});
