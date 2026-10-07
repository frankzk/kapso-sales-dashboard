// Vista por mes de Productividad (05-10-2026): «¿cómo quedó septiembre?» y
// «¿cómo vamos este mes?» son dos preguntas, con rangos y comparaciones
// distintos. Todo en el calendario LOCAL de la tienda.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  sales: [] as { order_id: string; store_id: string; vendedora: string; lead_id: string | null; occurred_at: string; total: number }[],
  leads: {} as Record<string, string | null>,
  calls: [] as { table: string; filters: [string, unknown][] }[],
}));

vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const call = { table, filters: [] as [string, unknown][] };
    db.calls.push(call);
    const q: Record<string, unknown> = {};
    for (const m of ["select", "in", "gte", "lte", "order"]) q[m] = (col: unknown, val?: unknown) => (call.filters.push([`${m}:${String(col)}`, val]), q);
    const filtered = () => {
      const gte = call.filters.find(([k]) => k === "gte:occurred_at")?.[1] as string;
      const lte = call.filters.find(([k]) => k === "lte:occurred_at")?.[1] as string;
      return db.sales
        .filter((s) => s.occurred_at >= gte && s.occurred_at <= lte)
        .map((s) => ({ ...s, orders: { name: `#${s.order_id}`, created_at: s.occurred_at, total_amount: s.total, total_refunded: 0 } }));
    };
    q.range = async (a: number, b: number) => ({ data: filtered().slice(a, b + 1), error: null });
    q.then = (resolve: (r: unknown) => unknown) =>
      Promise.resolve(
        table === "leads"
          ? { data: Object.entries(db.leads).map(([id, source]) => ({ id, source })), error: null }
          : { data: [], error: null },
      ).then(resolve);
    return q;
  };
  return { createServerSupabase: async () => ({ from }), createAdminSupabase: vi.fn() };
});

import {
  daysInMonth,
  fullMonthRange,
  monthLabel,
  monthPace,
  monthView,
  parseMonthParam,
  recentMonths,
  shiftMonth,
  type DayTotals,
} from "@/lib/productivity-month";
import { dailySalesTotals, getSalesTotals, type AdvisorSale } from "@/lib/productivity";

const LIMA = "America/Lima";
// 5 de octubre de 2026, 10:00 en Lima.
const NOW = "2026-10-05T15:00:00.000Z";

describe("parseMonthParam", () => {
  it("acepta YYYY-MM y nada más", () => {
    expect(parseMonthParam("2026-09")).toBe("2026-09");
    for (const bad of ["2026-13", "2026-9", "2026-09-01", "septiembre", "", null, undefined]) {
      expect(parseMonthParam(bad)).toBeNull();
    }
  });
});

describe("monthView", () => {
  it("un mes cerrado es del 1 al último día, y se compara con el mes anterior entero", () => {
    expect(monthView("2026-09", LIMA, NOW)).toEqual({
      month: "2026-09",
      label: "Septiembre 2026",
      current: false,
      range: { from: "2026-09-01", to: "2026-09-30" },
      day: 30,
      daysInMonth: 30,
      prevRange: { from: "2026-08-01", to: "2026-08-31" },
      prevLabel: "agosto",
      prevMonth: "2026-08",
    });
  });

  it("el mes en curso va del 1 a hoy, y se compara con los mismos días del mes anterior", () => {
    expect(monthView("2026-10", LIMA, NOW)).toEqual({
      month: "2026-10",
      label: "Octubre 2026",
      current: true,
      range: { from: "2026-10-01", to: "2026-10-05" },
      day: 5,
      daysInMonth: 31,
      prevRange: { from: "2026-09-01", to: "2026-09-05" },
      prevLabel: "1–5 sep",
      prevMonth: "2026-09",
    });
  });

  it("«hoy» es el día de Lima: a las 22:00 del 30 de septiembre, el mes en curso sigue siendo septiembre", () => {
    const tarde = "2026-10-01T03:00:00.000Z";
    expect(monthView("2026-09", LIMA, tarde)).toMatchObject({ current: true, day: 30, range: { to: "2026-09-30" } });
    expect(monthView("2026-10", LIMA, tarde)).toBeNull();
  });

  it("el 31 de marzo se compara con todo febrero: no hay más días que comparar", () => {
    expect(monthView("2027-03", LIMA, "2027-03-31T15:00:00.000Z")).toMatchObject({
      prevRange: { from: "2027-02-01", to: "2027-02-28" },
      prevLabel: "1–28 feb",
    });
  });

  it("el día 1 se compara con el día 1, y enero con diciembre del año anterior", () => {
    expect(monthView("2027-01", LIMA, "2027-01-01T15:00:00.000Z")).toMatchObject({
      prevRange: { from: "2026-12-01", to: "2026-12-01" },
      prevLabel: "1 dic",
      prevMonth: "2026-12",
    });
  });

  it("un mes que todavía no empezó, o mal escrito, no existe", () => {
    expect(monthView("2026-11", LIMA, NOW)).toBeNull();
    expect(monthView("2026-1", LIMA, NOW)).toBeNull();
  });
});

describe("calendario", () => {
  it("días del mes, bisiestos incluidos, y el mes entero", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-10")).toBe(31);
    expect(fullMonthRange("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("moverse de mes cruza el año", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-06")).toBe("Junio 2026");
  });

  it("los meses elegibles van del actual hacia atrás, hasta el primero con ventas", () => {
    expect(recentMonths(LIMA, NOW).map((m) => m.month)).toEqual(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06"]);
    expect(recentMonths(LIMA, "2028-10-05T15:00:00.000Z")).toHaveLength(12);
  });
});

describe("monthPace", () => {
  const octubre = monthView("2026-10", LIMA, NOW)!;
  const dia = (d: number, cerrados: number, ingresos: number): DayTotals => ({
    date: `2026-10-0${d}`,
    cerrados,
    ingresos,
  });

  it("proyecta el mes con los días ya terminados: hoy no cuenta hasta que cierre", () => {
    const daily = [dia(1, 10, 1000), dia(2, 12, 1200), dia(3, 8, 800), dia(4, 10, 1000), dia(5, 90, 9000)];
    // 40 pedidos en 4 días → 10 al día × 31 días.
    expect(monthPace(daily, octubre)).toEqual({ completedDays: 4, projected: { cerrados: 310, ingresos: 31000 } });
  });

  it("lo que cae fuera del mes no entra en el ritmo", () => {
    const daily = [{ date: "2026-09-30", cerrados: 50, ingresos: 5000 }, dia(1, 10, 1000)];
    expect(monthPace(daily, octubre).projected).toEqual({ cerrados: 78, ingresos: 7750 });
  });

  it("el día 1 todavía no hay ritmo", () => {
    expect(monthPace([dia(1, 10, 1000)], monthView("2026-10", LIMA, "2026-10-01T15:00:00.000Z")!)).toEqual({
      completedDays: 0,
      projected: null,
    });
  });

  it("un mes cerrado no tiene ritmo: ya tiene resultado", () => {
    expect(monthPace([], monthView("2026-09", LIMA, NOW)!)).toEqual({ completedDays: 30, projected: null });
  });
});

describe("dailySalesTotals", () => {
  const venta = (vendedora: string, occurredAt: string, net: number): AdvisorSale => ({
    vendedora,
    orderId: `${vendedora}-${occurredAt}`,
    occurredAt,
    storeId: "s",
    net,
    orderName: null,
    orderAt: null,
    source: "organic",
  });

  it("cuenta por día de Lima, del equipo y de cada asesora", () => {
    const { team, byAgent } = dailySalesTotals(
      [
        venta("ana", "2026-10-01T15:00:00Z", 100),
        venta("ana", "2026-10-02T04:30:00Z", 50.5), // 23:30 del 1 en Lima
        venta("bea", "2026-10-02T15:00:00Z", 200),
        venta("", "2026-10-02T16:00:00Z", 999), // sin dueña: no es un cierre
      ],
      LIMA,
    );
    expect(team).toEqual([
      { date: "2026-10-01", cerrados: 2, ingresos: 150.5 },
      { date: "2026-10-02", cerrados: 1, ingresos: 200 },
    ]);
    expect(byAgent).toEqual({
      ana: [{ date: "2026-10-01", cerrados: 2, ingresos: 150.5 }],
      bea: [{ date: "2026-10-02", cerrados: 1, ingresos: 200 }],
    });
  });
});

describe("getSalesTotals («septiembre cerró en …»)", () => {
  beforeEach(() => {
    db.calls = [];
    db.leads = { l1: "meta_ad", l2: "organic" };
    db.sales = [
      { order_id: "A", store_id: "s", vendedora: "ana", lead_id: "l1", occurred_at: "2026-09-01T05:00:00.000Z", total: 100 },
      { order_id: "B", store_id: "s", vendedora: "bea", lead_id: "l2", occurred_at: "2026-09-30T20:00:00.000Z", total: 250 },
      // 30 sep a las 23:30 de Lima: todavía es septiembre.
      { order_id: "C", store_id: "s", vendedora: "ana", lead_id: "l2", occurred_at: "2026-10-01T04:30:00.000Z", total: 40 },
      // 1 oct a las 00:30 de Lima: ya no.
      { order_id: "D", store_id: "s", vendedora: "ana", lead_id: "l2", occurred_at: "2026-10-01T05:30:00.000Z", total: 999 },
    ];
  });

  it("suma los cierres del mes entero en el calendario de Lima", async () => {
    expect(await getSalesTotals(["s"], fullMonthRange("2026-09"), null, LIMA)).toEqual({ cerrados: 3, ingresos: 390 });
  });

  it("con la lente de fuente y, en «Mi productividad», solo las de la asesora", async () => {
    expect(await getSalesTotals(["s"], fullMonthRange("2026-09"), "organic", LIMA)).toEqual({ cerrados: 2, ingresos: 290 });
    expect(await getSalesTotals(["s"], fullMonthRange("2026-09"), null, LIMA, "ana")).toEqual({ cerrados: 2, ingresos: 140 });
  });

  it("sin tiendas no consulta nada", async () => {
    expect(await getSalesTotals([], fullMonthRange("2026-09"))).toEqual({ cerrados: 0, ingresos: 0 });
    expect(db.calls).toEqual([]);
  });
});
