import { describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock, createAdminSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
  createAdminSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: createAdminSupabaseMock,
}));

import { getOrderMasterDetail, OrderMasterReadError } from "@/lib/orders-master-access";

/**
 * Una consulta que FALLA y un pedido que NO EXISTE llegan igual desde PostgREST:
 * `data` en null. Mientras el `error` se ignoraba, los dos casos acababan en el
 * mismo "No encontrado." del drawer — y así una migración sin aplicar (la 0128
 * añade `financial_status` y `total_refunded` a este select) se leía como un
 * pedido borrado, sobre una fila que la tabla de atrás seguía enseñando.
 */
function supabaseReturning(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => () => builder;
  Object.assign(builder, {
    select: chain(),
    eq: chain(),
    order: chain(),
    in: chain(),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  });
  return { from: () => builder };
}

describe("Detalle del Master: leer mal no es no existir", () => {
  it("una columna que falta en la base sale como el error de la base, no como 'no encontrado'", async () => {
    createServerSupabaseMock.mockResolvedValue(
      supabaseReturning({
        data: null,
        error: { message: 'column order_master.financial_status does not exist', code: "42703" },
      }),
    );

    const failure = await getOrderMasterDetail("pedido-1").then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(OrderMasterReadError);
    expect((failure as OrderMasterReadError).code).toBe("42703");
    // El código de PostgREST y la columna tienen que viajar hasta la pantalla:
    // son lo único que convierte "algo pasó" en "falta aplicar la migración".
    expect((failure as OrderMasterReadError).message).toContain("financial_status");
    expect((failure as OrderMasterReadError).message).toContain("42703");
  });

  it("sin fila y sin error sí es un pedido que no está", async () => {
    createServerSupabaseMock.mockResolvedValue(supabaseReturning({ data: null, error: null }));
    await expect(getOrderMasterDetail("pedido-fantasma")).resolves.toBeNull();
  });
});
