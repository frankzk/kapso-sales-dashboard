import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildBurndown,
  buildTrend,
  shortLocalDate,
  computeTeamConversionByDay,
  SHIFT_START,
  SHIFT_END,
  rollupToInputs,
} from "@/lib/leads-insights";

describe("computeTeamConversionByDay (conversión por día del equipo)", () => {
  const days = [
    { date: "2026-07-08", label: "Mié" },
    { date: "2026-07-09", label: "Hoy" },
  ];
  const tz = "America/Lima";
  const at = (date: string) => `${date}T17:00:00Z`; // 12:00 Lima (UTC−5) → mismo día local

  it("cuenta kind='call' como contactos y las ventas registradas como pedidos", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-08") },
      { lead_id: "B", kind: "call", occurred_at: at("2026-07-09") },
      { lead_id: "C", kind: "call", occurred_at: at("2026-07-09") },
    ];
    const sales = [{ occurredAt: at("2026-07-08") }, { occurredAt: at("2026-07-09") }];
    expect(computeTeamConversionByDay({ calls, sales, days, tz })).toEqual([
      { dia: "Mié", contactos: 1, pedidos: 1 },
      { dia: "Hoy", contactos: 2, pedidos: 1 },
    ]);
  });

  it("varias llamadas al mismo lead = varios contactos, y el pedido cae donde está la venta", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-08") },
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-09") },
    ];
    expect(computeTeamConversionByDay({ calls, sales: [{ occurredAt: at("2026-07-09") }], days, tz })).toEqual([
      { dia: "Mié", contactos: 1, pedidos: 0 },
      { dia: "Hoy", contactos: 1, pedidos: 1 },
    ]);
  });

  it("un toque posterior NO arrastra el pedido a otro día — antes reabrir un lead lo movía", () => {
    // La venta se registró el 08. El 09 alguien vuelve a tocar el lead: con la
    // atribución vieja el pedido se mudaba al 09 y descuadraba con Productividad.
    const calls = [
      { lead_id: "A", kind: "message", occurred_at: at("2026-07-08") },
      { lead_id: "A", kind: "state_change", occurred_at: at("2026-07-09") },
    ];
    expect(computeTeamConversionByDay({ calls, sales: [{ occurredAt: at("2026-07-08") }], days, tz })).toEqual([
      { dia: "Mié", contactos: 0, pedidos: 1 },
      { dia: "Hoy", contactos: 0, pedidos: 0 },
    ]);
  });

  it("una venta sin ninguna llamada registrada igual cuenta (0 contactos · 1 pedido)", () => {
    expect(
      computeTeamConversionByDay({ calls: [], sales: [{ occurredAt: at("2026-07-09") }], days, tz }),
    ).toEqual([
      { dia: "Mié", contactos: 0, pedidos: 0 },
      { dia: "Hoy", contactos: 0, pedidos: 1 },
    ]);
  });

  it("ignora toques y ventas fuera de la ventana o sin timestamp", () => {
    const calls = [
      { lead_id: "A", kind: "call", occurred_at: at("2026-07-01") }, // fuera de la ventana
      { lead_id: "B", kind: "call", occurred_at: null },
    ];
    const sales = [{ occurredAt: at("2026-07-01") }, { occurredAt: null }];
    expect(computeTeamConversionByDay({ calls, sales, days, tz })).toEqual([
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

describe("rollupToInputs: de las filas agrupadas en la base a los constructores", () => {
  // La 0155 devuelve una fila por (cubo, día) o (cubo, hora) en vez de las
  // ~17.000 filas que se drenaban por carga (28 M al día, medido el 10-09-2026).
  it("reparte cada cubo en su mapa y expande las horas al histograma que espera buildBurndown", () => {
    const r = rollupToInputs([
      { bucket: "entran", key: "2026-09-10", n: 12 },
      { bucket: "entran", key: "2026-09-09", n: "7" },
      { bucket: "entran_hora", key: "9", n: 2 },
      { bucket: "entran_hora", key: "15", n: 1 },
      { bucket: "cierran", key: "2026-09-10", n: 5 },
      { bucket: "cierran_hora", key: "10", n: 3 },
      { bucket: "sin_llamar", key: "2026-08-01", n: 40 },
      { bucket: "contactos", key: "2026-09-10", n: 30 },
      { bucket: "pedidos", key: "2026-09-10", n: 4 },
    ]);
    expect(r.entranByDate).toEqual({ "2026-09-10": 12, "2026-09-09": 7 });
    expect(r.entrantHours.sort((a, b) => a - b)).toEqual([9, 9, 15]);
    expect(r.cierranByDate).toEqual({ "2026-09-10": 5 });
    expect(r.leaverHours).toEqual([10, 10, 10]);
    expect(r.sinLlamarByDate).toEqual({ "2026-08-01": 40 });
    expect(r.contactosByDate).toEqual({ "2026-09-10": 30 });
    expect(r.pedidosByDate).toEqual({ "2026-09-10": 4 });
  });

  it("ignora cubos desconocidos, conteos no numéricos y horas ilegibles", () => {
    const r = rollupToInputs([
      { bucket: "otro", key: "2026-09-10", n: 5 },
      { bucket: "entran", key: "2026-09-10", n: "x" },
      { bucket: "entran_hora", key: "hoy", n: 2 },
      { bucket: "entran_hora", key: "3", n: 0 },
    ]);
    expect(r.entranByDate).toEqual({});
    expect(r.entrantHours).toEqual([]);
  });
});

describe("el panel pregunta primero al RPC y la SQL dice lo mismo que el código", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("getLeadsInsights llama a lead_insights_rollup y solo drena si no existe", () => {
    const src = read("lib/leads-insights.ts");
    const start = src.indexOf("export async function getLeadsInsights(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const rpc = body.indexOf('sb.rpc("lead_insights_rollup", {');
    const drain = body.indexOf("await drainInputs(");
    expect(rpc).toBeGreaterThan(-1);
    expect(rpc).toBeLessThan(drain);
    expect(body).toContain("if (!rollup.error && Array.isArray(rollup.data))");
  });

  it("los predicados de la 0155 son los mismos que los del drenado", () => {
    // Si divergen, el panel dice una cosa con el RPC y otra sin él.
    const sql = read("db/migrations/0155_lead_insights_rollup.sql");
    expect(sql).toContain("first_seen_at >= p_window_start");
    expect(sql).toContain("or (first_seen_at is null and created_at >= p_window_start)");
    expect(sql).toContain("and new_status is not null\n      and new_status <> 'nuevo'");
    expect(sql).toContain("c.lead_id = f.lead_id and c.occurred_at < p_window_start");
    expect(sql).toContain("and category in ('open', 'hot')\n      and status = 'nuevo'");
    expect(sql).toContain("and vendedora is not null\n      and kind = 'call'");
    expect(sql).toContain("from public.order_sales");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("revoke all on function public.lead_insights_rollup");
  });
});
