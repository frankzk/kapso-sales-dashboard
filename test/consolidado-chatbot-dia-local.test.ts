import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getConversations, getLeadsForDashboard, getOrders, storeDayBounds } from "@/lib/access";
import { cartRecovery } from "@/lib/metrics";

// Los módulos del chatbot de Kapso en el Consolidado (MOM §17.4.2, 31-10-2026):
//  1. sus pedidos, conversaciones y leads se cortan en el día LOCAL de la tienda,
//     como `daily_rollups` y «Conversión del bot», no en el día UTC;
//  2. «Carritos abandonados» recibe el borrador y el valor del carrito, o su
//     «Valor en riesgo» sale siempre S/ 0.

const LIMA = "dcab8bf5-23ec-49f5-8e20-f75a8f978297";
const AYER = { from: "2026-10-30", to: "2026-10-30" };
const TZ = { [LIMA]: "America/Lima" };

type Row = Record<string, unknown> & { id: string; store_id: string };

/**
 * PostgREST de mentira: aplica los filtros que usan los lectores (eq, in,
 * contains, gte, lte, lt) y devuelve SOLO las columnas pedidas en `select`,
 * como el de verdad: una columna que el lector no pide no llega.
 */
function servePostgrest(tables: Record<string, Row[]>) {
  const calls: { table: string; filters: string[] }[] = [];
  createServerSupabaseMock.mockResolvedValue({
    from: (table: string) => {
      const filters: string[] = [];
      const preds: ((r: Row) => boolean)[] = [];
      let cols: string[] = [];
      const ms = (v: unknown) => Date.parse(String(v)) * 1000 + Number(`${/\.(\d+)/.exec(String(v))?.[1] ?? ""}000000`.slice(3, 6));
      const run = () => {
        calls.push({ table, filters });
        const rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        return Promise.resolve({
          data: rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]))),
          error: null,
        });
      };
      const q = {
        select: (s: string) => ((cols = s.split(",")), q),
        eq: (c: string, v: unknown) => (filters.push(`${c}=${v}`), preds.push((r) => r[c] === v), q),
        in: (c: string, v: unknown[]) => (filters.push(`${c} in ${v}`), preds.push((r) => v.includes(r[c])), q),
        contains: (c: string, v: string[]) => (preds.push((r) => v.every((x) => (r[c] as string[]).includes(x))), q),
        gte: (c: string, v: string) => (filters.push(`${c}>=${v}`), preds.push((r) => ms(r[c]) >= ms(v)), q),
        lte: (c: string, v: string) => (filters.push(`${c}<=${v}`), preds.push((r) => ms(r[c]) <= ms(v)), q),
        lt: (c: string, v: string) => (filters.push(`${c}<${v}`), preds.push((r) => ms(r[c]) < ms(v)), q),
        or: () => q,
        order: () => q,
        limit: run,
        range: run,
      };
      return q;
    },
  });
  return calls;
}

beforeEach(() => createServerSupabaseMock.mockReset());

describe("storeDayBounds", () => {
  it("«Ayer» en Lima va de su medianoche al último microsegundo del día", () => {
    expect(storeDayBounds(AYER, "America/Lima")).toEqual({
      startIso: "2026-10-30T05:00:00.000Z",
      endIso: "2026-10-31T04:59:59.999999Z",
      endExclusiveIso: "2026-10-31T05:00:00.000Z",
    });
  });

  it("sin zona, el día UTC, como `daily_rollups` y `ventas_por_origen` en la base", () => {
    expect(storeDayBounds(AYER, null).startIso).toBe("2026-10-30T00:00:00.000Z");
  });
});

describe("los módulos del chatbot cuentan el día local de la tienda", () => {
  // 30-10 en Lima: de 2026-10-30T05:00Z a 2026-10-31T05:00Z.
  const at = {
    anteayerNoche: "2026-10-30T03:00:00+00:00", // 29-10, 22:00 en Lima
    ayerManana: "2026-10-30T15:00:00+00:00", // 30-10, 10:00 en Lima
    ayerNoche: "2026-10-31T02:00:00+00:00", // 30-10, 21:00 en Lima
    ultimoInstante: "2026-10-31T04:59:59.999999+00:00", // 30-10, 23:59:59.999999 en Lima
    hoy: "2026-10-31T05:00:00+00:00", // 31-10, 00:00 en Lima
  };
  const ids = Object.keys(at) as (keyof typeof at)[];

  it("los pedidos del bot", async () => {
    servePostgrest({
      orders: ids.map((k) => ({ id: k, store_id: LIMA, created_at: at[k], tags: ["kapso"], cancelled_at: null })),
    });
    const rows = await getOrders([LIMA], AYER, TZ);
    expect(rows.map((r) => r.id).sort()).toEqual(["ayerManana", "ayerNoche", "ultimoInstante"]);
  });

  it("las conversaciones", async () => {
    servePostgrest({
      conversations: ids.map((k) => ({ id: k, store_id: LIMA, kapso_conversation_id: k, started_at: at[k] })),
    });
    const rows = await getConversations([LIMA], AYER, TZ);
    expect(rows.map((r) => r.kapso_conversation_id).sort()).toEqual(["ayerManana", "ayerNoche", "ultimoInstante"]);
  });

  it("los leads", async () => {
    servePostgrest({
      leads: ids.map((k) => ({ id: k, store_id: LIMA, last_interaction_at: at[k] })),
    });
    const rows = await getLeadsForDashboard([LIMA], AYER, TZ);
    expect(rows.map((r) => r.id).sort()).toEqual(["ayerManana", "ayerNoche", "ultimoInstante"]);
  });

  it("las dos páginas del tablero le pasan la zona de cada tienda", () => {
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
    const all = read("app/dashboard/page.tsx");
    expect(all).toContain("getLeadsForDashboard(storeIds, range, timeZones)");
    expect(all).toContain("getOrders(storeIds, range, timeZones)");
    expect(all).toContain("getConversations(storeIds, range, timeZones)");
    const one = read("app/dashboard/[storeId]/page.tsx");
    expect(one).toContain("getLeadsForDashboard([storeId], range, timeZones)");
    expect(one).toContain("getOrders([storeId], range, timeZones)");
    expect(one).toContain("getConversations([storeId], range, timeZones)");
  });
});

describe("«Carritos abandonados» recibe el carrito completo", () => {
  it("cuenta el borrador del bot y el valor que queda por trabajar", async () => {
    const base = { store_id: LIMA, last_interaction_at: "2026-10-30T15:00:00+00:00", category: "warm", status: "nuevo", has_order: false };
    servePostgrest({
      leads: [
        // Carrito COD abierto: S/ 120 por trabajar.
        { ...base, id: "cod-abierto", phone: "51900000001", source: "cod_cart", cart_value: 120 },
        // Borrador del bot abierto (sin fuente de campaña): S/ 80 por trabajar.
        { ...base, id: "borrador-abierto", phone: "51900000002", source: null, draft_order_gid: "gid://shopify/DraftOrder/1", draft_order_status: "open", cart_value: 80 },
        // Borrador completado: recuperado, aunque `has_order` no se haya marcado aún.
        { ...base, id: "borrador-completo", phone: "51900000003", source: null, draft_order_gid: "gid://shopify/DraftOrder/2", draft_order_status: "completed", cart_value: 99 },
      ],
    });
    const leads = await getLeadsForDashboard([LIMA], AYER, TZ);
    const s = cartRecovery(leads, [])!;
    expect(s.total).toBe(3);
    expect(s.recuperados).toBe(1);
    expect(s.pendientes).toBe(2);
    expect(s.valorEnRiesgo).toBe(200);
  });
});
