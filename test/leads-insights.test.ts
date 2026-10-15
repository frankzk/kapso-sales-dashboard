import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { sinLlamarFromRollup } from "@/lib/leads-insights";
import { buildTeamToday, CIERRE_MIN_LEADS, dayWarnings, localMinutes, shortLocalDate } from "@/lib/leads-team-today";
import { emptyPorFuente, type AdvisorStat, type TeamTodayRaw } from "@/lib/productivity";
import { DEFAULT_SCHEDULE, type AdvisorSchedule, type DayActivity } from "@/lib/productivity-week";

const tz = "America/Lima";
// Jueves 15-10-2026, 18:42 en Lima (UTC−5).
const NOW = "2026-10-15T23:42:00Z";
const lima = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`).toISOString();

function stat(userId: string, over: Partial<AdvisorStat> = {}): AdvisorStat {
  return {
    userId,
    email: `${userId}@kapta.pe`,
    llamadas: 0,
    leadsTrabajados: 0,
    cerrados: 0,
    cerradosDetalle: [],
    ingresos: 0,
    porFuente: emptyPorFuente(),
    porTienda: {},
    conversion: 0,
    horas: 0,
    dias: 1,
    ...over,
  };
}

function raw(over: Partial<TeamTodayRaw> = {}): TeamTodayRaw {
  return {
    stats: [],
    activity: {},
    sales: { hoy: [], ayer: [], semana: [] },
    days: { hoy: "2026-10-15", ayer: "2026-10-14", semana: "2026-10-08", isoDow: 4 },
    ...over,
  };
}

const act = (horas: number, first: string, last: string): DayActivity => ({ date: "2026-10-15", horas, first, last });

describe("shortLocalDate (fecha corta del detalle de pedidos)", () => {
  it("formats an ISO as dd/mm/aa in the store's timezone", () => {
    // 2026-07-06 02:30Z = still 2026-07-05 in Lima (UTC−5)
    expect(shortLocalDate("2026-07-06T02:30:00Z", tz)).toBe("05/07/26");
    expect(shortLocalDate("2026-07-05T14:00:00Z", tz)).toBe("05/07/26");
  });
  it("null-safe", () => {
    expect(shortLocalDate(null, tz)).toBeNull();
    expect(shortLocalDate(undefined, tz)).toBeNull();
  });
});

describe("localMinutes", () => {
  it("cuenta desde la medianoche LOCAL de la tienda", () => {
    expect(localMinutes(NOW, tz)).toBe(18 * 60 + 42);
    expect(localMinutes("2026-10-16T04:59:00Z", tz)).toBe(23 * 60 + 59);
    expect(localMinutes("2026-10-16T05:00:00Z", tz)).toBe(0);
  });
});

describe("buildTeamToday: el equipo de hoy como ranking", () => {
  it("«vs. ayer» compara con lo que llevaba ayer A ESTA HORA, no con el día entero", () => {
    const team = buildTeamToday({
      raw: raw({
        stats: [stat("ana", { cerrados: 5, leadsTrabajados: 20 })],
        sales: {
          hoy: [],
          ayer: [
            { vendedora: "ana", occurredAt: lima("2026-10-14", "10:00") },
            { vendedora: "ana", occurredAt: lima("2026-10-14", "18:42") },
            { vendedora: "ana", occurredAt: lima("2026-10-14", "19:30") }, // después de esta hora: no cuenta
            { vendedora: "bea", occurredAt: lima("2026-10-14", "12:00") }, // hoy no aparece: cuenta en el equipo
          ],
          semana: [],
        },
      }),
      schedules: new Map(),
      tz,
      nowIso: NOW,
      viewerId: null,
      horasDeTodas: true,
    });
    expect(team.rows[0]!.pedidosAyer).toBe(2);
    expect(team.totals).toEqual({ pedidos: 5, pedidosAyer: 3, leads: 20, llamadas: 0 });
    expect(team.nowLabel).toBe("18:42");
  });

  it("ordena por pedidos y luego por leads; sin pedidos y con pocos leads va al pie", () => {
    const team = buildTeamToday({
      raw: raw({
        stats: [
          stat("poca", { leadsTrabajados: CIERRE_MIN_LEADS - 1 }),
          stat("trabaja", { leadsTrabajados: 40 }),
          stat("vende", { cerrados: 3, leadsTrabajados: 12 }),
          stat("uno", { cerrados: 1, leadsTrabajados: 1 }),
          stat("ordena"), // solo «Resuelto»: ni leads ni pedidos
        ],
      }),
      schedules: new Map(),
      tz,
      nowIso: NOW,
      viewerId: null,
      horasDeTodas: true,
    });
    expect(team.rows.map((r) => r.name)).toEqual(["vende", "uno", "trabaja"]);
    expect(team.quiet.map((r) => r.name)).toEqual(["poca"]);
    expect(team.totals.leads).toBe(CIERRE_MIN_LEADS - 1 + 40 + 12 + 1);
  });

  it("la meta del día es la de la semana entre sus días de trabajo, y 0 si hoy no le toca", () => {
    const schedules = new Map<string, AdvisorSchedule>([
      ["cinco", { weeklyHours: 40, days: [1, 2, 3, 4, 5], start: null, end: null }],
      ["libre", { weeklyHours: 24, days: [1, 2, 3], start: null, end: null }],
    ]);
    const team = buildTeamToday({
      raw: raw({
        stats: ["cinco", "libre", "defecto"].map((id) => stat(id, { leadsTrabajados: 20 })),
        activity: { cinco: act(8.4, "09:00", "18:30"), defecto: act(6, "10:00", "18:00") },
      }),
      schedules,
      tz,
      nowIso: NOW,
      viewerId: null,
      horasDeTodas: true,
    });
    const by = Object.fromEntries(team.rows.map((r) => [r.name, r]));
    expect(by.cinco).toMatchObject({ horas: 8.4, metaDia: 8 });
    expect(by.libre).toMatchObject({ horas: 0, metaDia: 0 });
    // Sin horario cargado: 48 h de lunes a sábado → 8 h.
    expect(by.defecto).toMatchObject({ horas: 6, metaDia: DEFAULT_SCHEDULE.weeklyHours / 6 });
    // «libre» no tiene meta hoy: no entra en la cuenta.
    expect(team.metaCumplida).toEqual({ cumplen: 1, de: 2 });
  });

  it("a una vendedora solo le llegan sus propias horas y avisos", () => {
    const schedules = new Map<string, AdvisorSchedule>([
      ["yo", { weeklyHours: 48, days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "20:00" }],
      ["otra", { weeklyHours: 48, days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "20:00" }],
    ]);
    const team = buildTeamToday({
      raw: raw({
        stats: [stat("yo", { cerrados: 2, leadsTrabajados: 15 }), stat("otra", { cerrados: 4, leadsTrabajados: 15 })],
        activity: { yo: act(7, "09:40", "18:30"), otra: act(8, "10:30", "17:00") },
      }),
      schedules,
      tz,
      nowIso: NOW,
      viewerId: "yo",
      horasDeTodas: false,
    });
    const by = Object.fromEntries(team.rows.map((r) => [r.name, r]));
    expect(by.yo).toMatchObject({ horas: 7, metaDia: 8, tardeMin: 40 });
    expect(by.otra).toMatchObject({ horas: null, metaDia: null, tardeMin: null, inactivaDesde: null, salioAntesMin: null });
    // Pedidos y leads siguen siendo de todo el equipo, como siempre en Leads.
    expect(by.otra!.pedidos).toBe(4);
    expect(team.metaCumplida).toBeNull();
  });

  it("la carrera acumula por hora; lo vendido antes de las 8:00 ya cuenta a las 8:00", () => {
    const team = buildTeamToday({
      raw: raw({
        sales: {
          hoy: [
            { vendedora: "ana", occurredAt: lima("2026-10-15", "07:30") },
            { vendedora: "ana", occurredAt: lima("2026-10-15", "09:15") },
            { vendedora: "ana", occurredAt: lima("2026-10-15", "18:10") },
          ],
          ayer: [
            { vendedora: "ana", occurredAt: lima("2026-10-14", "08:59") },
            { vendedora: "ana", occurredAt: lima("2026-10-14", "19:59") },
          ],
          semana: [{ vendedora: "ana", occurredAt: lima("2026-10-08", "12:00") }],
        },
      }),
      schedules: new Map(),
      tz,
      nowIso: NOW,
      viewerId: null,
      horasDeTodas: true,
    });
    const r = team.race;
    expect([r.from, r.to, r.now]).toEqual([8, 20, 18.7]);
    // De 8:00 a 18:00: 11 horas ya empezadas.
    expect(r.hoy).toEqual([1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(r.ayer).toHaveLength(13);
    expect(r.ayer[0]).toBe(0);
    expect(r.ayer[1]).toBe(1);
    expect(r.ayer[12]).toBe(2);
    expect([r.hoyNow, r.ayerNow, r.semanaNow]).toEqual([3, 1, 1]);
    expect(r.semanaLabel).toBe("el jueves pasado");
  });

  it("pasadas las 20:00 el eje se estira hasta la hora de ahora", () => {
    const team = buildTeamToday({
      raw: raw(),
      schedules: new Map(),
      tz,
      nowIso: lima("2026-10-15", "21:15"),
      viewerId: null,
      horasDeTodas: true,
    });
    expect(team.race.to).toBe(22);
    expect(team.race.ayer).toHaveLength(15);
    expect(team.race.hoy).toHaveLength(14);
  });
});

describe("dayWarnings: los avisos del día con las reglas de Productividad", () => {
  const horario: AdvisorSchedule = { weeklyHours: 48, days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" };
  const at = (h: number, m = 0) => h * 60 + m;

  it("«Tarde» pasada la gracia de 10 minutos", () => {
    expect(dayWarnings(act(5, "09:24", "15:00"), horario, true, at(15, 10)).tardeMin).toBe(24);
    expect(dayWarnings(act(5, "09:08", "15:00"), horario, true, at(15, 10)).tardeMin).toBeNull();
  });

  it("«Sin actividad desde» dentro del horario, con más de 45 min sin nada", () => {
    expect(dayWarnings(act(5, "09:00", "15:00"), horario, true, at(16)).inactivaDesde).toBe("15:00");
    expect(dayWarnings(act(5, "09:00", "15:00"), horario, true, at(15, 40)).inactivaDesde).toBeNull();
    // Antes de su entrada no se le pide nada.
    expect(dayWarnings(act(0.2, "07:00", "07:10"), horario, true, at(8, 30)).inactivaDesde).toBeNull();
  });

  it("ya pasada la salida, «Salió antes» si la última fue más de 10 min antes", () => {
    const w = dayWarnings(act(7, "09:00", "16:42"), horario, true, at(18, 30));
    expect(w).toEqual({ tardeMin: null, inactivaDesde: null, salioAntesMin: 78 });
    expect(dayWarnings(act(8.8, "09:00", "17:55"), horario, true, at(18, 30)).salioAntesMin).toBeNull();
  });

  it("sin horario cargado, o un día que no le toca, no se juzga nada", () => {
    const none = { tardeMin: null, inactivaDesde: null, salioAntesMin: null };
    expect(dayWarnings(act(2, "11:00", "12:00"), DEFAULT_SCHEDULE, true, at(16))).toEqual(none);
    expect(dayWarnings(act(2, "11:00", "12:00"), horario, false, at(16))).toEqual(none);
    expect(dayWarnings(undefined, horario, true, at(16))).toEqual(none);
  });
});

describe("sinLlamarFromRollup: de las filas agrupadas en la base al gráfico", () => {
  // El RPC devuelve una fila por día en vez de las ~17.000 filas que se
  // drenaban por carga (28 M al día, medido el 10-09-2026). Desde la 0263 solo
  // trae `sin_llamar`; con la versión de la 0155 los otros cubos se ignoran.
  it("toma solo el cubo sin_llamar y suma por día", () => {
    expect(
      sinLlamarFromRollup([
        { bucket: "sin_llamar", key: "2026-08-01", n: 40 },
        { bucket: "sin_llamar", key: "2026-09-10", n: "7" },
        { bucket: "entran", key: "2026-09-10", n: 12 },
        { bucket: "pedidos", key: "2026-09-10", n: 4 },
      ]),
    ).toEqual({ "2026-08-01": 40, "2026-09-10": 7 });
  });

  it("ignora conteos no numéricos o en cero", () => {
    expect(
      sinLlamarFromRollup([
        { bucket: "sin_llamar", key: "2026-09-10", n: "x" },
        { bucket: "sin_llamar", key: "2026-09-11", n: 0 },
      ]),
    ).toEqual({});
  });
});

describe("el panel pregunta primero al RPC y la SQL dice lo mismo que el código", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("loadSinLlamar llama a lead_insights_rollup y solo drena si no existe", () => {
    const src = read("lib/leads-insights.ts");
    const start = src.indexOf("async function loadSinLlamar(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const rpc = body.indexOf('sb.rpc("lead_insights_rollup", {');
    const drain = body.indexOf("await drainSinLlamar(");
    expect(rpc).toBeGreaterThan(-1);
    expect(rpc).toBeLessThan(drain);
    expect(body).toContain("if (!rollup.error && Array.isArray(rollup.data))");
  });

  it("el componente del navegador no importa valores del módulo con la lectura", () => {
    // lib/leads-insights.ts carga el cliente de servicio (horarios, 0245): el
    // tablero solo puede tomar de él tipos; los valores, del módulo puro.
    const src = read("components/leads-insights.tsx");
    expect(src).toContain('import type { LeadsInsights } from "@/lib/leads-insights";');
    expect(src).not.toMatch(/import \{[^}]*\} from "@\/lib\/leads-insights"/);
    expect(read("lib/leads-team-today.ts")).not.toMatch(/from "@\/lib\/(db|access|advisor-schedules|metrics)"/);
  });

  it("el predicado de sin llamar del RPC vigente (0263) es el mismo que el del drenado", () => {
    // Si divergen, el panel dice una cosa con el RPC y otra sin él.
    const src = read("lib/leads-insights.ts");
    expect(src).toContain('.in("category", ["open", "hot"])\n      .eq("status", "nuevo")');
    for (const file of ["0155_lead_insights_rollup.sql", "0263_lead_insights_rollup_sin_llamar.sql"]) {
      const sql = read(`db/migrations/${file}`);
      expect(sql).toContain("and category in ('open', 'hot')\n      and status = 'nuevo'");
      expect(sql).toContain("coalesce(last_interaction_at, first_seen_at)");
      expect(sql).toContain("security invoker");
      expect(sql).toContain("revoke all on function public.lead_insights_rollup");
    }
  });

  it("la 0263 conserva la firma y deja solo el cubo sin_llamar", () => {
    // La misma firma: el código que ya corre la llama igual, con la versión que
    // encuentre. Y nada del tablero anterior: ni gestiones ni ventas.
    const sql = read("db/migrations/0263_lead_insights_rollup_sin_llamar.sql");
    const fn = sql.slice(sql.indexOf("create or replace function public.lead_insights_rollup("));
    expect(fn).toContain("p_store_ids    uuid[],\n  p_window_start timestamptz,\n  p_tz           text,\n  p_today        text");
    expect(fn).toContain("returns table (bucket text, key text, n bigint)");
    expect(fn).not.toMatch(/lead_calls|order_sales|'entran|'cierran|'contactos|'pedidos/);
    expect(fn).toContain("select 'sin_llamar', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)");
  });
});
