import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getConversations, recencyCursorFilter } from "@/lib/access";

// Las conversaciones del dashboard se drenan como los leads (02-10-2026): una
// consulta por tienda y cada página desde la última fila de la anterior, en el
// orden `started_at DESC, id DESC`. El PostgREST de mentira aplica los mismos
// filtros que el de verdad (eq, gte, lte, el `or` del cursor, el orden y el tope
// de 1.000) y no tiene `in` ni `range`: si el código volviera a pedir con
// `store_id = ANY` u OFFSET, la llamada no existe y la prueba revienta.

interface Row {
  id: string;
  store_id: string;
  kapso_conversation_id: string;
  started_at: string;
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const PAGE = 1000;

function micros(iso: string): number {
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? "";
  return Date.parse(iso) * 1000 + Number(`${fraction}000000`.slice(3, 6));
}

function dbOrder(a: Row, b: Row): number {
  return micros(b.started_at) - micros(a.started_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function pgInstant(ms: number, extraMicros = 0): string {
  return `${new Date(ms).toISOString().slice(0, 23)}${String(extraMicros).padStart(3, "0")}+00:00`;
}

let seq = 0;
function uuid(): string {
  seq += 1;
  const scrambled = (Math.imul(seq, 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `${scrambled}-${((seq >>> 16) & 0xffff).toString(16).padStart(4, "0")}-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

function conversation(store: string, at: string): Row {
  return { id: uuid(), store_id: store, kapso_conversation_id: uuid(), started_at: at };
}

const CURSOR_RE = /^started_at\.lt\."([^"]+)",and\(started_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/;

function servePostgrest(table: Row[]) {
  const sorted = [...table].sort(dbOrder);
  const at = new Map(sorted.map((r) => [r, micros(r.started_at)]));
  const queries: { select: string; eq: Record<string, string>; lte: string; or: string | null }[] = [];
  createServerSupabaseMock.mockResolvedValue({
    from: (name: string) => {
      expect(name).toBe("conversations");
      const state = { select: "", eq: {} as Record<string, string>, gte: "", lte: "", or: null as string | null };
      const order: string[] = [];
      const q = {
        select: (s: string) => ((state.select = s), q),
        eq: (col: string, v: string) => ((state.eq[col] = v), q),
        gte: (col: string, v: string) => (expect(col).toBe("started_at"), (state.gte = v), q),
        lte: (col: string, v: string) => (expect(col).toBe("started_at"), (state.lte = v), q),
        or: (f: string) => ((state.or = f), q),
        order: (col: string, o: { ascending: boolean }) => (order.push(`${col}.${o.ascending ? "asc" : "desc"}`), q),
        limit: async (n: number) => {
          queries.push({ select: state.select, eq: { ...state.eq }, lte: state.lte, or: state.or });
          expect(order).toEqual(["started_at.desc", "id.desc"]);
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

function storeConversations(store: string, n: number, offsetMs: number): Row[] {
  return Array.from({ length: n }, (_, i) =>
    conversation(store, pgInstant(SEPT_1 + offsetMs + ((i * 7919 * 60_000) % (29 * DAY)))),
  );
}

beforeEach(() => {
  createServerSupabaseMock.mockReset();
  seq = 0;
});

describe("getConversations: cursor por tienda en vez de OFFSET", () => {
  it("lee cada conversación una vez y en el orden de la base, aunque 1.200 empiecen en el mismo instante", async () => {
    const tie = pgInstant(Date.parse("2026-09-20T12:00:00.123Z"), 456);
    const table = [
      ...Array.from({ length: 1200 }, () => conversation(A, tie)),
      ...Array.from({ length: 300 }, (_, i) => conversation(A, pgInstant(Date.parse("2026-09-25T08:00:00.500Z"), i))),
      ...storeConversations(A, 1100, 0),
      conversation(A, pgInstant(Date.parse("2026-08-15T00:00:00Z"))),
      conversation(A, pgInstant(Date.parse("2026-10-01T00:00:00Z"))),
    ];
    const { queries, expected } = servePostgrest(table);

    const rows = await getConversations([A], RANGE);

    const want = expected([A]).filter((r) => r.started_at.startsWith("2026-09"));
    expect(want).toHaveLength(2600);
    expect(rows.map((r) => r.kapso_conversation_id)).toEqual(want.map((r) => r.kapso_conversation_id));
    expect(queries).toHaveLength(3);
    expect(queries.every((q) => q.eq.store_id === A && q.select.split(",").includes("id"))).toBe(true);
    expect(queries[0]!.or).toBeNull();
    expect(queries[0]!.lte).toBe("2026-09-30T23:59:59Z");
    const last = want[PAGE - 1]!;
    expect(queries[1]!.lte).toBe(last.started_at);
    expect(queries[1]!.or).toBe(recencyCursorFilter("started_at", { at: last.started_at, id: last.id }));
  });

  it("con varias tiendas hace una consulta por tienda y las intercala en el orden de la base", async () => {
    const sameMs = Date.parse("2026-09-10T10:00:00.250Z");
    const pairs = Array.from({ length: 40 }, (_, i) => [
      conversation(A, pgInstant(sameMs + i, 100 + (i % 2) * 800)),
      conversation(B, pgInstant(sameMs + i, 500)),
    ]).flat();
    const { queries, expected } = servePostgrest([
      ...storeConversations(A, 1500, 0),
      ...storeConversations(B, 700, 3_600_000),
      ...pairs,
    ]);

    const rows = await getConversations([A, B, A], RANGE);

    expect(rows.map((r) => r.kapso_conversation_id)).toEqual(expected([A, B]).map((r) => r.kapso_conversation_id));
    expect(queries.filter((q) => q.eq.store_id === A)).toHaveLength(2);
    expect(queries.filter((q) => q.eq.store_id === B)).toHaveLength(1);
  });

  it("sin tiendas no consulta nada", async () => {
    expect(await getConversations([], RANGE)).toEqual([]);
    expect(createServerSupabaseMock).not.toHaveBeenCalled();
  });
});
