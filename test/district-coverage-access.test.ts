import { describe, expect, it } from "vitest";
import { saveDistrictCoverageRow } from "@/lib/district-coverage-access";

// El fallo que motiva estas pruebas no era de lógica: era que NADIE ejercitaba
// la escritura. La tabla existía, la pantalla estaba, el `upsert` usaba
// `onConflict: "store_id,district"` y la unicidad la da un índice por expresión
// —`coalesce(store_id, …)`—, así que Postgres respondía «there is no unique or
// exclusion constraint matching the ON CONFLICT specification» en TODAS las
// guardadas. Se descubrió en producción semanas después.
//
// El stub imita lo justo de PostgREST: encadenar filtros y devolver las filas
// que casan, registrando lo que se escribe.
interface StubOpts {
  rows?: { id: string; store_id: string | null; district: string }[];
  insertError?: { message: string; code?: string };
  /** Filas que aparecen SOLO al reintentar, para simular la carrera. */
  rowsAfterConflict?: { id: string; store_id: string | null; district: string }[];
}

function stubAdmin(opts: StubOpts = {}) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const inserts: Record<string, unknown>[] = [];
  let selects = 0;

  const admin = {
    from() {
      const filters: { column: string; value: unknown }[] = [];
      const builder: {
        select: () => typeof builder;
        eq: (column: string, value: unknown) => typeof builder;
        is: (column: string, value: unknown) => typeof builder;
        update: (patch: Record<string, unknown>) => { eq: (c: string, id: string) => Promise<unknown> };
        insert: (payload: Record<string, unknown>) => Promise<unknown>;
        then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
      } = {
        select() {
          selects++;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (_c: string, id: string) => {
              updates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          inserts.push(payload);
          return Promise.resolve({ error: opts.insertError ?? null });
        },
        // El builder de PostgREST es "thenable": se resuelve al esperarlo.
        then(resolve: (value: unknown) => unknown) {
          const pool =
            selects > 1 && opts.rowsAfterConflict ? opts.rowsAfterConflict : opts.rows ?? [];
          const data = pool.filter((row) =>
            filters.every((f) => (row as Record<string, unknown>)[f.column] === f.value),
          );
          return Promise.resolve(resolve({ data, error: null }));
        },
      };
      return builder;
    },
  };
  return { admin: admin as never, updates, inserts };
}

const input = {
  storeId: null,
  district: "pisac",
  coverage: "provincia_cod" as const,
  note: "Aliclik cotizó S/ 12.00.",
  updatedBy: "user-1",
};

describe("saveDistrictCoverageRow", () => {
  it("inserta cuando el distrito no tenía excepción", async () => {
    const stub = stubAdmin({ rows: [] });
    const result = await saveDistrictCoverageRow(stub.admin, input);
    expect(result.error).toBeUndefined();
    expect(stub.updates).toHaveLength(0);
    expect(stub.inserts[0]).toMatchObject({
      store_id: null,
      district: "pisac",
      coverage: "provincia_cod",
      updated_by: "user-1",
    });
  });

  it("actualiza la que ya existe en vez de duplicarla", async () => {
    const stub = stubAdmin({ rows: [{ id: "row-1", store_id: null, district: "pisac" }] });
    const result = await saveDistrictCoverageRow(stub.admin, input);
    expect(result.error).toBeUndefined();
    expect(stub.inserts).toHaveLength(0);
    expect(stub.updates[0]).toMatchObject({ id: "row-1" });
    expect(stub.updates[0]!.patch).toMatchObject({ coverage: "provincia_cod" });
  });

  it("no confunde la regla global con la de una tienda", async () => {
    // `store_id` nulo no se compara con `eq` —en SQL nada es igual a NULL—, así
    // que buscar la global tiene que usar `is`. Si se cruzaran, guardar la
    // excepción de una tienda pisaría la de todas.
    const stub = stubAdmin({ rows: [{ id: "global", store_id: null, district: "pisac" }] });
    const result = await saveDistrictCoverageRow(stub.admin, { ...input, storeId: "store-1" });
    expect(result.error).toBeUndefined();
    expect(stub.updates).toHaveLength(0);
    expect(stub.inserts[0]).toMatchObject({ store_id: "store-1" });
  });

  it("una carrera contra el índice se reintenta como actualización", async () => {
    // Dos administradores guardando el mismo distrito a la vez: el segundo
    // INSERT choca contra el índice único. Lo que escribió no debe perderse.
    const stub = stubAdmin({
      rows: [],
      insertError: { message: "duplicate key", code: "23505" },
      rowsAfterConflict: [{ id: "row-ganadora", store_id: null, district: "pisac" }],
    });
    const result = await saveDistrictCoverageRow(stub.admin, input);
    expect(result.error).toBeUndefined();
    expect(stub.updates[0]).toMatchObject({ id: "row-ganadora" });
  });

  it("devuelve el error de la base cuando no es una carrera", async () => {
    const stub = stubAdmin({ rows: [], insertError: { message: "permission denied" } });
    const result = await saveDistrictCoverageRow(stub.admin, input);
    expect(result.error).toBe("permission denied");
  });
});
