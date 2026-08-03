import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock, createAdminSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
  createAdminSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: createAdminSupabaseMock,
}));

import { getOrderMasterPage } from "@/lib/orders-master-access";
import { emptyFilters, type MasterFilters } from "@/lib/order-master-filters";

/**
 * Un doble del constructor de PostgREST que sólo apunta lo que se le pide. No
 * consulta nada: lo que se está comprobando es QUÉ restricciones se aplican,
 * que es justo donde estaba el fallo.
 */
function recordingBuilder() {
  const eq: [string, unknown][] = [];
  const inCalls: [string, unknown][] = [];
  const or: string[] = [];
  const ranges: [string, unknown][] = [];
  const builder: Record<string, unknown> = {};
  const chain = (fn?: (...args: never[]) => void) =>
    (...args: unknown[]) => {
      fn?.(...(args as never[]));
      return builder;
    };

  Object.assign(builder, {
    select: chain(),
    in: chain(((col: string, val: unknown) => inCalls.push([col, val])) as never),
    eq: chain(((col: string, val: unknown) => eq.push([col, val])) as never),
    or: chain(((expr: string) => or.push(expr)) as never),
    not: chain(),
    gt: chain(((col: string, val: unknown) => ranges.push([col, val])) as never),
    gte: chain(((col: string, val: unknown) => ranges.push([col, val])) as never),
    lte: chain(((col: string, val: unknown) => ranges.push([col, val])) as never),
    order: chain(),
    range: chain(),
    // El builder de PostgREST es "thenable": se resuelve al await.
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], count: 0, error: null }),
  });

  return { builder, eq, inCalls, or, ranges };
}

function runPage(params: {
  view: "por_confirmar";
  search: string;
  substage?: null;
  filters?: Partial<MasterFilters>;
}) {
  const rec = recordingBuilder();
  createServerSupabaseMock.mockResolvedValue({ from: () => rec.builder });
  const filters = { ...emptyFilters(), ...(params.filters ?? {}), search: params.search };
  return getOrderMasterPage(["store-a", "store-b"], {
    view: params.view,
    substage: params.substage ?? null,
    filters,
    sortKey: "created",
    page: 1,
  }).then(() => rec);
}

describe("Master de Pedidos: alcance de la búsqueda", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
  });

  it("sin búsqueda, la pestaña acota por etapa", async () => {
    const { eq } = await runPage({ view: "por_confirmar", search: "" });
    expect(eq).toContainEqual(["macro_stage", "por_confirmar"]);
  });

  it("buscando, NO acota por etapa: el pedido puede estar en cualquiera", async () => {
    const { eq, or } = await runPage({ view: "por_confirmar", search: "KP125285" });
    expect(eq.map(([col]) => col)).not.toContain("macro_stage");
    expect(or.join(" ")).toContain("KP125285");
  });

  it("el '#' que se pega desde el chat no reactiva el acotado", async () => {
    // `#KP125285` es como llega el código en un WhatsApp. Si la normalización
    // del término y la de "¿hay búsqueda?" se separaran, este caso volvería a
    // filtrar por etapa y el pedido volvería a no aparecer.
    const { eq, or } = await runPage({ view: "por_confirmar", search: "#KP125285" });
    expect(eq.map(([col]) => col)).not.toContain("macro_stage");
    expect(or.join(" ")).toContain("KP125285");
  });

  it("buscando, tampoco acota por subetapa", async () => {
    const { eq } = await runPage({ view: "por_confirmar", search: "KP125285" });
    expect(eq.map(([col]) => col)).not.toContain("macro_substage");
  });

  // La pantalla oculta la barra de filtros entera mientras hay búsqueda. Un
  // filtro que sigue actuando sin verse ni poder quitarse esconde resultados
  // igual que lo hacía la pestaña, y sin ninguna pista de por qué.
  it("buscando, ignora los filtros que quedaran puestos y no se ven", async () => {
    const { inCalls, ranges } = await runPage({
      view: "por_confirmar",
      search: "KP125285",
      filters: {
        regions: new Set(["Junín"]),
        districts: new Set(["El Tambo"]),
        generalStatuses: new Set(["en_proceso"]),
        couriers: new Set(["aliclik"]),
        createdFrom: "2026-01-01",
        createdTo: "2026-01-31",
      },
    });
    const cols = inCalls.map(([col]) => col);
    expect(cols).not.toContain("region");
    expect(cols).not.toContain("district");
    expect(cols).not.toContain("general_status");
    expect(ranges.map(([col]) => col)).not.toContain("order_created_at");
  });

  it("sin búsqueda, esos mismos filtros sí se aplican", async () => {
    const { inCalls } = await runPage({
      view: "por_confirmar",
      search: "",
      filters: { regions: new Set(["Junín"]) },
    });
    expect(inCalls).toContainEqual(["region", ["Junín"]]);
  });

  it("buscando, el límite de tiendas accesibles NO se relaja: no es un filtro", async () => {
    // Es la frontera de permisos, no una preferencia de pantalla. Soltarla al
    // buscar enseñaría pedidos de tiendas que esta persona no puede ver.
    const { inCalls } = await runPage({ view: "por_confirmar", search: "KP125285" });
    expect(inCalls).toContainEqual(["store_id", ["store-a", "store-b"]]);
  });
});
