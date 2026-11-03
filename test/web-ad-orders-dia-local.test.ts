import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import { getWebAdOrders } from "@/lib/access";

// «Anuncios de Meta» (MOM §17.4.3, 31-10-2026): los pedidos web con UTM se
// cortan en el día LOCAL de cada tienda, como la cohorte de leads de anuncios y
// la cabecera. Con los límites en UTC, «Ayer» (30-10) en Lima traía los pedidos
// de las 7 p. m. a medianoche del 29 y perdía los del 30 a esa hora.
//
// El PostgREST de mentira aplica eq/in, not-null, gte, lt, lte, el orden y
// range sobre filas en memoria: lo que devuelve es lo que devolvería la base.

const LIMA = "aaaaaaaa-0000-4000-8000-000000000001";
const UTC_STORE = "bbbbbbbb-0000-4000-8000-000000000002";

interface Row {
  id: string;
  store_id: string;
  created_at: string;
  utm_meta: { name: string; value: string }[] | null;
}

const utm = [{ name: "utm_id", value: "120200000000000001" }];
const ORDERS: Row[] = [
  // 29-10, 22:00 en Lima: es del 29, aunque en UTC ya sea el 30.
  { id: "lima-29-noche", store_id: LIMA, created_at: "2026-10-30T03:00:00+00:00", utm_meta: utm },
  // 30-10, 08:00 en Lima.
  { id: "lima-30-manana", store_id: LIMA, created_at: "2026-10-30T13:00:00+00:00", utm_meta: utm },
  // 30-10, 21:00 en Lima: es del 30, aunque en UTC ya sea el 31.
  { id: "lima-30-noche", store_id: LIMA, created_at: "2026-10-31T02:00:00+00:00", utm_meta: utm },
  // 30-10, 23:59:59.5 en Lima: el último medio segundo del día también cuenta.
  { id: "lima-30-ultimo", store_id: LIMA, created_at: "2026-10-31T04:59:59.500+00:00", utm_meta: utm },
  // 31-10, 00:00 en Lima: ya no.
  { id: "lima-31", store_id: LIMA, created_at: "2026-10-31T05:00:00+00:00", utm_meta: utm },
  // Sin UTM: no es un pedido del carrito con anuncio.
  { id: "lima-sin-utm", store_id: LIMA, created_at: "2026-10-30T15:00:00+00:00", utm_meta: null },
  // Una tienda en UTC corta en SU medianoche, no en la de Lima.
  { id: "utc-30", store_id: UTC_STORE, created_at: "2026-10-30T23:30:00+00:00", utm_meta: utm },
  { id: "utc-31", store_id: UTC_STORE, created_at: "2026-10-31T02:00:00+00:00", utm_meta: utm },
];

function serve() {
  createServerSupabaseMock.mockResolvedValue({
    from: (table: string) => {
      if (table === "stores") {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: [
                { id: LIMA, timezone: "America/Lima" },
                { id: UTC_STORE, timezone: "UTC" },
              ].filter((s) => ids.includes(s.id)),
              error: null,
            }),
          }),
        };
      }
      expect(table).toBe("orders");
      const preds: ((r: Row) => boolean)[] = [];
      const q = {
        select: () => q,
        eq: (col: keyof Row, v: string) => (preds.push((r) => r[col] === v), q),
        in: (col: keyof Row, vs: string[]) => (preds.push((r) => vs.includes(r[col] as string)), q),
        not: (col: keyof Row, op: string, v: null) => {
          expect([op, v]).toEqual(["is", null]);
          preds.push((r) => r[col] != null);
          return q;
        },
        gte: (col: "created_at", v: string) => (preds.push((r) => Date.parse(r[col]) >= Date.parse(v)), q),
        gt: (col: "created_at", v: string) => (preds.push((r) => Date.parse(r[col]) > Date.parse(v)), q),
        lt: (col: "created_at", v: string) => (preds.push((r) => Date.parse(r[col]) < Date.parse(v)), q),
        lte: (col: "created_at", v: string) => (preds.push((r) => Date.parse(r[col]) <= Date.parse(v)), q),
        order: () => q,
        range: async (from: number, to: number) => ({
          data: ORDERS.filter((r) => preds.every((p) => p(r)))
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
            .slice(from, to + 1),
          error: null,
        }),
      };
      return q;
    },
  });
}

describe("getWebAdOrders: el día de la tienda, no el de UTC", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
    serve();
  });

  it("«Ayer» en Lima son los pedidos web de 00:00 a 23:59:59 de Lima", async () => {
    const out = await getWebAdOrders([LIMA], { from: "2026-10-30", to: "2026-10-30" });
    expect(out.map((w) => w.order.id).sort()).toEqual(["lima-30-manana", "lima-30-noche", "lima-30-ultimo"]);
    expect(out[0]!.utm.utmId).toBe("120200000000000001");
  });

  it("cada tienda corta en su propia medianoche", async () => {
    const out = await getWebAdOrders([LIMA, UTC_STORE], { from: "2026-10-30", to: "2026-10-30" });
    expect(out.map((w) => w.order.id).sort()).toEqual([
      "lima-30-manana",
      "lima-30-noche",
      "lima-30-ultimo",
      "utc-30",
    ]);
  });
});
