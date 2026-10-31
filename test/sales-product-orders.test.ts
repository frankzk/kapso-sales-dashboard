import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getSalesProductOrders } from "@/lib/access";
import { topProducts } from "@/lib/metrics";

// «Productos» y «Patrón de horas» del Consolidado (MOM §17.4.2, 31-10-2026):
// las líneas de todas las ventas llegan ENTERAS o no llegan. El PostgREST de
// mentira aplica los filtros del de verdad (eq, gte, lt, lte, el `or` del
// cursor, el orden y el tope de 1.000) y no tiene `range`: si el código volviera
// a paginar con OFFSET —sin desempate, los pedidos del mismo instante podían
// salir dos veces o ninguna—, la llamada no existe y la prueba revienta.

const KENKU = "dcab8bf5-23ec-49f5-8e20-f75a8f978297";
const AURELA = "4c6522f9-c775-4be3-95b0-160a3c16d27a";
const PAGE = 1000;

interface Row {
  id: string;
  store_id: string;
  created_at: string;
  cancelled_at: string | null;
  line_items: { sku: string; title: string; quantity: number; price: number }[];
}

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

const order = (store: string, createdAt: string, qty = 1): Row => ({
  id: uuid(),
  store_id: store,
  created_at: createdAt,
  cancelled_at: null,
  line_items: [{ sku: "SKU-1", title: "Producto", quantity: qty, price: 10 }],
});

const CURSOR_RE = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/;

function servePostgrest(table: Row[], opts: { failOnCall?: number } = {}) {
  const sorted = [...table].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  let calls = 0;
  const queries: { gte: string; lt: string | null; lte: string | null; or: string | null }[] = [];
  createServerSupabaseMock.mockResolvedValue({
    from: (name: string) => {
      if (name === "stores") {
        return {
          select: () => ({
            in: async (_c: string, ids: string[]) => ({ data: ids.map((id) => ({ id, timezone: "America/Lima" })), error: null }),
          }),
        };
      }
      expect(name).toBe("orders");
      const s = { eq: {} as Record<string, string>, gte: "", lt: null as string | null, lte: null as string | null, or: null as string | null };
      const ord: string[] = [];
      const q = {
        select: () => q,
        eq: (c: string, v: string) => ((s.eq[c] = v), q),
        gte: (c: string, v: string) => (expect(c).toBe("created_at"), (s.gte = v), q),
        lt: (c: string, v: string) => (expect(c).toBe("created_at"), (s.lt = v), q),
        lte: (c: string, v: string) => (expect(c).toBe("created_at"), (s.lte = v), q),
        or: (f: string) => ((s.or = f), q),
        order: (c: string, o: { ascending: boolean }) => (ord.push(`${c}.${o.ascending ? "asc" : "desc"}`), q),
        limit: async (n: number) => {
          calls += 1;
          queries.push({ gte: s.gte, lt: s.lt, lte: s.lte, or: s.or });
          expect(ord).toEqual(["created_at.desc", "id.desc"]);
          if (opts.failOnCall === calls) return { data: null, error: { message: "canceling statement due to statement timeout" } };
          const cursor = s.or ? CURSOR_RE.exec(s.or) : null;
          if (s.or && !cursor) throw new Error(`filtro or inesperado: ${s.or}`);
          const rows = sorted.filter((r) => {
            const t = Date.parse(r.created_at);
            if (s.eq.store_id && r.store_id !== s.eq.store_id) return false;
            if (t < Date.parse(s.gte)) return false;
            if (s.lt && t >= Date.parse(s.lt)) return false;
            if (s.lte && t > Date.parse(s.lte)) return false;
            if (!cursor) return true;
            const c = Date.parse(cursor[1]!);
            return t < c || (t === c && r.id < cursor[3]!);
          });
          return { data: rows.slice(0, Math.min(n, PAGE)).map((r) => ({ ...r })), error: null };
        },
      };
      return q;
    },
  });
  return { queries };
}

// Octubre en Lima: del 01-10 00:00 (05:00 UTC) al 01-11 00:00 (05:00 UTC).
const OCT = { from: "2026-10-01", to: "2026-10-31" };
const at = (i: number) => new Date(Date.parse("2026-10-02T15:00:00Z") + i * 60_000).toISOString().replace(".000Z", "+00:00");

beforeEach(() => {
  createServerSupabaseMock.mockReset();
  seq = 0;
});

describe("getSalesProductOrders: todas las líneas, una vez cada una, o ninguna", () => {
  it("cada pedido sale una sola vez aunque 30 compartan el instante del borde de una página", async () => {
    const tie = "2026-10-15T20:00:00+00:00";
    const table = [
      ...Array.from({ length: 985 }, (_, i) => order(KENKU, at(20_000 + i))), // los más nuevos: la primera página
      ...Array.from({ length: 30 }, () => order(KENKU, tie, 2)), // cruzan el borde de la página 1
      ...Array.from({ length: 1200 }, (_, i) => order(KENKU, at(i))),
      order(KENKU, "2026-10-01T04:59:59+00:00"), // 30-09 en Lima: fuera
      order(KENKU, "2026-11-01T05:00:00+00:00"), // 01-11 en Lima: fuera
      ...Array.from({ length: 40 }, (_, i) => order(AURELA, at(i))),
    ];
    const { queries } = servePostgrest(table);

    const rows = await getSalesProductOrders([KENKU, AURELA], OCT);

    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(985 + 30 + 1200 + 40);
    expect(new Set(rows!.map((r) => r.id)).size).toBe(rows!.length);
    expect(topProducts(rows!, Number.POSITIVE_INFINITY)[0]!.quantity).toBe(985 + 60 + 1200 + 40);
    const first = queries[0]!;
    expect(first.gte).toBe("2026-10-01T05:00:00.000Z");
    expect(first.lt).toBe("2026-11-01T05:00:00.000Z");
    expect(queries.filter((q) => q.or)).not.toHaveLength(0);
  });

  it("si una página falla, no devuelve las que sí leyó: el tablero vuelve a los pedidos del bot y lo dice", async () => {
    servePostgrest(Array.from({ length: 1500 }, (_, i) => order(KENKU, at(i))), { failOnCall: 2 });
    expect(await getSalesProductOrders([KENKU], OCT)).toBeNull();
  });

  it("si la primera página falla, tampoco dice «Sin líneas de producto»: null, no una lista vacía", async () => {
    servePostgrest(Array.from({ length: 10 }, (_, i) => order(KENKU, at(i))), { failOnCall: 1 });
    expect(await getSalesProductOrders([KENKU], OCT)).toBeNull();
  });

  it("sin tiendas no consulta nada", async () => {
    expect(await getSalesProductOrders([], OCT)).toEqual([]);
    expect(createServerSupabaseMock).not.toHaveBeenCalled();
  });
});
