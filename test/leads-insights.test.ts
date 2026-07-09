import { describe, it, expect } from "vitest";
import {
  buildBurndown,
  buildTrend,
  shortLocalDate,
  computeTeamConversionByDay,
  SHIFT_START,
  SHIFT_END,
} from "@/lib/leads-insights";

describe("computeTeamConversionByDay (conversión por día del equipo)", () => {
  const days = [
    { date: "2026-07-08", label: "Mié" },
    { date: "2026-07-09", label: "Hoy" },
  ];
  const tz = "America/Lima";
  const at = (date: string) => `${date}T17:00:00Z`; // 12:00 Lima (UTC−5) → mismo día local

  it("cuenta kind='call' como contactos y leads ganados (último toque) como pedidos", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-08") }, // ganado → pedido el 08
      { lead_id: "B", kind: "call", occurred_at: at("2026-07-09") }, // no ganado
      { lead_id: "C", kind: "call", occurred_at: at("2026-07-09") }, // ganado → pedido el 09
    ];
    expect(computeTeamConversionByDay({ calls, wonLeadIds: new Set(["A", "C"]), days, tz })).toEqual([
      { dia: "Mié", contactos: 1, pedidos: 1 },
      { dia: "Hoy", contactos: 2, pedidos: 1 },
    ]);
  });

  it("atribuye el pedido al ÚLTIMO toque; varias llamadas = varios contactos, un pedido", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-08") },
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-09") }, // más reciente → pedido aquí
    ];
    expect(computeTeamConversionByDay({ calls, wonLeadIds: new Set(["A"]), days, tz })).toEqual([
      { dia: "Mié", contactos: 1, pedidos: 0 },
      { dia: "Hoy", contactos: 1, pedidos: 1 },
    ]);
  });

  it("un kind distinto de 'call' no cuenta ni como contacto ni para atribuir el pedido (se usa la última LLAMADA)", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-08") }, // última llamada → pedido el 08
      { lead_id: "A", kind: "state_change", occurred_at: at("2026-07-09") }, // toque posterior, se ignora
    ];
    expect(computeTeamConversionByDay({ calls, wonLeadIds: new Set(["A"]), days, tz })).toEqual([
      { dia: "Mié", contactos: 1, pedidos: 1 },
      { dia: "Hoy", contactos: 0, pedidos: 0 },
    ]);
  });

  it("ignora toques fuera de la ventana y sin timestamp", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-01") }, // fuera de la ventana
      { lead_id: "B", kind: "call", occurred_at: null },
    ];
    expect(computeTeamConversionByDay({ calls, wonLeadIds: new Set(["A", "B"]), days, tz })).toEqual([
      { dia: "Mié", contactos: 0, pedidos: 0 },
      { dia: "Hoy", contactos: 0, pedidos: 0 },
    ]);
  });
});

describe("shortLocalDate (fecha corta del tooltip de pedidos)", () => {
  it("formats an ISO as dd/mm/aa in the store's timezone", () => {
    // 2026-07-06 02:30Z = still 2026-07-05 in Lima (UTC−5)
    expect(shortLocalDate("2026-07-06T02:30:00Z", "America/Lima")).toBe("05/07/26");
    expect(shortLocalDate("2026-07-05T14:00:00Z", "America/Lima")).toBe("05/07/26");
  });
  it("null-safe", () => {
    expect(shortLocalDate(null, "America/Lima")).toBeNull();
    expect(shortLocalDate(undefined, "America/Lima")).toBeNull();
  });
});

describe("buildTrend (saldo walked back from the current backlog)", () => {
  it("reconstructs saldo via saldo(d-1) = saldo(d) − entran(d) + cierran(d)", () => {
    const days = [
      { date: "2026-06-27", label: "Sáb" },
      { date: "2026-06-28", label: "Dom" },
      { date: "2026-06-29", label: "Hoy" },
    ];
    const { trend, saldoInicio } = buildTrend({
      days,
      pendingNow: 100,
      entranByDate: { "2026-06-27": 10, "2026-06-28": 20, "2026-06-29": 30 },
      cierranByDate: { "2026-06-27": 5, "2026-06-28": 8, "2026-06-29": 12 },
    });
    // today's saldo is the anchor; walk back: 100 -30+12=82 ; 82 -20+8=70
    expect(trend.map((t) => t.saldo)).toEqual([70, 82, 100]);
    expect(trend.map((t) => t.entran)).toEqual([10, 20, 30]);
    expect(trend.map((t) => t.cierran)).toEqual([5, 8, 12]);
    expect(trend[2]!.dia).toBe("Hoy");
    expect(saldoInicio).toBe(70);
  });
});

describe("buildBurndown (today's backlog reconstructed by hour)", () => {
  it("real = now − entró-desde-h + salió-desde-h; ritmo→0; proy extends the pace", () => {
    // backlog now=10; 3 entered (9,10,11h), 1 left (10h) → started the day at 8.
    const pts = buildBurndown({
      pendingNow: 10,
      nowHour: 12,
      entrantHours: [9, 10, 11],
      leaverHours: [10],
    });
    expect(pts).toHaveLength(SHIFT_END - SHIFT_START + 1); // 08h..20h

    const at = (h: string) => pts.find((p) => p.h === h)!;
    expect(at("08h").real).toBe(8); // inicial
    expect(at("08h").ritmo).toBe(8); // ideal line starts at inicial
    expect(at("12h").real).toBe(10); // "ahora" = current backlog
    expect(at("12h").proy).toBe(10); // proy empalma con real en "ahora"

    const last = pts.at(-1)!;
    expect(last.h).toBe("20h");
    expect(last.real).toBeNull(); // future hours have no real
    expect(last.ritmo).toBe(0); // meta-0 at end of shift
    // backlog grew (net +2 over 4h ⇒ pace −0.5/h) ⇒ projection rises to ~14
    expect(last.proy).toBe(14);

    // hours after "ahora" carry the projection, not real
    expect(at("15h").real).toBeNull();
    expect(at("07h" as string)).toBeUndefined(); // shift starts at 08h
  });

  it("clamps before the shift and never goes negative", () => {
    const pts = buildBurndown({ pendingNow: 5, nowHour: 3, entrantHours: [], leaverHours: [] });
    // nowHour clamps to SHIFT_START → only 08h is 'real', rest projected/ideal
    expect(pts[0]!.real).toBe(5);
    expect(pts.every((p) => p.ritmo >= 0 && (p.real == null || p.real >= 0))).toBe(true);
  });
});
