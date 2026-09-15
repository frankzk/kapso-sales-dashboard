import { describe, expect, it, vi } from "vitest";

/**
 * LOS CONTEOS DEL FILTRO DE GESTIÓN NO PUEDEN CONTARSE A SÍ MISMOS.
 *
 * El desplegable enseña «2/7 días (139 pedidos)» para poder atacar por tamaño.
 * Si al contar se aplicara también el filtro de gestión que está puesto, elegir
 * un paso dejaría los otros siete en cero y el desplegable se volvería inútil
 * justo después de usarlo: nadie podría comparar «me quedan 137 de 1 día contra
 * 7 de 4 días» estando dentro de uno de los dos.
 *
 * Es la misma regla que los chips de «Fecha pactada», y la razón de escribirla
 * como prueba es que no falla ruidosamente — los números salen, solo que
 * mintiendo.
 */

// `vi.mock` se iza al principio del fichero, así que lo que su fábrica usa
// tiene que izarse con ella o no existe todavía cuando corre.
const { consultas, createServerSupabaseMock } = vi.hoisted(() => {
  const consultas: {
    step: number | null;
    filtroPropio: boolean;
    otrosFiltros: string[];
  }[] = [];
  return { consultas, createServerSupabaseMock: vi.fn() };
});

function queryFalsa() {
  const estado = { step: null as number | null, filtroPropio: false, otrosFiltros: [] as string[] };
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (columna: string, valor: unknown) => {
    if (columna === "confirmation_day_count") estado.step = Number(valor);
    else estado.otrosFiltros.push(`${columna}=${String(valor)}`);
    return q;
  };
  q.in = (columna: string, valores: unknown[]) => {
    // Esto es el filtro propio colándose en el conteo: la mutación que se caza.
    if (columna === "confirmation_day_count") estado.filtroPropio = true;
    else estado.otrosFiltros.push(`${columna} in ${JSON.stringify(valores)}`);
    return q;
  };
  for (const metodo of ["or", "gt", "gte", "lte", "not", "is", "order", "limit"]) {
    q[metodo] = () => q;
  }
  q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
    consultas.push({ ...estado, otrosFiltros: [...estado.otrosFiltros] });
    // Un número distinto por paso, para distinguir que cada conteo va a su sitio.
    return Promise.resolve({ count: (estado.step ?? 0) * 10, error: null }).then(ok, fail);
  };
  return q;
}

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getManagementDayCounts } from "@/lib/orders-master-access";
import { emptyFilters } from "@/lib/order-master-filters";

createServerSupabaseMock.mockImplementation(async () => ({ from: () => queryFalsa() }));

describe("getManagementDayCounts", () => {
  it("cuenta los ocho pasos de la escalera, cada uno en su sitio", async () => {
    consultas.length = 0;
    const counts = await getManagementDayCounts(["s1"], { filters: emptyFilters() });
    expect(consultas.map((c) => c.step).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(counts[3]).toBe(30);
    expect(counts[7]).toBe(70);
  });

  it("NO aplica el filtro de gestión al contar: si no, los otros siete darían cero", async () => {
    consultas.length = 0;
    await getManagementDayCounts(["s1"], {
      filters: { ...emptyFilters(), managementDays: new Set(["2"]) },
    });
    expect(consultas).toHaveLength(8);
    expect(consultas.some((c) => c.filtroPropio)).toBe(false);
  });

  it("los DEMÁS filtros sí se aplican: el conteo es el de lo que se está mirando", async () => {
    consultas.length = 0;
    await getManagementDayCounts(["s1"], {
      filters: { ...emptyFilters(), regions: new Set(["Junín"]), withComments: true },
      substage: "por_confirmar",
    });
    const unaConsulta = consultas[0]!;
    expect(unaConsulta.otrosFiltros).toContain('region in ["Junín"]');
    expect(unaConsulta.otrosFiltros).toContain("macro_stage=por_confirmar");
    expect(unaConsulta.otrosFiltros).toContain("macro_substage=por_confirmar");
  });

  it("sin tiendas no consulta nada y devuelve la escalera en cero", async () => {
    consultas.length = 0;
    const counts = await getManagementDayCounts([], { filters: emptyFilters() });
    expect(consultas).toHaveLength(0);
    expect(counts[0]).toBe(0);
    expect(counts[7]).toBe(0);
  });
});
