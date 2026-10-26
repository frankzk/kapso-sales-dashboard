import { describe, expect, it } from "vitest";
import { addDays, localClock, localMidnightUtc } from "@/lib/local-day";
import {
  BUCKET_MINUTES,
  CURVE_POINTS,
  buildTodaySales,
  changeRatio,
  queryBounds,
  todayWindows,
  type TodayOrderRow,
} from "@/lib/today-sales";

// «Hoy» del Consolidado (MOM §17.5): las ventas del día contra ayer a esta
// misma hora. Lo que se fija: el día local de cada tienda, que los cancelados
// de hoy vayan aparte y el ingreso sea total − reembolsado, que «ayer a esta
// hora» corte a la misma hora local, que la curva acumule por cuarto de hora y
// que un porcentaje sobre cero no exista.

const LIMA = { id: "A", name: "Aurela", timezone: "America/Lima" };
const KENKU = { id: "K", name: "Kenku Peru", timezone: "America/Lima" };
// 25-10-2026, 4:52 p. m. en Lima (UTC−5).
const NOW = new Date("2026-10-25T21:52:00Z");

const row = (store_id: string, created_at: string, total: number | string, extra: Partial<TodayOrderRow> = {}): TodayOrderRow => ({
  store_id,
  created_at,
  total_amount: total,
  total_refunded: 0,
  cancelled_at: null,
  ...extra,
});

describe("el día local", () => {
  it("la medianoche de Lima es las 5:00 UTC, y el reloj local cuenta minutos desde ella", () => {
    expect(localMidnightUtc("2026-10-25", "America/Lima")).toBe("2026-10-25T05:00:00.000Z");
    expect(localClock("2026-10-25T21:52:00Z", "America/Lima")).toEqual({ date: "2026-10-25", minute: 16 * 60 + 52 });
    expect(localClock("2026-10-25T04:59:00Z", "America/Lima")).toEqual({ date: "2026-10-24", minute: 23 * 60 + 59 });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("la ventana de cada tienda va de la medianoche de ayer a la de mañana", () => {
    const [w] = todayWindows([LIMA], NOW);
    expect(w).toEqual({
      storeId: "A",
      timezone: "America/Lima",
      hoy: "2026-10-25",
      ayer: "2026-10-24",
      ahora: 1012,
      desde: "2026-10-24T05:00:00.000Z",
      hasta: "2026-10-26T05:00:00.000Z",
    });
    expect(queryBounds(todayWindows([LIMA, KENKU], NOW))).toEqual({
      desde: "2026-10-24T05:00:00.000Z",
      hasta: "2026-10-26T05:00:00.000Z",
    });
    expect(queryBounds([])).toBeNull();
  });
});

describe("buildTodaySales", () => {
  const rows: TodayOrderRow[] = [
    row("A", "2026-10-25T15:00:00Z", 100), // hoy 10:00
    row("A", "2026-10-25T16:10:00Z", "200.00", { total_refunded: "20.00" }), // hoy 11:10, neto 180
    row("A", "2026-10-25T17:00:00Z", 50, { cancelled_at: "2026-10-25T18:00:00Z" }), // hoy, cancelado
    row("A", "2026-10-24T14:00:00Z", 80), // ayer 9:00: ya iba a esta hora
    row("A", "2026-10-25T01:00:00Z", 60), // ayer 20:00: todavía no a esta hora
    row("A", "2026-10-24T20:00:00Z", 70, { cancelled_at: "2026-10-25T10:00:00Z" }), // ayer, cancelado: no cuenta
    row("A", "2026-10-23T20:00:00Z", 999), // antier: fuera
    row("X", "2026-10-25T15:00:00Z", 999), // otra tienda: fuera
    row("K", "2026-10-25T21:30:00Z", 300), // Kenku hoy 16:30
  ];
  const data = buildTodaySales([LIMA, KENKU], rows, NOW);

  it("hoy cuenta los activos con total − reembolsado; los cancelados de hoy van aparte", () => {
    const aurela = data.stores.find((s) => s.storeId === "A")!;
    expect(aurela.hoy).toEqual({ pedidos: 2, ingresos: 280 });
    expect(aurela.cancelados).toEqual({ pedidos: 1, ingresos: 50 });
    expect(data.total.hoy).toEqual({ pedidos: 3, ingresos: 580 });
    expect(data.total.cancelados).toEqual({ pedidos: 1, ingresos: 50 });
  });

  it("ayer a esta hora corta a la misma hora local; ayer completo sigue para la curva", () => {
    const aurela = data.stores.find((s) => s.storeId === "A")!;
    expect(aurela.ayerAEstaHora).toEqual({ pedidos: 1, ingresos: 80 });
    expect(aurela.ayerDia).toEqual({ pedidos: 2, ingresos: 140 });
    expect(data.total.ayerAEstaHora).toEqual({ pedidos: 1, ingresos: 80 });
  });

  it("la curva acumula por cuarto de hora, desde la medianoche", () => {
    const at = (minute: number) => minute / BUCKET_MINUTES;
    expect(data.curva.hoy.pedidos).toHaveLength(CURVE_POINTS);
    expect(data.curva.hoy.pedidos[at(600)]).toBe(0); // a las 10:00 todavía nada
    expect(data.curva.hoy.pedidos[at(615)]).toBe(1);
    expect(data.curva.hoy.ingresos[at(675)]).toBe(280); // 11:15: Aurela 100 + 180
    expect(data.curva.hoy.ingresos[at(1005)]).toBe(580); // 16:45: más Kenku
    expect(data.curva.ayer.pedidos[at(540)]).toBe(0);
    expect(data.curva.ayer.pedidos[at(555)]).toBe(1);
    expect(data.curva.ayer.ingresos[CURVE_POINTS - 1]).toBe(140);
    expect(data.ahora).toBe(1012);
    expect(data.fecha).toBe("2026-10-25");
    expect(data.generatedAt).toBe(NOW.toISOString());
  });

  it("cada tienda en SU día: las 5:30 UTC son hoy en Lima y ayer en Ciudad de México", () => {
    const mx = { id: "M", name: "Tienda MX", timezone: "America/Mexico_City" };
    const out = buildTodaySales([LIMA, mx], [row("A", "2026-10-25T05:30:00Z", 10), row("M", "2026-10-25T05:30:00Z", 10)], NOW);
    expect(out.stores.find((s) => s.storeId === "A")!.hoy.pedidos).toBe(1);
    const tiendaMx = out.stores.find((s) => s.storeId === "M")!;
    expect(tiendaMx.hoy.pedidos).toBe(0);
    expect(tiendaMx.ayerDia.pedidos).toBe(1);
  });

  it("sin pedidos, todo en cero y no indefinido", () => {
    const empty = buildTodaySales([LIMA], [], NOW);
    expect(empty.total.hoy).toEqual({ pedidos: 0, ingresos: 0 });
    expect(empty.curva.ayer.ingresos.every((v) => v === 0)).toBe(true);
    expect(empty.stores).toHaveLength(1);
  });
});

describe("changeRatio", () => {
  it("contra ayer a esta hora; sin nada ayer no hay porcentaje", () => {
    expect(changeRatio(98, 132)).toBeCloseTo(-0.2576, 3);
    expect(changeRatio(5, 0)).toBeNull();
    expect(changeRatio(0, 0)).toBeNull();
  });
});
