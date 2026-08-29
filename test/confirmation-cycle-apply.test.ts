import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyConfirmationCycleToStore } from "@/lib/order-master";

// Cambiar el ciclo de una tienda tiene que MOVER la cola en el acto. Si el
// ajuste solo tocara `stores`, el equipo vería el número nuevo en pantalla y la
// cola seguiría repartida con el viejo hasta que el barrido pasara por cada uno
// de los ~500 pedidos en confirmación — horas de decir una cosa y hacer otra.

interface Update {
  due: string | null;
  ids: string[];
}

/**
 * Un doble del cliente de PostgREST: apunta los `update` que se emiten y con
 * qué pedidos. No consulta nada, porque lo que se comprueba es CÓMO se agrupa.
 */
function fakeAdmin(
  rows: { order_id: string; confirmation_last_contact_at: string }[],
  opts: { selectError?: boolean } = {},
) {
  const updates: Update[] = [];
  const from = () => {
    let payload: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {};
    const chain = () => () => builder;
    Object.assign(builder, {
      select: chain(),
      eq: chain(),
      is: chain(),
      not: chain(),
      update: (values: Record<string, unknown>) => {
        payload = values;
        return builder;
      },
      in: (_col: string, ids: string[]) => {
        updates.push({ due: (payload.confirmation_cycle_due_on as string) ?? null, ids });
        return builder;
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve(
          opts.selectError
            ? { data: null, error: { message: "columna ausente" } }
            : { data: rows, error: null },
        ),
    });
    return builder;
  };
  return { admin: { from } as unknown as SupabaseClient, updates };
}

describe("applyConfirmationCycleToStore", () => {
  const contacto = (id: string, iso: string) => ({
    order_id: id,
    confirmation_last_contact_at: iso,
  });

  it("agrupa por fecha resultante: pocos update, no uno por pedido", async () => {
    const { admin, updates } = fakeAdmin([
      contacto("a", "2026-08-20T15:00:00.000Z"),
      contacto("b", "2026-08-20T22:00:00.000Z"), // mismo día de Lima que «a»
      contacto("c", "2026-08-22T15:00:00.000Z"),
    ]);
    const touched = await applyConfirmationCycleToStore(admin, "store-1", 3);

    expect(touched).toBe(3);
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ due: "2026-08-23", ids: ["a", "b"] });
    expect(updates).toContainEqual({ due: "2026-08-25", ids: ["c"] });
  });

  it("usa el día de Lima, no el de UTC", async () => {
    // 01:00 UTC del 21 es todavía el 20 en Lima: el ciclo arranca del 20.
    const { admin, updates } = fakeAdmin([contacto("a", "2026-08-21T01:00:00.000Z")]);
    await applyConfirmationCycleToStore(admin, "store-1", 3);
    expect(updates).toEqual([{ due: "2026-08-23", ids: ["a"] }]);
  });

  it("respeta el ciclo pedido, no el de por defecto", async () => {
    const { admin, updates } = fakeAdmin([contacto("a", "2026-08-20T15:00:00.000Z")]);
    await applyConfirmationCycleToStore(admin, "store-1", 7);
    expect(updates).toEqual([{ due: "2026-08-27", ids: ["a"] }]);
  });

  it("sin pedidos que reprogramar no escribe nada", async () => {
    const { admin, updates } = fakeAdmin([]);
    expect(await applyConfirmationCycleToStore(admin, "store-1", 3)).toBe(0);
    expect(updates).toEqual([]);
  });

  it("si la lectura falla no escribe a ciegas", async () => {
    // Pre-0133 la columna no existe. Escribir igual dejaría fechas inventadas.
    const { admin, updates } = fakeAdmin([contacto("a", "2026-08-20T15:00:00.000Z")], {
      selectError: true,
    });
    expect(await applyConfirmationCycleToStore(admin, "store-1", 3)).toBe(0);
    expect(updates).toEqual([]);
  });
});
