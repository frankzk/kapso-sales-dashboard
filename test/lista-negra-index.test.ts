// La Lista negra en memoria (11-11-2026): Leads se refresca sola en la pantalla
// de cada asesora y preguntaba por TODA la cola en cada refresco (~22 000
// lecturas por hora). Ahora cada instancia lee la lista entera de la
// organización como mucho cada dos minutos y contesta en memoria.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));

import { listaNegraMarksAmong } from "@/lib/lista-negra-server";
import { forgetListaNegraIndex, LISTA_NEGRA_INDEX_TTL_MS } from "@/lib/lista-negra-cache";
import { pagoOnlineListedKey } from "@/lib/pago-online";

type Row = Record<string, unknown>;

/** Un cliente de Supabase de mentira: cuenta las lecturas por tabla. */
function fakeAdmin(tables: Record<string, Row[]>) {
  const reads: Record<string, number> = {};
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let range: [number, number] | null = null;
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), q),
      is: (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), q),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), q),
      order: () => q,
      range: (a: number, b: number) => ((range = [a, b]), q),
      maybeSingle: async () => {
        reads[table] = (reads[table] ?? 0) + 1;
        return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        reads[table] = (reads[table] ?? 0) + 1;
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        resolve({ data: rows, error: null });
      },
    };
    return q;
  };
  return { admin: { from } as never, reads };
}

const ORG = "org-1";
const tables = (): Record<string, Row[]> => ({
  pago_online_settings: [{ org_id: ORG, mode: "activo", current_run_id: "run-2", requirement: "adelanto" }],
  pago_online_phones: [
    { run_id: "run-2", phone: "987654321", reason: "devuelto", failed: 1, orders: 1 },
    { run_id: "run-2", phone: "911111111", reason: "anulador", failed: 5, orders: 6 },
    { run_id: "run-1", phone: "922222222", reason: "devuelto", failed: 1, orders: 1 },
  ],
  pago_online_exceptions: [{ org_id: ORG, phone: "911111111", removed_at: null }],
  prepay_list_entries: [{ org_id: ORG, phone: "51933333333", reason: "Mandó a otro a recoger", requirement: "pago_completo", removed_at: null }],
});

describe("Lista negra en memoria", () => {
  beforeEach(() => forgetListaNegraIndex());

  it("marca lo mismo que antes: automática vigente sin excepciones, más las altas a mano", async () => {
    const { admin } = fakeAdmin(tables());
    const marks = await listaNegraMarksAmong(admin, [ORG], ["+51 987 654 321", "911111111", "922222222", "933333333", "900000000", null]);
    expect([...marks.keys()].sort()).toEqual(
      [pagoOnlineListedKey(ORG, "933333333"), pagoOnlineListedKey(ORG, "987654321")].sort(),
    );
  });

  it("lee la base una vez por organización y contesta de memoria mientras dura el índice", async () => {
    const { admin, reads } = fakeAdmin(tables());
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    await listaNegraMarksAmong(admin, [ORG], ["987654321"]);
    await listaNegraMarksAmong(admin, [ORG], Array.from({ length: 900 }, (_, i) => String(900000000 + i)));
    expect(reads.pago_online_phones).toBe(1);
    expect(reads.prepay_list_entries).toBe(1);
    expect(reads.pago_online_exceptions).toBe(1);
    // Pasados los dos minutos, se vuelve a leer.
    now.mockReturnValue(1_000_000 + LISTA_NEGRA_INDEX_TTL_MS + 1);
    await listaNegraMarksAmong(admin, [ORG], ["987654321"]);
    expect(reads.pago_online_phones).toBe(2);
    // Un alta o una baja lo olvida al instante.
    forgetListaNegraIndex(ORG);
    await listaNegraMarksAmong(admin, [ORG], ["987654321"]);
    expect(reads.pago_online_phones).toBe(3);
    now.mockRestore();
  });

  it("sin la automática en Activo, solo las altas a mano", async () => {
    const t = tables();
    t.pago_online_settings = [{ org_id: ORG, mode: "simulacion", current_run_id: "run-2" }];
    const { admin, reads } = fakeAdmin(t);
    const marks = await listaNegraMarksAmong(admin, [ORG], ["987654321", "933333333"]);
    expect([...marks.keys()]).toEqual([pagoOnlineListedKey(ORG, "933333333")]);
    expect(reads.pago_online_phones ?? 0).toBe(0);
  });
});
