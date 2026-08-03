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
import { emptyFilters } from "@/lib/order-master-filters";

/**
 * Un doble del constructor de PostgREST que sólo apunta lo que se le pide. No
 * consulta nada: lo que se está comprobando es QUÉ restricciones se aplican,
 * que es justo donde estaba el fallo.
 */
function recordingBuilder() {
  const eq: [string, unknown][] = [];
  const or: string[] = [];
  const builder: Record<string, unknown> = {};
  const chain = (fn?: (...args: never[]) => void) =>
    (...args: unknown[]) => {
      fn?.(...(args as never[]));
      return builder;
    };

  Object.assign(builder, {
    select: chain(),
    in: chain(),
    eq: chain(((col: string, val: unknown) => eq.push([col, val])) as never),
    or: chain(((expr: string) => or.push(expr)) as never),
    not: chain(),
    gt: chain(),
    gte: chain(),
    lte: chain(),
    order: chain(),
    range: chain(),
    // El builder de PostgREST es "thenable": se resuelve al await.
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], count: 0, error: null }),
  });

  return { builder, eq, or };
}

function runPage(params: { view: "por_confirmar"; search: string; substage?: null }) {
  const { builder, eq, or } = recordingBuilder();
  createServerSupabaseMock.mockResolvedValue({ from: () => builder });
  const filters = { ...emptyFilters(), search: params.search };
  return getOrderMasterPage(["store-a"], {
    view: params.view,
    substage: params.substage ?? null,
    filters,
    sortKey: "created",
    page: 1,
  }).then(() => ({ eq, or }));
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
});
