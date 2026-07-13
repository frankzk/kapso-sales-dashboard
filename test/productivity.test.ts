import { describe, it, expect } from "vitest";
import {
  HEAT_END,
  HEAT_START,
  attachDeltas,
  computeAdvisorConversionByDay,
  computeAdvisorStats,
  computeHourlyActivity,
  emptyPorFuente,
  isWonLead,
  localDayPreset,
  localPresetRange,
  localRangeBoundsIso,
  storeInitials,
  type AdvisorCall,
  type AdvisorStat,
} from "@/lib/productivity";

describe("isWonLead (a close requires the lead's OWN disposition, not has_order)", () => {
  it("true only for category='won'", () => {
    expect(isWonLead("won")).toBe(true);
  });
  it("false for a lead dispositioned lost — even though has_order can still be true", () => {
    // The reported bug: a lead the advisor marked "ya compró en otro lado" (lost)
    // still has has_order=true from an unrelated linked order. Must not count.
    expect(isWonLead("lost")).toBe(false);
  });
  it("false for open/hot/null/undefined", () => {
    expect(isWonLead("open")).toBe(false);
    expect(isWonLead("hot")).toBe(false);
    expect(isWonLead(null)).toBe(false);
    expect(isWonLead(undefined)).toBe(false);
  });
});

describe("localRangeBoundsIso (today = the STORE's local day, not a UTC day)", () => {
  it("maps a Lima (UTC−5) local day to its true UTC bounds", () => {
    const { startIso, endIso } = localRangeBoundsIso("2026-06-29", "2026-06-29", "America/Lima");
    // Lima 2026-06-29 00:00 = 05:00Z ; end = next day 04:59:59.999Z
    expect(startIso).toBe("2026-06-29T05:00:00.000Z");
    expect(endIso).toBe("2026-06-30T04:59:59.999Z");
  });

  it("UTC tz is the plain calendar day", () => {
    const { startIso, endIso } = localRangeBoundsIso("2026-06-29", "2026-06-29", "UTC");
    expect(startIso).toBe("2026-06-29T00:00:00.000Z");
    expect(endIso).toBe("2026-06-29T23:59:59.999Z");
  });
});

describe("computeAdvisorStats (per-advisor productivity)", () => {
  const emailById = new Map([
    ["u1", "ale@aurela.pe"],
    ["u2", "gaby@aurela.pe"],
  ]);

  it("aggregates activity and credits a win to the LAST caller", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T11:00:00Z" },
      { vendedora: "u2", lead_id: "L1", kind: "call", occurred_at: "2026-06-21T09:00:00Z" }, // later touch on L1
      { vendedora: "u2", lead_id: "L3", kind: "note", occurred_at: "2026-06-21T10:00:00Z" }, // not a "call"
    ];
    const leadOutcome = new Map([
      ["L1", { won: true, net: 189 }], // last caller = u2
      ["L2", { won: false, net: 0 }],
      ["L3", { won: true, net: 99 }], // last caller = u2
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    const u2 = rows.find((r) => r.userId === "u2")!;

    expect(u1.llamadas).toBe(2);
    expect(u1.leadsTrabajados).toBe(2); // L1, L2
    expect(u1.cerrados).toBe(0); // L1 went to u2 (later touch); L2 not won
    expect(u1.ingresos).toBe(0);

    expect(u2.llamadas).toBe(1); // only kind="call"; the note doesn't count
    expect(u2.leadsTrabajados).toBe(2); // L1, L3
    expect(u2.cerrados).toBe(2); // L1 (last touch) + L3
    expect(u2.ingresos).toBe(288); // 189 + 99
    expect(u2.conversion).toBe(1); // 2 / 2
    expect(u2.email).toBe("gaby@aurela.pe");
  });

  it("collects the won orders' code+date per advisor (cerradosDetalle, oldest first)", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-07-05T10:00:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-07-05T11:00:00Z" },
      { vendedora: "u1", lead_id: "L3", kind: "call", occurred_at: "2026-07-05T12:00:00Z" },
      { vendedora: "u2", lead_id: "L4", kind: "call", occurred_at: "2026-07-05T13:00:00Z" },
    ];
    const leadOutcome = new Map([
      // L1's order is NEWER than L2's → the detail must come out chronological (L2's first).
      ["L1", { won: true, net: 189, orderName: "#AUR1091", orderAt: "2026-07-05T14:00:00Z" }],
      ["L2", { won: true, net: 99, orderName: "#AUR1088", orderAt: "2026-07-05T09:00:00Z" }],
      // Won but the order isn't ingested/linked yet → placeholder entry, sorted last.
      ["L3", { won: true, net: 0 }],
      ["L4", { won: false, net: 0 }],
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    const u2 = rows.find((r) => r.userId === "u2")!;

    expect(u1.cerrados).toBe(3);
    expect(u1.cerradosDetalle).toEqual([
      { name: "#AUR1088", at: "2026-07-05T09:00:00Z" },
      { name: "#AUR1091", at: "2026-07-05T14:00:00Z" },
      { name: null, at: null },
    ]);
    expect(u2.cerrados).toBe(0);
    expect(u2.cerradosDetalle).toEqual([]); // no wins → empty detail
  });

  it("splits an advisor's wins by acquisition source (porFuente), defaulting missing to organic", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-07-05T10:00:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-07-05T11:00:00Z" },
      { vendedora: "u1", lead_id: "L3", kind: "call", occurred_at: "2026-07-05T12:00:00Z" },
      { vendedora: "u1", lead_id: "L4", kind: "call", occurred_at: "2026-07-05T13:00:00Z" }, // won, no source → organic
      { vendedora: "u1", lead_id: "L5", kind: "call", occurred_at: "2026-07-05T14:00:00Z" }, // not won → ignored
    ];
    const leadOutcome = new Map<string, { won: boolean; net: number; source?: "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" }>([
      ["L1", { won: true, net: 100, source: "meta_ad" }],
      ["L2", { won: true, net: 50, source: "cod_cart" }],
      ["L3", { won: true, net: 30, source: "meta_ad" }], // second ad sale → aggregates
      ["L4", { won: true, net: 20 }], // no source → organic bucket
      ["L5", { won: false, net: 999, source: "abandoned_browse" }], // not won → not counted
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    expect(u1.cerrados).toBe(4);
    expect(u1.porFuente.meta_ad).toEqual({ cerrados: 2, ingresos: 130 });
    expect(u1.porFuente.cod_cart).toEqual({ cerrados: 1, ingresos: 50 });
    expect(u1.porFuente.organic).toEqual({ cerrados: 1, ingresos: 20 });
    expect(u1.porFuente.abandoned_browse).toEqual({ cerrados: 0, ingresos: 0 }); // L5 not won
    // Per-source cerrados sum to the total.
    const sum = Object.values(u1.porFuente).reduce((a, c) => a + c.cerrados, 0);
    expect(sum).toBe(u1.cerrados);
  });

  it("infers active hours by local day, splitting blocks on idle gaps >45min", () => {
    const calls: AdvisorCall[] = [
      // Day 1 (Lima 2026-06-20): one block 09:00→10:00 = 1h
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T14:00:00Z" },
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T14:30:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T15:00:00Z" },
      // …then a 2h idle gap → new block 12:00→12:30 = 0.5h
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T17:00:00Z" },
      { vendedora: "u1", lead_id: "L3", kind: "call", occurred_at: "2026-06-20T17:30:00Z" },
      // Day 2 (Lima 2026-06-21): a single action → 0h but still a worked day
      { vendedora: "u1", lead_id: "L4", kind: "call", occurred_at: "2026-06-21T15:00:00Z" },
    ];
    const leadOutcome = new Map([
      ["L1", { won: false, net: 0 }],
      ["L2", { won: false, net: 0 }],
      ["L3", { won: false, net: 0 }],
      ["L4", { won: false, net: 0 }],
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    expect(u1.horas).toBeCloseTo(1.5); // 1h + 0.5h; the day-2 singleton adds 0
    expect(u1.dias).toBe(2);
  });

  it("attachDeltas computes per-advisor deltas, flags newcomers, and rolls up prev totals", () => {
    const mk = (o: Partial<AdvisorStat> & { userId: string }): AdvisorStat => ({
      email: o.userId,
      llamadas: 0,
      leadsTrabajados: 0,
      cerrados: 0,
      cerradosDetalle: [],
      ingresos: 0,
      porFuente: emptyPorFuente(),
      porTienda: {},
      conversion: 0,
      horas: 0,
      dias: 0,
      ...o,
    });
    const cur = [
      mk({ userId: "u1", llamadas: 10, leadsTrabajados: 8, cerrados: 5, ingresos: 1200, conversion: 0.625 }),
      mk({ userId: "u2", llamadas: 4, leadsTrabajados: 4, cerrados: 1, ingresos: 200, conversion: 0.25 }), // new
    ];
    const prev = [
      mk({ userId: "u1", llamadas: 8, leadsTrabajados: 6, cerrados: 3, ingresos: 900, conversion: 0.5 }),
      mk({ userId: "u3", llamadas: 2, leadsTrabajados: 2, cerrados: 0, ingresos: 0, conversion: 0 }), // dropped
    ];
    const { rows, prevTotals } = attachDeltas(cur, prev);

    const u1 = rows.find((r) => r.userId === "u1")!;
    expect(u1.delta).toMatchObject({ llamadas: 2, cerrados: 2, ingresos: 300, isNew: false });
    expect(u1.delta.conversionPP).toBeCloseTo(12.5); // 62.5% − 50%

    const u2 = rows.find((r) => r.userId === "u2")!;
    expect(u2.delta.isNew).toBe(true); // no baseline last period
    expect(u2.delta.ingresos).toBe(200); // vs 0

    // prev totals include the dropped advisor (u3), not the current-only one (u2)
    expect(prevTotals).toMatchObject({ llamadas: 10, leadsTrabajados: 8, cerrados: 3, ingresos: 900 });
  });

  it("sorts by revenue desc and ignores calls without a vendedora", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "u2", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "", lead_id: "L3", kind: "system", occurred_at: "2026-06-20T10:00:00Z" },
    ];
    const leadOutcome = new Map([
      ["L1", { won: true, net: 50 }],
      ["L2", { won: true, net: 500 }],
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    expect(rows.map((r) => r.userId)).toEqual(["u2", "u1"]); // u2 has more revenue first
    expect(rows).toHaveLength(2); // the empty-vendedora system row is skipped
  });

  it("desglosa los cierres por tienda (porTienda) según el store del lead ganado", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T11:00:00Z" },
      { vendedora: "u1", lead_id: "L3", kind: "call", occurred_at: "2026-06-20T12:00:00Z" }, // no ganado
    ];
    const leadOutcome = new Map([
      ["L1", { won: true, net: 100, storeId: "aurela" }],
      ["L2", { won: true, net: 250, storeId: "kenku" }],
      ["L3", { won: false, net: 0, storeId: "kenku" }],
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    expect(u1.porTienda).toEqual({
      aurela: { cerrados: 1, ingresos: 100 },
      kenku: { cerrados: 1, ingresos: 250 },
    });
  });
});

describe("storeInitials (sigla de tienda para los chips)", () => {
  it("multi-palabra → iniciales; una palabra → 3 primeras letras", () => {
    expect(storeInitials("Kenku Peru")).toBe("KP");
    expect(storeInitials("Aurela")).toBe("AUR");
    expect(storeInitials("Mi Tienda Genial")).toBe("MTG");
  });
  it("null-safe", () => {
    expect(storeInitials(null)).toBe("?");
    expect(storeInitials("  ")).toBe("?");
  });
});

describe("computeHourlyActivity (heatmap: leads DISTINTOS gestionados por hora local)", () => {
  const cells = HEAT_END - HEAT_START + 1; // 13

  it("bucketiza por hora LOCAL de Lima (UTC−5) contando leads distintos", () => {
    const { byAgent, mode } = computeHourlyActivity({
      events: [
        { agent: "u1", occurred_at: "2026-07-09T14:00:00Z", ref: "L1" }, // 09h Lima
        { agent: "u1", occurred_at: "2026-07-09T14:30:00Z", ref: "L2" }, // 09h Lima
        { agent: "u1", occurred_at: "2026-07-10T01:00:00Z", ref: "L3" }, // 20h Lima del 09/07
      ],
      tz: "America/Lima",
      rangeDays: 1,
    });
    expect(mode).toBe("day");
    expect(byAgent.u1).toHaveLength(cells);
    expect(byAgent.u1![9 - HEAT_START]).toBe(2); // 09h: 2 leads distintos
    expect(byAgent.u1![20 - HEAT_START]).toBe(1); // 20h
  });

  it("el MISMO lead tocado varias veces en una hora cuenta 1 (anti-busywork); en horas distintas cuenta en cada una", () => {
    const { byAgent } = computeHourlyActivity({
      events: [
        { agent: "u1", occurred_at: "2026-07-09T14:00:00Z", ref: "L1" }, // 09h
        { agent: "u1", occurred_at: "2026-07-09T14:20:00Z", ref: "L1" }, // 09h, mismo lead
        { agent: "u1", occurred_at: "2026-07-09T14:40:00Z", ref: "L1" }, // 09h, mismo lead
        { agent: "u1", occurred_at: "2026-07-09T16:00:00Z", ref: "L1" }, // 11h, mismo lead → cuenta aparte
      ],
      tz: "America/Lima",
      rangeDays: 1,
    });
    expect(byAgent.u1![9 - HEAT_START]).toBe(1);
    expect(byAgent.u1![11 - HEAT_START]).toBe(1);
  });

  it("descarta horas fuera del turno 08–20 (no las pliega a los bordes)", () => {
    const { byAgent, max } = computeHourlyActivity({
      events: [
        { agent: "u1", occurred_at: "2026-07-09T11:00:00Z", ref: "L1" }, // 06h Lima → fuera
        { agent: "u1", occurred_at: "2026-07-10T03:00:00Z", ref: "L2" }, // 22h Lima → fuera
        { agent: null, occurred_at: "2026-07-09T15:00:00Z", ref: "L3" }, // sin agente → fuera
        { agent: "u1", occurred_at: null, ref: "L4" }, // sin timestamp → fuera
      ],
      tz: "America/Lima",
      rangeDays: 1,
    });
    expect(byAgent.u1 ?? new Array(cells).fill(0)).toEqual(new Array(cells).fill(0));
    expect(max).toBe(1); // piso 1 para que la escala nunca divida por 0
  });

  it("multi-día → 'avg' de distintos POR DÍA (el mismo lead cada día cuenta 1 por día); max global entre asesoras", () => {
    const events = [
      // u1: el MISMO lead gestionado a las 10h Lima (15:00Z) los 7 días
      ...Array.from({ length: 7 }, (_, i) => ({
        agent: "u1",
        occurred_at: `2026-07-0${i + 1}T15:00:00Z`,
        ref: "A",
      })),
      { agent: "u2", occurred_at: "2026-07-01T15:00:00Z", ref: "B" },
    ];
    const { byAgent, max, mode } = computeHourlyActivity({ events, tz: "America/Lima", rangeDays: 7 });
    expect(mode).toBe("avg");
    expect(byAgent.u1![10 - HEAT_START]).toBe(1); // 1 distinto/día × 7 días / 7 = 1
    expect(byAgent.u2![10 - HEAT_START]).toBeCloseTo(0.1); // 1/7 ≈ 0.1 (redondeado)
    expect(max).toBe(1);
  });
});

describe("computeAdvisorConversionByDay (sparkline: contactos y pedidos por día)", () => {
  const days = [
    { date: "2026-07-08", label: "Mié" },
    { date: "2026-07-09", label: "Hoy" },
  ];
  const tz = "America/Lima";
  const at = (date: string, h = 17) => `${date}T${String(h).padStart(2, "0")}:00:00Z`; // 12:00 Lima

  it("contactos = kind 'call' de la PROPIA asesora por día local", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "A", kind: "call", occurred_at: at("2026-07-08") },
      { vendedora: "u1", lead_id: "B", kind: "message", occurred_at: at("2026-07-08") }, // no cuenta
      { vendedora: "u2", lead_id: "C", kind: "call", occurred_at: at("2026-07-09") },
    ];
    const s = computeAdvisorConversionByDay({ calls, wonLeadIds: new Set(), days, tz });
    expect(s.u1!.map((c) => c.contactos)).toEqual([1, 0]);
    expect(s.u2!.map((c) => c.contactos)).toEqual([0, 1]);
  });

  it("el pedido va a la asesora del ÚLTIMO toque global (cualquier kind), en su día", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "A", kind: "call", occurred_at: at("2026-07-08", 15) },
      // u2 toca después con un MENSAJE → se lleva el pedido el 09 (no suma contactos)
      { vendedora: "u2", lead_id: "A", kind: "message", occurred_at: at("2026-07-09", 15) },
    ];
    const s = computeAdvisorConversionByDay({ calls, wonLeadIds: new Set(["A"]), days, tz });
    expect(s.u1!.map((c) => c.pedidos)).toEqual([0, 0]);
    expect(s.u2!.map((c) => c.pedidos)).toEqual([0, 1]);
    expect(s.u2!.map((c) => c.contactos)).toEqual([0, 0]);
  });

  it("siempre devuelve una celda por día (ceros incluidos) y ignora días fuera de la ventana", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "A", kind: "call", occurred_at: at("2026-07-01") }, // fuera
      { vendedora: "u1", lead_id: "B", kind: "call", occurred_at: at("2026-07-09") },
    ];
    const s = computeAdvisorConversionByDay({ calls, wonLeadIds: new Set(["A"]), days, tz });
    expect(s.u1).toEqual([
      { date: "2026-07-08", label: "Mié", contactos: 0, pedidos: 0 },
      { date: "2026-07-09", label: "Hoy", contactos: 1, pedidos: 0 },
    ]);
  });
});

describe("presets de rango en día LOCAL de la tienda", () => {
  it("a las 20:30 de Lima, 'Hoy' sigue siendo el día local (no el UTC siguiente)", () => {
    // 2026-07-13T01:30Z = 2026-07-12 20:30 en Lima
    expect(localDayPreset(0, "America/Lima", "2026-07-13T01:30:00Z")).toEqual({
      from: "2026-07-12",
      to: "2026-07-12",
    });
    expect(localDayPreset(1, "America/Lima", "2026-07-13T01:30:00Z")).toEqual({
      from: "2026-07-11",
      to: "2026-07-11",
    });
  });

  it("localPresetRange termina hoy local e incluye N días", () => {
    expect(localPresetRange(7, "America/Lima", "2026-07-13T01:30:00Z")).toEqual({
      from: "2026-07-06",
      to: "2026-07-12",
    });
  });

  it("en UTC coincide con el día calendario", () => {
    expect(localDayPreset(0, "UTC", "2026-07-13T01:30:00Z")).toEqual({ from: "2026-07-13", to: "2026-07-13" });
  });
});
