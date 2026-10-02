import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getLeadsForDashboard, recencyCursorFilter } from "@/lib/access";

// Los leads del dashboard se paginan por cursor y por tienda (02-10-2026). El
// PostgREST de mentira de abajo aplica los mismos filtros que el de verdad
// (eq, gte, lte, el `or` del cursor, el orden y el límite de 1.000), así que
// lo que se prueba es el drenado completo: que cada lead salga una vez y en el
// orden de la base. Contra PostgREST 14.5 y Postgres reales se comprobó lo mismo
// antes de publicar (ver el PR).

interface Row {
  id: string;
  store_id: string;
  last_interaction_at: string;
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const PAGE = 1000;

/** Microsegundos desde epoch, como compara la base. */
function micros(iso: string): number {
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? "";
  return Date.parse(iso) * 1000 + Number(`${fraction}000000`.slice(3, 6));
}

/** El orden de la base: instante DESC, id DESC. */
function dbOrder(a: Row, b: Row): number {
  return micros(b.last_interaction_at) - micros(a.last_interaction_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Un instante como lo devuelve PostgREST: microsegundos y `+00:00`. */
function pgInstant(ms: number, extraMicros = 0): string {
  const base = new Date(ms).toISOString().slice(0, 23);
  return `${base}${String(extraMicros).padStart(3, "0")}+00:00`;
}

let seq = 0;
/** Uuids válidos, únicos y desordenados respecto al instante (como los reales). */
function uuid(): string {
  seq += 1;
  const scrambled = (Math.imul(seq, 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `${scrambled}-${((seq >>> 16) & 0xffff).toString(16).padStart(4, "0")}-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

function lead(store: string, at: string): Row {
  return { id: uuid(), store_id: store, last_interaction_at: at };
}

const CURSOR_RE =
  /^last_interaction_at\.lt\."([^"]+)",and\(last_interaction_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/;

/**
 * PostgREST de mentira. Sin `in` ni `range`: si el código volviera a pedir por
 * `store_id = ANY` o con OFFSET, la llamada no existe y la prueba revienta.
 */
function servePostgrest(table: Row[], opts: { brokenSelects?: string[] } = {}) {
  const sorted = [...table].sort(dbOrder);
  const at = new Map(sorted.map((r) => [r, micros(r.last_interaction_at)]));
  const queries: { select: string; eq: Record<string, string>; lte: string; or: string | null }[] = [];
  createServerSupabaseMock.mockResolvedValue({
    from: (name: string) => {
      expect(name).toBe("leads");
      const state = { select: "", eq: {} as Record<string, string>, gte: "", lte: "", or: null as string | null };
      const order: string[] = [];
      const q = {
        select: (s: string) => ((state.select = s), q),
        eq: (col: string, v: string) => ((state.eq[col] = v), q),
        gte: (col: string, v: string) => (expect(col).toBe("last_interaction_at"), (state.gte = v), q),
        lte: (col: string, v: string) => (expect(col).toBe("last_interaction_at"), (state.lte = v), q),
        or: (f: string) => ((state.or = f), q),
        order: (col: string, o: { ascending: boolean }) => (order.push(`${col}.${o.ascending ? "asc" : "desc"}`), q),
        limit: async (n: number) => {
          queries.push({ select: state.select, eq: { ...state.eq }, lte: state.lte, or: state.or });
          expect(order).toEqual(["last_interaction_at.desc", "id.desc"]);
          if (opts.brokenSelects?.includes(state.select)) {
            return { data: null, error: { message: 'column leads.wa_phone_number_id does not exist' } };
          }
          const cursor = state.or ? CURSOR_RE.exec(state.or) : null;
          if (state.or && !cursor) throw new Error(`filtro or inesperado: ${state.or}`);
          const [from, to] = [micros(state.gte), micros(state.lte)];
          const c = cursor ? micros(cursor[1]!) : null;
          const rows = sorted.filter((r) => {
            if (state.eq.store_id && r.store_id !== state.eq.store_id) return false;
            const m = at.get(r)!;
            if (m < from || m > to) return false;
            return c == null || m < c || (m === c && r.id < cursor![3]!);
          });
          return { data: rows.slice(0, Math.min(n, PAGE)).map((r) => ({ ...r })), error: null };
        },
      };
      return q;
    },
  });
  return { queries, expected: (stores: string[]) => sorted.filter((r) => stores.includes(r.store_id)) };
}

const SEPT_1 = Date.parse("2026-09-01T00:00:00Z");
const DAY = 86_400_000;

function storeLeads(store: string, n: number, offsetMs: number): Row[] {
  return Array.from({ length: n }, (_, i) => lead(store, pgInstant(SEPT_1 + offsetMs + ((i * 7919 * 60_000) % (29 * DAY)))));
}

beforeEach(() => {
  createServerSupabaseMock.mockReset();
  seq = 0;
});

describe("getLeadsForDashboard: cursor por tienda en vez de OFFSET", () => {
  it("lee cada lead una vez y en el orden de la base, aunque 1.200 compartan instante en el borde de página", async () => {
    const tie = pgInstant(Date.parse("2026-09-20T12:00:00.123Z"), 456);
    const table = [
      ...Array.from({ length: 1200 }, () => lead(A, tie)),
      // Distintos solo en microsegundos dentro del mismo milisegundo.
      ...Array.from({ length: 300 }, (_, i) => lead(A, pgInstant(Date.parse("2026-09-25T08:00:00.500Z"), i))),
      ...storeLeads(A, 1100, 0),
      // Fuera del rango: no entran.
      lead(A, pgInstant(Date.parse("2026-08-15T00:00:00Z"))),
      lead(A, pgInstant(Date.parse("2026-10-01T00:00:00Z"))),
    ];
    const { queries, expected } = servePostgrest(table);

    const rows = await getLeadsForDashboard([A], RANGE);

    const want = expected([A]).filter((r) => r.last_interaction_at.startsWith("2026-09"));
    expect(want).toHaveLength(2600);
    expect(rows.map((r) => r.id)).toEqual(want.map((r) => r.id));
    expect(queries).toHaveLength(3);
    expect(queries.every((q) => q.eq.store_id === A)).toBe(true);
    expect(queries[0]!.or).toBeNull();
    expect(queries[0]!.lte).toBe("2026-09-30T23:59:59Z");
    // Cada página arranca donde terminó la anterior: el cursor es su última fila.
    expect(queries[1]!.lte).toBe(rows[PAGE - 1]!.last_interaction_at);
    expect(queries[1]!.or).toBe(
      recencyCursorFilter("last_interaction_at", { at: rows[PAGE - 1]!.last_interaction_at!, id: rows[PAGE - 1]!.id }),
    );
  });

  it("con varias tiendas hace una consulta por tienda y las intercala en el orden de la base", async () => {
    // Pares de tiendas distintas en el MISMO milisegundo: solo los microsegundos
    // dicen cuál fue antes, como en la base.
    const sameMs = Date.parse("2026-09-10T10:00:00.250Z");
    const pairs = Array.from({ length: 40 }, (_, i) => [
      lead(A, pgInstant(sameMs + i, 100 + (i % 2) * 800)),
      lead(B, pgInstant(sameMs + i, 500)),
    ]).flat();
    const { queries, expected } = servePostgrest([...storeLeads(A, 1500, 0), ...storeLeads(B, 700, 3_600_000), ...pairs]);

    const rows = await getLeadsForDashboard([A, B, A], RANGE);

    expect(rows.map((r) => r.id)).toEqual(expected([A, B]).map((r) => r.id));
    expect(queries.filter((q) => q.eq.store_id === A)).toHaveLength(2);
    expect(queries.filter((q) => q.eq.store_id === B)).toHaveLength(1);
  });

  it("el tope de 50.000 se queda con los más recientes de TODAS las tiendas", async () => {
    // A tiene los 30.000 más recientes; B, 30.000 más viejos que todos los de A.
    const recent = SEPT_1 + 15 * DAY;
    const table = [
      ...Array.from({ length: 30_000 }, (_, i) => lead(A, pgInstant(recent + i * 1000))),
      ...Array.from({ length: 30_000 }, (_, i) => lead(B, pgInstant(SEPT_1 + i * 1000))),
    ];
    const { expected } = servePostgrest(table);

    const rows = await getLeadsForDashboard([B, A], RANGE);

    expect(rows).toHaveLength(50_000);
    expect(rows.map((r) => r.id)).toEqual(expected([A, B]).slice(0, 50_000).map((r) => r.id));
  });

  it("si falta una columna opcional, baja de juego de columnas y sigue con él en las páginas siguientes", async () => {
    const table = storeLeads(A, 1500, 0);
    const full = "wa_phone_number_id";
    const { queries } = servePostgrest(table, { brokenSelects: [] });
    // Primero averiguamos qué select manda con todas las columnas y lo rompemos.
    await getLeadsForDashboard([A], RANGE);
    const richest = queries[0]!.select;
    expect(richest.endsWith(full)).toBe(true);

    const second = servePostgrest(table, { brokenSelects: [richest] });
    const rows = await getLeadsForDashboard([A], RANGE);

    expect(rows).toHaveLength(1500);
    expect(second.queries.map((q) => q.select.endsWith(full))).toEqual([true, false, false]);
  });
});

describe("recencyCursorFilter", () => {
  const id = "3ee8242c-b77b-48f3-bd71-d63c90a2d512";

  it("arma el desempate: instante anterior, o el mismo con id menor", () => {
    expect(recencyCursorFilter("last_interaction_at", { at: "2026-09-15T14:55:32.690554+00:00", id })).toBe(
      `last_interaction_at.lt."2026-09-15T14:55:32.690554+00:00",and(last_interaction_at.eq."2026-09-15T14:55:32.690554+00:00",id.lt.${id})`,
    );
    expect(recencyCursorFilter("last_interaction_at", { at: "2026-09-30T23:59:59Z", id })).not.toBeNull();
  });

  it("no interpola nada que no tenga forma de instante o de uuid", () => {
    for (const at of ['2026-09-15T14:55:32+00:00",id.gt.0', "2026-09-15 14:55:32+00", "ayer", ""]) {
      expect(recencyCursorFilter("last_interaction_at", { at, id })).toBeNull();
    }
    for (const bad of ["1,2", "3ee8242c-b77b-48f3-bd71-d63c90a2d512)", "lead-1"]) {
      expect(recencyCursorFilter("last_interaction_at", { at: "2026-09-30T23:59:59Z", id: bad })).toBeNull();
    }
  });
});
