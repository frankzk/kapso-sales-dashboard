import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildDayPulse,
  buildPeriodPulse,
  cutDays,
  isComparable,
  parsePulsePeriod,
  periodWindow,
  salesFloor,
  type PulseDayRow,
} from "@/lib/sales-pulse";
import { CURVE_POINTS, type TodayOrderRow } from "@/lib/today-sales";
import { SalesPulseCard } from "@/components/sales-pulse";

// «Cómo van las ventas» del Consolidado (MOM §17.5): hoy, esta semana y este
// mes contra el periodo anterior a esta misma altura. Lo que se fija: dónde
// empieza cada periodo y dónde corta el anterior (mismo día de la semana o del
// mes, a la misma hora local, y el mes anterior entero si no tiene ese día),
// que el día del corte se cuente al minuto, que la curva acumule por día con el
// punto del corte sobre su línea, y que sin todas las ventas del anterior no se
// compare.

const read = (path: string) => readFileSync(path, "utf8");

const AURELA = { id: "A", name: "Aurela", timezone: "America/Lima" };
const KENKU = { id: "K", name: "Kenku Peru", timezone: "America/Lima" };
// Domingo 25-10-2026, 4:52 p. m. en Lima (UTC−5).
const NOW = new Date("2026-10-25T21:52:00Z");
const AHORA = 16 * 60 + 52;
const FLOORS = new Map([
  ["A", "2026-06-01"],
  ["K", "2026-06-01"],
]);
// Para marzo: febrero tiene que estar entero en Kapta.
const OLD_FLOORS = new Map([["A", "2025-06-01"]]);

const order = (store_id: string, created_at: string, total: number, extra: Partial<TodayOrderRow> = {}): TodayOrderRow => ({
  store_id,
  created_at,
  total_amount: total,
  total_refunded: 0,
  cancelled_at: null,
  ...extra,
});
const day = (storeId: string, date: string, orders: number, revenue: number, cancelled = 0): PulseDayRow => ({
  storeId,
  date,
  orders,
  revenue,
  cancelled,
});

describe("los periodos", () => {
  it("la semana va de lunes a domingo y corta el mismo día de la semana pasada", () => {
    expect(periodWindow(AURELA, "semana", NOW)).toEqual({
      storeId: "A",
      timezone: "America/Lima",
      hoy: "2026-10-25",
      ahora: AHORA,
      desde: "2026-10-19",
      hasta: "2026-10-25",
      anteriorDesde: "2026-10-12",
      anteriorHasta: "2026-10-18",
      corte: "2026-10-18",
      indice: 6,
      dias: 7,
      diasAnterior: 7,
    });
    const miercoles = periodWindow(AURELA, "semana", new Date("2026-10-21T15:00:00Z"));
    expect([miercoles.desde, miercoles.indice, miercoles.corte]).toEqual(["2026-10-19", 2, "2026-10-14"]);
  });

  it("el mes corta el mismo día del mes anterior; si el anterior no lo tiene, va entero", () => {
    const octubre = periodWindow(AURELA, "mes", NOW);
    expect(octubre).toMatchObject({
      desde: "2026-10-01",
      hasta: "2026-10-31",
      anteriorDesde: "2026-09-01",
      anteriorHasta: "2026-09-30",
      corte: "2026-09-25",
      indice: 24,
      dias: 31,
      diasAnterior: 30,
    });
    const marzo = periodWindow(AURELA, "mes", new Date("2026-03-30T17:00:00Z"));
    expect(marzo).toMatchObject({ anteriorDesde: "2026-02-01", anteriorHasta: "2026-02-28", corte: null, indice: 29, diasAnterior: 28 });
    expect(periodWindow(AURELA, "mes", new Date("2026-01-31T17:00:00Z")).corte).toBe("2025-12-31");
    expect(cutDays([marzo, octubre])).toEqual([{ storeId: "A", timezone: "America/Lima", day: "2026-09-25" }]);
  });

  it("hoy es el mismo periodo de siempre: contra ayer", () => {
    expect(periodWindow(AURELA, "hoy", NOW)).toMatchObject({ desde: "2026-10-25", anteriorDesde: "2026-10-24", corte: "2026-10-24" });
    expect(parsePulsePeriod("semana")).toBe("semana");
    expect(parsePulsePeriod("mes")).toBe("mes");
    expect(parsePulsePeriod("año")).toBe("hoy");
    expect(parsePulsePeriod(null)).toBe("hoy");
  });

  it("solo se compara si Kapta tiene todas las ventas desde el inicio del anterior", () => {
    expect(salesFloor("2026-06-01", "2025-11-03")).toBe("2026-06-01");
    expect(salesFloor("2026-06-01", "2026-10-13")).toBe("2026-10-13");
    expect(salesFloor("2026-06-01", null)).toBeNull();
    const w = periodWindow(AURELA, "semana", NOW);
    expect(isComparable("2026-10-12", w)).toBe(true);
    expect(isComparable("2026-10-13", w)).toBe(false);
    expect(isComparable(null, w)).toBe(false);
  });
});

describe("esta semana", () => {
  const dias = [
    day("A", "2026-10-19", 10, 1000, 1),
    day("K", "2026-10-20", 20, 3000, 2),
    day("A", "2026-10-25", 4, 400),
    day("A", "2026-10-12", 8, 800),
    day("K", "2026-10-15", 5, 500),
    day("A", "2026-10-18", 6, 600), // el día del corte: entero para la curva, al minuto para la cifra
    day("A", "2026-10-11", 99, 9999), // antes del anterior: fuera
    day("X", "2026-10-20", 99, 9999), // otra tienda: fuera
  ];
  const corte = [
    order("A", "2026-10-18T15:00:00Z", 100), // 10:00: ya iba
    order("A", "2026-10-18T21:52:00Z", 50, { total_refunded: 10 }), // 4:52 p. m. justo: cuenta, neto 40
    order("A", "2026-10-18T22:30:00Z", 70), // 5:30 p. m.: todavía no
    order("A", "2026-10-18T16:00:00Z", 30, { cancelled_at: "2026-10-19T10:00:00Z" }), // cancelado: no
    order("K", "2026-10-19T01:00:00Z", 90), // 8 p. m. del 18 en Lima: todavía no
    order("A", "2026-10-17T20:00:00Z", 999), // otro día: fuera
  ];
  const data = buildPeriodPulse([AURELA, KENKU], "semana", dias, corte, FLOORS, NOW);

  it("cuenta de lunes a ahora y la semana pasada hasta el domingo a esta hora", () => {
    const a = data.stores.find((s) => s.storeId === "A")!;
    expect(a.actual).toEqual({ pedidos: 14, ingresos: 1400 });
    expect(a.anterior).toEqual({ pedidos: 10, ingresos: 940 });
    expect(a.anteriorCompleto).toEqual({ pedidos: 14, ingresos: 1400 });
    expect(data.total.actual).toEqual({ pedidos: 34, ingresos: 4400 });
    expect(data.total.anterior).toEqual({ pedidos: 15, ingresos: 1440 });
    expect(data.total.anteriorCompleto).toEqual({ pedidos: 19, ingresos: 1900 });
    expect(data.total.cancelados).toEqual({ pedidos: 3, ingresos: null });
    expect(data.comparable).toBe(true);
    expect([data.desde, data.hasta, data.anteriorDesde, data.corte]).toEqual(["2026-10-19", "2026-10-25", "2026-10-12", "2026-10-18"]);
  });

  it("la curva acumula por día y la semana pasada lleva dentro el punto del corte", () => {
    const ahora = 6 + AHORA / 1440;
    expect(data.curva.unidad).toBe("dia");
    expect(data.curva.largo).toBe(7);
    expect(data.curva.ahora).toBeCloseTo(ahora, 6);
    expect(data.curva.corte).toBeCloseTo(ahora, 6);
    expect(data.curva.actual.map((p) => p.pedidos)).toEqual([0, 10, 30, 30, 30, 30, 30, 34]);
    expect(data.curva.actual.at(-1)!.x).toBeCloseTo(ahora, 6);
    expect(data.curva.anterior.map((p) => p.pedidos)).toEqual([0, 8, 8, 8, 13, 13, 13, 15, 19]);
    expect(data.curva.anterior[7]!.x).toBeCloseTo(ahora, 6);
  });

  it("el cursor recorre los días: hasta cada día, y hoy hasta ahora", () => {
    expect(data.curva.slots).toHaveLength(7);
    expect(data.curva.slotAhora).toBe(6);
    expect(data.curva.slots[0]).toEqual({ x: 1, indice: 0, actual: { pedidos: 10, ingresos: 1000 }, anterior: { pedidos: 8, ingresos: 800 } });
    expect(data.curva.slots[6]!.actual).toEqual(data.total.actual);
    expect(data.curva.slots[6]!.anterior).toEqual(data.total.anterior);
  });

  it("sin todas las ventas de la semana pasada no hay comparación ni curva anterior", () => {
    const tarde = buildPeriodPulse([AURELA, KENKU], "semana", dias, corte, new Map([["A", "2026-10-13"], ["K", "2026-06-01"]]), NOW);
    expect(tarde.comparable).toBe(false);
    expect(tarde.stores.map((s) => [s.storeId, s.comparable, s.piso])).toEqual([
      ["A", false, "2026-10-13"],
      ["K", true, "2026-06-01"],
    ]);
    expect(tarde.curva.slots.every((s) => s.anterior === null)).toBe(true);
  });
});

describe("este mes", () => {
  it("el 30 de marzo se compara contra febrero entero, sin día del corte", () => {
    const now = new Date("2026-03-30T17:00:00Z");
    const data = buildPeriodPulse(
      [AURELA],
      "mes",
      [day("A", "2026-03-01", 3, 300), day("A", "2026-02-28", 2, 200), day("A", "2026-02-01", 1, 100)],
      [order("A", "2026-02-28T15:00:00Z", 999)],
      OLD_FLOORS,
      now,
    );
    expect(data.corte).toBeNull();
    expect(data.total.anterior).toEqual({ pedidos: 3, ingresos: 300 });
    expect(data.total.anterior).toEqual(data.total.anteriorCompleto);
    expect(data.curva.largo).toBe(31);
    expect(data.curva.corte).toBe(28);
    expect(data.curva.anterior).toHaveLength(29);
    expect(data.curva.slots[27]!.anterior).toEqual({ pedidos: 3, ingresos: 300 });
    expect(data.curva.slots[29]!.anterior).toBeNull();
    expect(data.curva.slots[30]!.actual).toBeNull();
  });
});

describe("hoy", () => {
  const rows = [
    order("A", "2026-10-25T15:00:00Z", 100), // hoy 10:00
    order("A", "2026-10-24T14:00:00Z", 80), // ayer 9:00
    order("A", "2026-10-24T21:52:00Z", 20), // ayer 4:52 p. m. justo: ya iba
    order("K", "2026-10-25T21:30:00Z", 300), // Kenku hoy 4:30 p. m.
    order("K", "2026-10-25T17:00:00Z", 40, { cancelled_at: "2026-10-25T18:00:00Z" }),
  ];

  it("sale de los pedidos de ayer y hoy, por cuarto de hora, con el punto de ayer a esta hora en su línea", () => {
    const data = buildDayPulse([AURELA, KENKU], rows, FLOORS, NOW);
    expect(data.periodo).toBe("hoy");
    expect(data.total.actual).toEqual({ pedidos: 2, ingresos: 400 });
    expect(data.total.anterior).toEqual({ pedidos: 2, ingresos: 100 });
    expect(data.total.cancelados).toEqual({ pedidos: 1, ingresos: 40 });
    expect(data.curva).toMatchObject({ unidad: "minuto", largo: 1440, ahora: AHORA, corte: AHORA, slotAhora: 67 });
    expect(data.curva.actual).toHaveLength(69);
    expect(data.curva.actual.at(-1)).toEqual({ x: AHORA, pedidos: 2, ingresos: 400 });
    expect(data.curva.anterior).toHaveLength(CURVE_POINTS + 1);
    const corte = data.curva.anterior.findIndex((p) => p.x === AHORA);
    expect(data.curva.anterior[corte]).toEqual({ x: AHORA, pedidos: 2, ingresos: 100 });
    expect(data.curva.anterior[corte - 1]!.pedidos).toBe(1);
    expect(data.curva.slots).toHaveLength(CURVE_POINTS);
    expect(data.curva.slots[68]!.actual).toBeNull();
  });

  it("en el borde del cuarto de hora, el punto de ayer a esta hora reemplaza al del borde", () => {
    const data = buildDayPulse([AURELA], [order("A", "2026-10-24T21:45:00Z", 20)], FLOORS, new Date("2026-10-25T21:45:00Z"));
    expect(data.curva.anterior).toHaveLength(CURVE_POINTS);
    expect(data.curva.anterior.find((p) => p.x === 1005)).toEqual({ x: 1005, pedidos: 1, ingresos: 20 });
  });

  it("una tienda que recién tiene sus ventas en Kapta no se compara con ayer", () => {
    const data = buildDayPulse([AURELA], rows, new Map([["A", "2026-10-25"]]), NOW);
    expect(data.comparable).toBe(false);
    expect(data.curva.slots.every((s) => s.anterior === null)).toBe(true);
  });
});

describe("el bloque", () => {
  const render = (initial: Parameters<typeof SalesPulseCard>[0]["initial"]) =>
    renderToStaticMarkup(createElement(SalesPulseCard, { initial, currency: "PEN" }));

  it("tres pestañas; entra en Hoy, con el corte y contra qué compara", () => {
    const html = render(
      buildDayPulse(
        [AURELA, KENKU],
        [order("A", "2026-10-25T15:00:00Z", 100), order("A", "2026-10-24T14:00:00Z", 80), order("K", "2026-10-25T21:30:00Z", 300)],
        FLOORS,
        NOW,
      ),
    );
    expect(html).toContain("Cómo van las ventas");
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Hoy</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Esta semana</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Este mes</);
    expect(html).toContain("Domingo 25 de octubre · al corte 4:52 p. m. · contra ayer a esta hora");
    expect(html).toContain("Ventas acumuladas del día");
    expect(html).toContain("S/\u00a0400"); // el símbolo no queda solo al final del renglón
    expect(html).toContain("ayer a esta hora no había"); // Kenku
  });

  it("la semana dice sus días, compara con la semana pasada y cuenta los cancelados sin monto", () => {
    const data = buildPeriodPulse([AURELA, KENKU], "semana", [day("A", "2026-10-19", 10, 1000, 3), day("A", "2026-10-12", 8, 800)], [], FLOORS, NOW);
    const html = render(data);
    expect(html).toContain("Del 19 al 25 de octubre · al corte 4:52 p. m. · contra la semana pasada a esta altura");
    expect(html).toMatch(/aria-selected="true"[^>]*>Esta semana</);
    expect(html).toContain("Ventas acumuladas de la semana");
    expect(html).toContain("vs semana pasada");
    expect(html).toContain("Semana pasada");
    expect(html).toContain("3 pedidos de esta semana ya están cancelados: no cuentan en estas cifras.");
  });

  it("el mes compara con el mes anterior por su nombre, o entero si no tiene el día", () => {
    const octubre = render(buildPeriodPulse([AURELA], "mes", [day("A", "2026-10-02", 5, 500), day("A", "2026-09-02", 4, 400)], [], FLOORS, NOW));
    expect(octubre).toContain("Del 1 al 25 de octubre · al corte 4:52 p. m. · contra setiembre a esta altura");
    expect(octubre).toContain("Ventas acumuladas del mes");
    expect(octubre).toContain("vs setiembre");
    expect(octubre).toContain("Setiembre");
    const marzo = render(buildPeriodPulse([AURELA], "mes", [day("A", "2026-02-02", 4, 400)], [], OLD_FLOORS, new Date("2026-03-30T17:00:00Z")));
    expect(marzo).toContain("contra febrero completo");
  });

  it("sin con qué comparar, lo dice y no inventa un porcentaje", () => {
    const data = buildPeriodPulse([AURELA], "semana", [day("A", "2026-10-19", 10, 1000)], [], new Map([["A", "2026-10-13"]]), NOW);
    const html = render(data);
    expect(html).toContain("sin comparación: Kapta tiene todas las ventas de Aurela desde el 13 de octubre");
    expect(html).not.toContain("Semana pasada");
    expect(html).not.toContain(" %");
  });

  it("los textos no salen de Intl: Node y el navegador no ponen los mismos espacios y React rechaza la hidratación", () => {
    expect(read("components/sales-pulse.tsx")).not.toMatch(/new Intl\.|toLocale/);
  });
});

describe("el Consolidado", () => {
  it("entra en Hoy, arriba de la operación, sin seguir al periodo, y un fallo queda en su bloque", () => {
    const page = read("app/dashboard/page.tsx");
    expect(page).toContain('getSalesPulse(stores, "hoy")');
    expect(page.indexOf("today={")).toBeLessThan(page.indexOf("operations={"));
    expect(page).toContain("Las ventas de hoy no pudieron leerse");
    const dash = read("components/executive-dashboard.tsx");
    expect(dash.indexOf("{today}")).toBeLessThan(dash.indexOf("{operations}"));
  });

  it("la semana y el mes salen de ventas_por_origen y del día del corte; nada se cuenta a medias", () => {
    const access = read("lib/sales-pulse-access.ts");
    expect(access).toContain('sb.rpc("ventas_por_origen"');
    expect(access).toContain("no se cuentan a medias");
    expect(access).toContain("env.ordersSyncFrom()");
  });

  it("la ruta tiene las mismas puertas que la página", () => {
    const route = read("app/api/dashboard/pulso/route.ts");
    expect(route).toContain("parsePulsePeriod");
    expect(route).toContain("isVendedoraOnly");
    expect(route).toContain("isRiderOnly");
    expect(route).toContain("getAccessibleStores");
    expect(route).toContain('"Cache-Control": "no-store"');
  });
});
