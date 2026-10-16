// LTV : CPA (MOM §17, 13-10-2026). La escala del dueño, la conversión de
// dólares, cuándo un horizonte ya se puede leer y lo que se muestra primero.
// Las sumas por clienta las prueba scripts/sql/ltv_cohorts_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  USD_TO_PEN,
  buildCohorts,
  formatRatio,
  horizonState,
  monthLabel,
  ratioZone,
  spendInCurrency,
  storeHeadline,
  type CohortRow,
  type SpendRow,
} from "@/lib/ltv";

const row = (month: string, newCustomers: number, lastFirstAt: string, values: number[], repeat90 = 0, storeId = "s1"): CohortRow => ({
  storeId,
  month,
  newCustomers,
  lastFirstAt,
  values: { 30: values[0]!, 60: values[1]!, 90: values[2]!, 180: values[3]!, 365: values[4]! },
  repeat90,
});

describe("la escala del dueño", () => {
  it("menos de 3 pierde caja, 3 a 3.5 estable, 3.5 a 4 gana cuota, más de 4 dominio", () => {
    expect(ratioZone(2.99).key).toBe("pierde");
    expect(ratioZone(3).key).toBe("estable");
    expect(ratioZone(3.49).key).toBe("estable");
    expect(ratioZone(3.5).key).toBe("gana");
    expect(ratioZone(4).key).toBe("gana");
    expect(ratioZone(4.01).key).toBe("domina");
  });
});

describe("el gasto en la moneda de la tienda", () => {
  const rows: SpendRow[] = [
    { storeId: "s1", month: "2026-06-01", currency: "PEN", spend: 100 },
    { storeId: "s1", month: "2026-06-01", currency: "usd", spend: 10 },
  ];

  it("los dólares a 3.75, como fijó el dueño", () => {
    expect(USD_TO_PEN).toBe(3.75);
    expect(spendInCurrency(rows, "PEN")).toEqual({ amount: 137.5, unknown: [] });
    expect(spendInCurrency(rows, "USD").amount).toBeCloseTo(100 / 3.75 + 10);
  });

  it("una moneda que no se sabe convertir no se suma: se avisa", () => {
    expect(spendInCurrency([...rows, { storeId: "s1", month: "2026-06-01", currency: "EUR", spend: 50 }], "PEN")).toEqual({
      amount: 137.5,
      unknown: ["EUR"],
    });
  });
});

describe("cuándo se puede leer un horizonte", () => {
  const last = "2026-06-30T12:00:00Z";
  it("abierto hasta que la última clienta del mes cumple los días", () => {
    expect(horizonState(last, 30, new Date("2026-07-30T11:00:00Z"))).toBe("abierto");
  });
  it("provisional las tres semanas siguientes, mientras se entregan los últimos pedidos", () => {
    expect(horizonState(last, 30, new Date("2026-07-30T13:00:00Z"))).toBe("provisional");
    expect(horizonState(last, 30, new Date("2026-08-20T11:00:00Z"))).toBe("provisional");
  });
  it("cerrado después", () => {
    expect(horizonState(last, 30, new Date("2026-08-20T13:00:00Z"))).toBe("cerrado");
  });
});

describe("los meses de cada tienda", () => {
  const today = new Date("2026-10-13T12:00:00Z");
  const cohorts = [
    row("2026-06-01", 100, "2026-06-30T12:00:00Z", [17000, 18000, 19000, 19000, 19000], 14),
    row("2026-09-01", 50, "2026-09-30T12:00:00Z", [9000, 9000, 9000, 9000, 9000]),
    row("2026-10-01", 10, "2026-10-12T12:00:00Z", [1500, 1500, 1500, 1500, 1500]),
  ];
  const spend: SpendRow[] = [
    { storeId: "s1", month: "2026-06-01", currency: "PEN", spend: 4000 },
    { storeId: "s1", month: "2026-06-01", currency: "USD", spend: 200 },
    { storeId: "s1", month: "2026-09-01", currency: "PEN", spend: 3000 },
    { storeId: "s1", month: "2026-10-01", currency: "PEN", spend: 2000 },
  ];
  const views = buildCohorts(cohorts, spend, { s1: "PEN" }, today);

  it("del más reciente al más antiguo", () => {
    expect(views.map((v) => v.month)).toEqual(["2026-10-01", "2026-09-01", "2026-06-01"]);
  });

  it("CPA = gasto convertido ÷ clientas nuevas; ratio = valor ÷ gasto", () => {
    const june = views.find((v) => v.month === "2026-06-01")!;
    expect(june.spend).toBe(4750);
    expect(june.cpa).toBeCloseTo(47.5);
    expect(june.cells[30].ratio).toBeCloseTo(17000 / 4750);
    expect(june.cells[30].ltv).toBe(170);
    expect(june.cells[90].ratio).toBeCloseTo(19000 / 4750);
    expect(june.cells[180]).toEqual({ state: "abierto", ltv: null, ratio: null });
    // 30-06 + 90 días = 28-09: al 13-10 todavía se están entregando pedidos de esos días.
    expect(june.repeat90).toEqual({ share: 0.14, state: "provisional" });
    expect(june.cpaProvisional).toBe(false);
  });

  it("un mes sin gasto tiene valor por clienta pero no ratio", () => {
    const october = buildCohorts([row("2026-07-01", 4, "2026-07-31T12:00:00Z", [400, 400, 400, 400, 400])], [], { s1: "PEN" }, today)[0]!;
    expect(october.cpa).toBeNull();
    expect(october.cells[30]).toEqual({ state: "cerrado", ltv: 100, ratio: null });
  });

  it("arriba: el último mes con 30 días leíbles, el CPA del que aún no los cumple y lo que la recompra sumó", () => {
    const headline = storeHeadline(views);
    // Septiembre aún no cumple 30 días (su última clienta nueva es del 30-09):
    // su ratio no se lee, pero su CPA sí, provisional.
    expect(headline.latest).toMatchObject({ month: "2026-06-01", state: "cerrado" });
    expect(headline.latest!.ratio).toBeCloseTo(17000 / 4750);
    expect(headline.current).toEqual({ month: "2026-09-01", cpa: 60, provisional: true });
    // Octubre está en curso: su CPA (S/ 200 con 10 clientas entregadas) sale
    // inflado y no es «el mes actual» del resumen.
    const october = views.find((v) => v.month === "2026-10-01")!;
    expect(october.inProgress).toBe(true);
    expect(views.find((v) => v.month === "2026-09-01")!.inProgress).toBe(false);
    expect(headline.longest).toMatchObject({ month: "2026-06-01", horizon: 90 });
    expect(headline.longest!.from30).toBeCloseTo(17000 / 4750);
    expect(headline.longest!.ratio).toBeCloseTo(4);
  });
});

describe("cómo se lee", () => {
  it("mes en palabras y ratio con dos decimales", () => {
    // En Perú se escribe «setiembre».
    expect(monthLabel("2026-09-01")).toBe("setiembre de 2026");
    expect(formatRatio(3.5612)).toBe("3.56");
  });

  it("Consolidado lo carga sin tumbar el resto si falla", () => {
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    expect(page).toContain("<LtvCpaLoader");
    expect(page).toContain("LTV : CPA no pudo calcularse ahora.");
  });
});

describe("MOM §17.2", () => {
  it("documenta la escala, el cambio y cuándo se lee", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("### 17.2 LTV : CPA (13-10-2026)");
    expect(mom).toContain("se convierten a S/ 3.75");
    expect(mom).toContain("El mes en curso no da CPA");
  });
});
