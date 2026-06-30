// Dashboard insights for the Leads page: today's "Sin llamar" burndown, the
// 7-day sin-llamar flow, and today's per-advisor productivity.
//
// Everything is RECONSTRUCTED from existing timestamps — no snapshot job:
//   • a lead ENTERS "Sin llamar" when it's created (status `nuevo`) ≈ `first_seen_at`;
//   • a lead LEAVES "Sin llamar" at its FIRST gestión — the earliest `lead_calls`
//     row that moved its status off `nuevo` (`occurred_at`); re-touches don't recount;
//   • the current backlog (`pendingNow` = "Sin llamar" count) is the anchor.
// Walking those flows back from the anchor yields REAL history from day one.
// RLS-scoped.

import { createServerSupabase } from "@/lib/db";
import { tzParts } from "@/lib/metrics";
import { getAdvisorProductivity } from "@/lib/productivity";

export const SHIFT_START = 8;
export const SHIFT_END = 20;

export interface BurndownPoint {
  h: string; // "08h".."20h"
  real: number | null; // backlog reconstructed up to each past hour (null in the future)
  ritmo: number; // ideal straight line from the day's initial backlog to 0 at SHIFT_END
  proy: number | null; // projection at the current clearing pace (null before "ahora")
}

export interface TrendPoint {
  dia: string; // weekday label, or "Hoy"
  saldo: number; // backlog at end of day
  entran: number; // leads created that day
  cierran: number; // leads that left the queue that day
}

export interface AdvisorToday {
  name: string;
  contactos: number; // calls logged today
  pedidos: number; // wins attributed today (last-touch)
}

export interface LeadsInsights {
  burndown: BurndownPoint[];
  trend: TrendPoint[];
  saldoInicio: number; // saldo of the oldest day in the window (reference line)
  pendingNow: number;
  nowHourLabel: string; // e.g. "15h" — the "ahora" marker
  productivity: AdvisorToday[];
  sinLlamar: { dia: string; count: number }[]; // sin-gestión leads por día de última interacción
  sinLlamarTotal: number; // total sin llamar (incl. older than the window)
  sinLlamarOlder: number; // sin llamar cuya última interacción fue hace +7 días (la alarma)
}

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}h`;
}

const clampHour = (h: number): number => Math.min(SHIFT_END, Math.max(SHIFT_START, h));

/**
 * Today's burndown from the day's entrants/leavers (by local hour) + the current
 * backlog. Pure. `real(h)` = backlog at h:00 = now − (entered since h) + (left
 * since h). `ritmo` is the ideal line to 0; `proy` extrapolates the pace so far.
 */
export function buildBurndown(opts: {
  pendingNow: number;
  nowHour: number;
  entrantHours: number[]; // local hour (0..23) of each lead created today
  leaverHours: number[]; // local hour of each lead that left the queue today
}): BurndownPoint[] {
  const { pendingNow, entrantHours, leaverHours } = opts;
  const nowHour = clampHour(opts.nowHour);
  const since = (hours: number[], h: number) => hours.reduce((n, x) => (x >= h ? n + 1 : n), 0);
  const real = (h: number) => pendingNow - since(entrantHours, h) + since(leaverHours, h);
  const inicial = real(SHIFT_START);
  const current = real(nowHour);
  const pace = (inicial - current) / Math.max(1, nowHour - SHIFT_START); // net cierres/h so far
  const span = SHIFT_END - SHIFT_START;
  const points: BurndownPoint[] = [];
  for (let h = SHIFT_START; h <= SHIFT_END; h++) {
    points.push({
      h: hourLabel(h),
      real: h <= nowHour ? Math.max(0, Math.round(real(h))) : null,
      ritmo: Math.max(0, Math.round((inicial * (SHIFT_END - h)) / span)),
      proy: h >= nowHour ? Math.max(0, Math.round(current - pace * (h - nowHour))) : null,
    });
  }
  return points;
}

/**
 * 7-day flow + saldo. Walks the saldo back from the current backlog using the
 * identity saldo(d-1) = saldo(d) − entran(d) + cierran(d). Pure.
 */
export function buildTrend(opts: {
  days: { date: string; label: string }[]; // oldest → newest (today last)
  pendingNow: number;
  entranByDate: Record<string, number>;
  cierranByDate: Record<string, number>;
}): { trend: TrendPoint[]; saldoInicio: number } {
  const { days, pendingNow, entranByDate, cierranByDate } = opts;
  const saldo: Record<string, number> = {};
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!.date;
    if (i === days.length - 1) {
      saldo[d] = pendingNow;
    } else {
      const next = days[i + 1]!.date;
      saldo[d] = saldo[next]! - (entranByDate[next] ?? 0) + (cierranByDate[next] ?? 0);
    }
  }
  const trend: TrendPoint[] = days.map((dd) => ({
    dia: dd.label,
    saldo: Math.max(0, Math.round(saldo[dd.date]!)),
    entran: entranByDate[dd.date] ?? 0,
    cierran: cierranByDate[dd.date] ?? 0,
  }));
  return { trend, saldoInicio: trend[0]?.saldo ?? 0 };
}

/**
 * Assemble the Leads dashboard insights for one store. `pendingNow` is the
 * current "por llamar" count (already computed by the page, passed in as the
 * anchor). RLS-scoped reads; productivity is best-effort.
 */
export async function getLeadsInsights(
  storeId: string,
  tz: string,
  pendingNow: number,
): Promise<LeadsInsights> {
  const sb = await createServerSupabase();
  const nowMs = Date.now();
  const now = tzParts(new Date(nowMs).toISOString(), tz);
  const todayDate = now.date;

  // The last 7 local dates (today back 6 days), with weekday labels.
  const days: { date: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const p = tzParts(new Date(nowMs - i * 86_400_000).toISOString(), tz);
    days.push({ date: p.date, label: i === 0 ? "Hoy" : (WEEKDAYS[p.weekday] ?? p.date.slice(5)) });
  }
  const windowStartIso = new Date(nowMs - 7 * 86_400_000).toISOString();

  // Entrants (entraron a "Sin llamar" = se crearon, status nuevo) + leavers
  // (dejaron "Sin llamar" = primera gestión) + el universo actual sin llamar.
  const [entrantsRes, leaversRes, sinLlamarRes] = await Promise.all([
    // "Entró" = first_seen_at (fecha REAL de primer contacto), no created_at — que
    // es cuándo se insertó la fila y por un backfill masivo puede caer todo el
    // mismo día (un pico falso). Caemos a created_at solo si first_seen es null.
    sb
      .from("leads")
      .select("created_at, first_seen_at")
      .eq("store_id", storeId)
      .or(`first_seen_at.gte.${windowStartIso},and(first_seen_at.is.null,created_at.gte.${windowStartIso})`)
      .limit(5000),
    // "Salió de Sin llamar" = la PRIMERA gestión del lead: la fila de lead_calls
    // más temprana que cambió su status a algo distinto de `nuevo` (una llamada
    // con disposición o un pedido directo). Pedimos asc → la primera fila por lead
    // es su salida real; re-toques posteriores (seguimiento) no recuentan. Más
    // preciso que last_interaction_at. El tope cubre todo el historial de estas
    // tiendas con holgura.
    sb
      .from("lead_calls")
      .select("lead_id, occurred_at")
      .eq("store_id", storeId)
      .not("new_status", "is", null)
      .neq("new_status", "nuevo")
      .order("occurred_at", { ascending: true })
      .limit(20000),
    // "Sin llamar" = en cola (open/hot) y status `nuevo` (nunca lo gestionó un
    // asesor). Los agrupamos por fecha de última interacción para ver qué día
    // se está quedando gente sin llamar.
    sb
      .from("leads")
      .select("last_interaction_at, first_seen_at")
      .eq("store_id", storeId)
      .in("category", ["open", "hot"])
      .eq("status", "nuevo")
      .limit(5000),
  ]);

  const entranByDate: Record<string, number> = {};
  const entrantHours: number[] = []; // today only
  for (const r of (entrantsRes.data as { created_at: string | null; first_seen_at: string | null }[]) ?? []) {
    const arrived = r.first_seen_at ?? r.created_at;
    if (!arrived) continue;
    const p = tzParts(arrived, tz);
    entranByDate[p.date] = (entranByDate[p.date] ?? 0) + 1;
    if (p.date === todayDate) entrantHours.push(p.hour);
  }
  const cierranByDate: Record<string, number> = {};
  const leaverHours: number[] = [];
  const seenLeaver = new Set<string>(); // primera salida por lead (asc → la más temprana)
  for (const r of (leaversRes.data as { lead_id: string; occurred_at: string | null }[]) ?? []) {
    if (!r.occurred_at || seenLeaver.has(r.lead_id)) continue;
    seenLeaver.add(r.lead_id);
    const p = tzParts(r.occurred_at, tz);
    cierranByDate[p.date] = (cierranByDate[p.date] ?? 0) + 1; // fuera de la ventana: los consumidores no lo leen
    if (p.date === todayDate) leaverHours.push(p.hour);
  }

  // "Sin llamar" por día de última interacción (+ cuántos son de hace +7 días).
  const daySet = new Set(days.map((d) => d.date));
  const firstDay = days[0]!.date;
  const sinLlamarByDate: Record<string, number> = {};
  let sinLlamarOlder = 0;
  for (const r of (sinLlamarRes.data as { last_interaction_at: string | null; first_seen_at: string | null }[]) ??
    []) {
    const ts = r.last_interaction_at ?? r.first_seen_at;
    if (!ts) continue;
    const d = tzParts(ts, tz).date;
    if (daySet.has(d)) sinLlamarByDate[d] = (sinLlamarByDate[d] ?? 0) + 1;
    else if (d < firstDay) sinLlamarOlder += 1; // anterior a la ventana = leads viejos sin llamar
  }
  const sinLlamar = days.map((dd) => ({ dia: dd.label, count: sinLlamarByDate[dd.date] ?? 0 }));
  const sinLlamarTotal = sinLlamar.reduce((s, x) => s + x.count, 0) + sinLlamarOlder;

  const burndown = buildBurndown({ pendingNow, nowHour: now.hour, entrantHours, leaverHours });
  const { trend, saldoInicio } = buildTrend({ days, pendingNow, entranByDate, cierranByDate });

  // Today's per-advisor productivity — reuses the Productividad aggregation
  // (RLS-scoped, team-visible, resolves names). contactos = calls; pedidos =
  // wins attributed by last-touch. Best-effort: never block the board.
  let productivity: AdvisorToday[] = [];
  try {
    const rows = await getAdvisorProductivity([storeId], { from: todayDate, to: todayDate }, null, tz);
    productivity = rows
      .map((r) => ({
        name: r.email.includes("@") ? r.email.split("@")[0]! : r.email,
        contactos: r.llamadas,
        pedidos: r.cerrados,
      }))
      .filter((r) => r.contactos > 0 || r.pedidos > 0)
      .sort((a, b) => b.pedidos - a.pedidos || b.contactos - a.contactos);
  } catch {
    /* best-effort */
  }

  return {
    burndown,
    trend,
    saldoInicio,
    pendingNow,
    nowHourLabel: hourLabel(clampHour(now.hour)),
    productivity,
    sinLlamar,
    sinLlamarTotal,
    sinLlamarOlder,
  };
}
