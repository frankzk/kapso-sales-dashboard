import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRollupPending, widenRollupPending } from "@/lib/ingest";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";

process.env.ENCRYPTION_KEY = generateEncryptionKey();

// Guarda del progreso por página del sync.
//
// POR QUÉ EXISTE ESTE TEST. El cursor de Shopify se guardaba UNA vez, al acabar
// el bucle de hasta 50 páginas. Morir en la página 40 no corrompía nada (los
// upserts son idempotentes) pero tiraba el avance: la corrida siguiente volvía
// a pedir esas 40 páginas, tardaba más, y tenía más papeletas de morir también.
// Esa realimentación es lo que convertía un timeout suelto en una racha.
//
// Guardar el cursor página a página lo arregla, pero abre un agujero sutil: las
// fechas que necesitan recálculo de rollup vivían SOLO en memoria. Con el cursor
// avanzando por página, una corrida que muera antes del rollup dejaría días con
// métricas viejas y sin nadie que vuelva a mirarlos, porque el cursor ya pasó de
// largo. Por eso la deuda de rollup se guarda en `sync_state` igual que el
// cursor, y este test fija el invariante que lo hace seguro:
//
//   la deuda de rollup se persiste ANTES de que avance el cursor.

describe("widenRollupPending · unir la deuda de rollup", () => {
  it("de un conjunto de fechas saca el rango que las cubre", () => {
    expect(widenRollupPending(null, ["2026-07-05", "2026-07-01", "2026-07-03"])).toEqual({
      from: "2026-07-01",
      to: "2026-07-05",
    });
  });

  it("ensancha por los dos extremos sobre una deuda que ya existía", () => {
    expect(
      widenRollupPending({ from: "2026-07-10", to: "2026-07-12" }, ["2026-07-02", "2026-07-20"]),
    ).toEqual({ from: "2026-07-02", to: "2026-07-20" });
  });

  it("sin fechas nuevas deja la deuda como estaba", () => {
    expect(widenRollupPending({ from: "2026-07-10", to: "2026-07-12" }, [])).toEqual({
      from: "2026-07-10",
      to: "2026-07-12",
    });
  });

  it("sin deuda y sin fechas no inventa un rango", () => {
    expect(widenRollupPending(null, [])).toBeNull();
  });

  it("una sola fecha es un rango de un día, no medio rango", () => {
    expect(widenRollupPending(null, ["2026-07-07"])).toEqual({ from: "2026-07-07", to: "2026-07-07" });
  });
});

describe("parseRollupPending", () => {
  it("lee el formato que escribe", () => {
    expect(parseRollupPending("2026-07-01..2026-07-05")).toEqual({ from: "2026-07-01", to: "2026-07-05" });
  });

  it("trata como 'sin deuda' lo vacío o lo que no tiene los dos extremos", () => {
    expect(parseRollupPending(null)).toBeNull();
    expect(parseRollupPending("")).toBeNull();
    expect(parseRollupPending("2026-07-01")).toBeNull();
  });
});

// --- Fake permisivo de Supabase: recuerda cursores y apunta cada escritura ---

interface Recorded {
  source: string;
  cursor: string | null;
  status: string;
}

function makeFakeAdmin(storeRow: Record<string, unknown>) {
  const cursors = new Map<string, string | null>();
  const writes: Recorded[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  class Builder {
    filters: Record<string, unknown> = {};
    constructor(public table: string) {}
    select() {
      return this;
    }
    eq(k: string, v: unknown) {
      this.filters[k] = v;
      return this;
    }
    match(m: Record<string, unknown>) {
      Object.assign(this.filters, m);
      return this;
    }
    in() {
      return this;
    }
    is() {
      return this;
    }
    not() {
      return this;
    }
    limit() {
      return this;
    }
    order() {
      return this;
    }
    lt() {
      return this;
    }
    gte() {
      return this;
    }
    update() {
      return this;
    }
    insert() {
      return this;
    }
    delete() {
      return this;
    }
    upsert(payload: Record<string, unknown>) {
      if (this.table === "sync_state") {
        const source = payload.source as string;
        cursors.set(source, (payload.cursor as string | null) ?? null);
        writes.push({
          source,
          cursor: (payload.cursor as string | null) ?? null,
          status: payload.status as string,
        });
      }
      return this;
    }
    async single() {
      return this.table === "stores" ? { data: storeRow, error: null } : { data: null, error: null };
    }
    async maybeSingle() {
      if (this.table === "sync_state") {
        const source = this.filters.source as string;
        return { data: { cursor: cursors.get(source) ?? null }, error: null };
      }
      return { data: null, error: null };
    }
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
    }
  }

  const admin = {
    from: (table: string) => new Builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  };
  return { admin, writes, rpcCalls, cursors };
}

const order = (id: string, createdAt: string, updatedAt: string) => ({
  store_id: "store-1",
  shopify_order_id: id,
  created_at: createdAt,
  updated_at: updatedAt,
  currency: "PEN",
  total_price: 100,
});

// Solo se simula la capa de red de Shopify; todo lo demás corre de verdad
// contra el fake de Supabase.
vi.mock("@/lib/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify")>();
  return {
    ...actual,
    fetchOrdersPage: vi.fn(),
    fetchDraftOrdersPage: vi.fn(async () => ({
      draftOrders: [],
      maxUpdatedAt: null,
      hasNextPage: false,
      endCursor: null,
    })),
  };
});

describe("runStoreSync · el cursor avanza página a página", () => {
  const storeRow = {
    id: "store-1",
    org_id: "org-1",
    name: "Tienda",
    shopify_domain: "t.myshopify.com",
    shopify_token_enc: encrypt("shpat_token"),
    status: "active",
    timezone: "America/Lima",
    // Sin Kapso ni Meta: así solo corren las pasadas de Shopify.
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("guarda el cursor tras CADA página, no solo al final del bucle", async () => {
    const { fetchOrdersPage } = await import("@/lib/shopify");
    const { runStoreSync } = await import("@/lib/ingest");

    (fetchOrdersPage as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ searchQuery, after }: { searchQuery: string; after: string | null }) => {
        // La segunda pasada (sin `tag:`) no aporta nada a este caso.
        if (!searchQuery.includes("tag:")) {
          return { orders: [], maxUpdatedAt: null, hasNextPage: false, endCursor: null };
        }
        if (!after) {
          return {
            orders: [order("1", "2026-07-01T12:00:00Z", "2026-07-01T12:00:00Z")],
            maxUpdatedAt: "2026-07-01T12:00:00Z",
            hasNextPage: true,
            endCursor: "cur-1",
          };
        }
        return {
          orders: [order("2", "2026-07-03T12:00:00Z", "2026-07-03T12:00:00Z")],
          maxUpdatedAt: "2026-07-03T12:00:00Z",
          hasNextPage: false,
          endCursor: null,
        };
      },
    );

    const { admin, writes, rpcCalls } = makeFakeAdmin(storeRow);
    await runStoreSync("store-1", admin as never);

    // Dos páginas ⇒ dos avances de cursor, con el valor de cada una.
    const shopifyCursors = writes.filter((w) => w.source === "shopify").map((w) => w.cursor);
    expect(shopifyCursors).toEqual(["2026-07-01T12:00:00Z", "2026-07-03T12:00:00Z"]);

    // El invariante que hace seguro lo anterior: la deuda de rollup de una
    // página se persiste ANTES de que el cursor pase de esa página.
    const firstDebt = writes.findIndex((w) => w.source === "rollup_pending");
    const firstCursor = writes.findIndex((w) => w.source === "shopify");
    expect(firstDebt).toBeGreaterThanOrEqual(0);
    expect(firstDebt).toBeLessThan(firstCursor);

    // El rollup cubre las dos páginas y la deuda se salda al terminar bien.
    expect(rpcCalls).toContainEqual({
      fn: "recompute_daily_rollups",
      args: { p_store_id: "store-1", p_from: "2026-07-01", p_to: "2026-07-03" },
    });
    const debts = writes.filter((w) => w.source === "rollup_pending");
    expect(debts[debts.length - 1]!.cursor).toBeNull();
  });

  it("una corrida que muere a media deja el avance guardado y la deuda sin saldar", async () => {
    const { fetchOrdersPage } = await import("@/lib/shopify");
    const { runStoreSync } = await import("@/lib/ingest");

    (fetchOrdersPage as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ searchQuery, after }: { searchQuery: string; after: string | null }) => {
        if (!searchQuery.includes("tag:")) {
          return { orders: [], maxUpdatedAt: null, hasNextPage: false, endCursor: null };
        }
        if (!after) {
          return {
            orders: [order("1", "2026-07-01T12:00:00Z", "2026-07-01T12:00:00Z")],
            maxUpdatedAt: "2026-07-01T12:00:00Z",
            hasNextPage: true,
            endCursor: "cur-1",
          };
        }
        // La segunda página revienta: es el ensayo del corte a media.
        throw new Error("Shopify 503");
      },
    );

    const { admin, writes, cursors, rpcCalls } = makeFakeAdmin(storeRow);
    const report = await runStoreSync("store-1", admin as never);

    expect(report.errors.some((e) => e.includes("Shopify 503"))).toBe(true);
    // Lo ingerido antes del fallo NO se pierde: el cursor se queda en la
    // página 1 en vez de volver a null y arrastrar todo el histórico.
    expect(cursors.get("shopify")).toBe("2026-07-01T12:00:00Z");
    expect(writes.filter((w) => w.source === "shopify" && w.cursor === null)).toEqual([]);

    // Y el día tocado sigue teniendo su rollup, porque la deuda era durable.
    expect(rpcCalls).toContainEqual({
      fn: "recompute_daily_rollups",
      args: { p_store_id: "store-1", p_from: "2026-07-01", p_to: "2026-07-01" },
    });
  });
});
