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

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
  builder: ReturnType<typeof recordingBuilder>;
}

function runPage(params: {
  view: "por_confirmar";
  search: string;
  substage?: null;
  filters?: Partial<MasterFilters>;
  /** Simula que la migración 0204 todavía no se aplicó. */
  rpcFails?: boolean;
}) {
  const rec = recordingBuilder();
  const rpcs: RpcCall[] = [];
  createServerSupabaseMock.mockResolvedValue({
    from: () => rec.builder,
    rpc: (fn: string, args: Record<string, unknown>) => {
      const builder = recordingBuilder();
      if (params.rpcFails) {
        builder.builder.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, count: null, error: { code: "PGRST202", message: "no existe" } });
      }
      rpcs.push({ fn, args, builder });
      return builder.builder;
    },
  });
  const filters = { ...emptyFilters(), ...(params.filters ?? {}), search: params.search };
  return getOrderMasterPage(["store-a", "store-b"], {
    view: params.view,
    substage: params.substage ?? null,
    filters,
    sortKey: "created",
    page: 1,
  }).then(() => ({ ...rec, rpcs }));
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
    const { eq, rpcs } = await runPage({ view: "por_confirmar", search: "KP125285" });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]!.fn).toBe("order_master_search");
    expect(rpcs[0]!.args.p_term).toBe("KP125285");
    expect(eq.map(([col]) => col)).not.toContain("macro_stage");
    expect(rpcs[0]!.builder.eq.map(([col]) => col)).not.toContain("macro_stage");
  });

  it("el '#' que se pega desde el chat no reactiva el acotado", async () => {
    // `#KP125285` es como llega el código en un WhatsApp. Si la normalización
    // del término y la de "¿hay búsqueda?" se separaran, este caso volvería a
    // filtrar por etapa y el pedido volvería a no aparecer.
    const { eq, rpcs } = await runPage({ view: "por_confirmar", search: "#KP125285" });
    expect(eq.map(([col]) => col)).not.toContain("macro_stage");
    expect(rpcs[0]!.args.p_term).toBe("KP125285");
  });

  it("buscando, tampoco acota por subetapa", async () => {
    const { rpcs } = await runPage({ view: "por_confirmar", search: "KP125285" });
    expect(rpcs[0]!.builder.eq.map(([col]) => col)).not.toContain("macro_substage");
  });

  // La pantalla oculta la barra de filtros entera mientras hay búsqueda. Un
  // filtro que sigue actuando sin verse ni poder quitarse esconde resultados
  // igual que lo hacía la pestaña, y sin ninguna pista de por qué.
  it("buscando, ignora los filtros que quedaran puestos y no se ven", async () => {
    const { rpcs } = await runPage({
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
    const { inCalls, ranges, or } = rpcs[0]!.builder;
    expect(inCalls).toEqual([]);
    expect(ranges).toEqual([]);
    expect(or).toEqual([]);
  });

  it("sin búsqueda, esos mismos filtros sí se aplican", async () => {
    const { inCalls, rpcs } = await runPage({
      view: "por_confirmar",
      search: "",
      filters: { regions: new Set(["Junín"]) },
    });
    expect(rpcs).toHaveLength(0);
    expect(inCalls).toContainEqual(["region", ["Junín"]]);
  });

  it("buscando, el límite de tiendas accesibles NO se relaja: no es un filtro", async () => {
    // Es la frontera de permisos, no una preferencia de pantalla. Soltarla al
    // buscar enseñaría pedidos de tiendas que esta persona no puede ver. La
    // función además la cruza con `auth_store_ids()` (0204).
    const { rpcs } = await runPage({ view: "por_confirmar", search: "KP125285" });
    expect(rpcs[0]!.args.p_store_ids).toEqual(["store-a", "store-b"]);
  });

  it("si la función de búsqueda no existe todavía, busca por el camino de siempre", async () => {
    // El código puede salir antes que la migración (DEPLOY.md). Una búsqueda que
    // devolviera vacío en ese rato se leería como «ese pedido no existe».
    const { or, inCalls, eq } = await runPage({ view: "por_confirmar", search: "KP125285", rpcFails: true });
    expect(or.join(" ")).toContain("KP125285");
    expect(inCalls).toContainEqual(["store_id", ["store-a", "store-b"]]);
    expect(eq.map(([col]) => col)).not.toContain("macro_stage");
  });

  it("uno o dos caracteres no son una búsqueda: la pestaña sigue mandando", async () => {
    // Con menos de tres no hay trigrama que buscar y la base devolvería media
    // tabla. La pantalla no los manda; si llegan por la URL, se ignoran.
    const { eq, rpcs } = await runPage({ view: "por_confirmar", search: "KP" });
    expect(rpcs).toHaveLength(0);
    expect(eq).toContainEqual(["macro_stage", "por_confirmar"]);
  });
});
