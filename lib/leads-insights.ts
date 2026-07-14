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

import { chunk } from "@/lib/access";
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
  pedidosDetalle: { code: string | null; fecha: string | null }[]; // "#AUR1091" + "05/07/26"
}

/** One day of the team conversion chart: contactos (gestión calls) vs pedidos
 *  (won leads credited to their last-TOUCH day). Pedidos se atribuye por ÚLTIMO
 *  TOQUE (cualquier tipo), IGUAL que el panel de Productividad — así el "Hoy" del
 *  gráfico cuadra con la suma de pedidos por asesora (un cierre registrado sin
 *  llamada — "generar pedido" / cambio de estado — igual cuenta). contactos sigue
 *  contando solo kind="call". En un día muy flojo pedidos podría superar contactos;
 *  el gráfico recorta el relleno verde y topa el % a 100. */
export interface ConversionDay {
  dia: string; // weekday label, or "Hoy"
  contactos: number; // kind="call" calls that day
  pedidos: number; // distinct won leads whose last TOUCH (any kind) fell that day
}

/**
 * Team conversion per day. contactos = kind="call" calls; a won lead is credited
 * to the DAY of its last TOUCH (any kind) — the same last-touch attribution the
 * Productividad panel uses, so the chart's "Hoy" pedidos equals the sum of the
 * per-advisor pedidos (a sale closed without logging a call still counts). Pure so
 * it can be unit-tested. `calls` are all advisor (`vendedora` not null) lead_calls
 * in the window; `wonLeadIds` is the set of those leads currently won.
 */
export function computeTeamConversionByDay(opts: {
  calls: { lead_id: string; kind: string | null; occurred_at: string | null }[];
  wonLeadIds: Set<string>;
  days: { date: string; label: string }[];
  tz: string;
}): ConversionDay[] {
  const daySet = new Set(opts.days.map((d) => d.date));
  const contactosByDate: Record<string, number> = {};
  const lastTouchByLead: Record<string, string> = {}; // ANY kind → el pedido cae el día del ÚLTIMO TOQUE (igual que Productividad)
  for (const c of opts.calls) {
    if (!c.occurred_at) continue;
    if (c.kind === "call") {
      const d = tzParts(c.occurred_at, opts.tz).date;
      if (daySet.has(d)) contactosByDate[d] = (contactosByDate[d] ?? 0) + 1;
    }
    const prev = lastTouchByLead[c.lead_id];
    if (!prev || c.occurred_at > prev) lastTouchByLead[c.lead_id] = c.occurred_at;
  }
  const pedidosByDate: Record<string, number> = {};
  for (const [leadId, at] of Object.entries(lastTouchByLead)) {
    if (!opts.wonLeadIds.has(leadId)) continue;
    const d = tzParts(at, opts.tz).date;
    if (daySet.has(d)) pedidosByDate[d] = (pedidosByDate[d] ?? 0) + 1;
  }
  return opts.days.map((dd) => ({
    dia: dd.label,
    contactos: contactosByDate[dd.date] ?? 0,
    pedidos: pedidosByDate[dd.date] ?? 0,
  }));
}

/**
 * Fetch + compute the team conversion series, robust to PostgREST's `max-rows`
 * cap. PAGES the window's advisor calls (a `.limit()` alone is silently capped, so
 * a busy store would only get an arbitrary slice) and looks up the won flag for
 * ONLY the touched leads in chunks — never "all won leads in the store", which is
 * unbounded and was the truncation that collapsed the chart's pedidos. Best-effort.
 */
async function computeTeamConversion(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeId: string,
  sinceIso: string,
  days: { date: string; label: string }[],
  tz: string,
): Promise<ConversionDay[]> {
  const PAGE = 1000;
  const CAP = 40000; // absolute safety bound on a runaway store
  const calls: { lead_id: string; kind: string | null; occurred_at: string | null }[] = [];
  for (let from = 0; from < CAP; from += PAGE) {
    const { data, error } = await sb
      .from("lead_calls")
      .select("lead_id, kind, occurred_at")
      .eq("store_id", storeId)
      .not("vendedora", "is", null)
      .gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak so pages don't overlap/skip
      .range(from, from + PAGE - 1);
    if (error) break;
    const batch = (data as typeof calls) ?? [];
    calls.push(...batch);
    if (batch.length < PAGE) break;
  }
  // Won flag for the touched leads only (chunked .in — never "all won leads").
  const touchedIds = [...new Set(calls.map((c) => c.lead_id))];
  const wonLeadIds = new Set<string>();
  for (let i = 0; i < touchedIds.length; i += 300) {
    const { data } = await sb
      .from("leads")
      .select("id")
      .in("id", touchedIds.slice(i, i + 300))
      .eq("category", "won");
    for (const l of (data as { id: string }[]) ?? []) wonLeadIds.add(l.id);
  }
  return computeTeamConversionByDay({ calls, wonLeadIds, days, tz });
}

const PAGE_SIZE = 1000;
const PAGE_CAP = 20_000; // absolute safety bound per fetch (≈20 páginas)

type Sb = Awaited<ReturnType<typeof createServerSupabase>>;

/**
 * Drena una consulta PostgREST por páginas de `.range()`. Una sola llamada
 * devuelve como máximo ~1000 filas (max-rows) AUNQUE se pida `.limit(5000)`,
 * y el recorte es silencioso. El builder debe llevar un orden estable (id o
 * occurred_at+id) para que las páginas no se solapen ni salten filas.
 */
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < PAGE_CAP; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) break;
    const batch = (data as T[] | null) ?? [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Salidas de "Sin llamar" DENTRO de la ventana: la primera fila in-window de
 * lead_calls que movió el status del lead fuera de `nuevo`, descartando los
 * leads que ya tenían una gestión así ANTES de la ventana (su salida real fue
 * entonces; un re-toque posterior no recuenta). Equivale al viejo "primera
 * gestión de todo el historial" pero acotado para siempre: se pagina solo la
 * ventana y el pasado se consulta puntualmente (chunked) para los leads
 * tocados. Devuelve el occurred_at de cada salida.
 */
async function fetchQueueLeavers(sb: Sb, storeId: string, windowStartIso: string): Promise<string[]> {
  const rows = await pageAll<{ lead_id: string; occurred_at: string | null }>((from, to) =>
    sb
      .from("lead_calls")
      .select("lead_id, occurred_at")
      .eq("store_id", storeId)
      .not("new_status", "is", null)
      .neq("new_status", "nuevo")
      .gte("occurred_at", windowStartIso)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  const firstInWindow = new Map<string, string>(); // lead → su primera gestión in-window
  for (const r of rows) {
    if (r.occurred_at && !firstInWindow.has(r.lead_id)) firstInWindow.set(r.lead_id, r.occurred_at);
  }
  // Un lead con gestión previa a la ventana ya había salido de la cola: fuera.
  // Chunk corto (150) para que ni un lead muy re-tocado acerque la respuesta
  // del lookup al tope de filas.
  for (const part of chunk([...firstInWindow.keys()], 150)) {
    const { data } = await sb
      .from("lead_calls")
      .select("lead_id")
      .eq("store_id", storeId)
      .not("new_status", "is", null)
      .neq("new_status", "nuevo")
      .lt("occurred_at", windowStartIso)
      .in("lead_id", part);
    for (const r of (data as { lead_id: string }[]) ?? []) firstInWindow.delete(r.lead_id);
  }
  return [...firstInWindow.values()];
}

/** ISO → "dd/mm/aa" in the store's timezone (null-safe), for the pedidos tooltip. */
export function shortLocalDate(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  const d = tzParts(iso, tz).date; // YYYY-MM-DD
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
}

export interface LeadsInsights {
  burndown: BurndownPoint[];
  trend: TrendPoint[];
  saldoInicio: number; // saldo of the oldest day in the window (reference line)
  pendingNow: number;
  nowHourLabel: string; // e.g. "15h" — the "ahora" marker
  productivity: AdvisorToday[];
  conversion: ConversionDay[]; // contactos vs pedidos por día (equipo), últimos 7 días
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
  // Los tres se DRENAN por páginas (antes iban con .limit(5000/20000) en una
  // sola llamada y PostgREST recorta a ~1000 filas en silencio). El caso grave
  // era leavers: pedía TODO el historial ascendente, así que con >1000
  // gestiones históricas solo llegaban las más viejas y los días recientes
  // quedaban con cierran=0 — el saldo del trend se inflaba hacia atrás y el
  // burndown de hoy no bajaba nunca.
  const [entrantRows, leaverAts, sinLlamarRows] = await Promise.all([
    // "Entró" = first_seen_at (fecha REAL de primer contacto), no created_at — que
    // es cuándo se insertó la fila y por un backfill masivo puede caer todo el
    // mismo día (un pico falso). Caemos a created_at solo si first_seen es null.
    pageAll<{ created_at: string | null; first_seen_at: string | null }>((from, to) =>
      sb
        .from("leads")
        .select("created_at, first_seen_at")
        .eq("store_id", storeId)
        .or(`first_seen_at.gte.${windowStartIso},and(first_seen_at.is.null,created_at.gte.${windowStartIso})`)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // "Salió de Sin llamar" = primera gestión del lead dentro de la ventana,
    // excluyendo a los que ya habían salido antes (ver fetchQueueLeavers).
    fetchQueueLeavers(sb, storeId, windowStartIso),
    // "Sin llamar" = en cola (open/hot) y status `nuevo` (nunca lo gestionó un
    // asesor). Los agrupamos por fecha de última interacción para ver qué día
    // se está quedando gente sin llamar.
    pageAll<{ last_interaction_at: string | null; first_seen_at: string | null }>((from, to) =>
      sb
        .from("leads")
        .select("last_interaction_at, first_seen_at")
        .eq("store_id", storeId)
        .in("category", ["open", "hot"])
        .eq("status", "nuevo")
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const entranByDate: Record<string, number> = {};
  const entrantHours: number[] = []; // today only
  for (const r of entrantRows) {
    const arrived = r.first_seen_at ?? r.created_at;
    if (!arrived) continue;
    const p = tzParts(arrived, tz);
    entranByDate[p.date] = (entranByDate[p.date] ?? 0) + 1;
    if (p.date === todayDate) entrantHours.push(p.hour);
  }
  const cierranByDate: Record<string, number> = {};
  const leaverHours: number[] = [];
  for (const at of leaverAts) {
    const p = tzParts(at, tz);
    cierranByDate[p.date] = (cierranByDate[p.date] ?? 0) + 1;
    if (p.date === todayDate) leaverHours.push(p.hour);
  }

  // "Sin llamar" por día de última interacción (+ cuántos son de hace +7 días).
  const daySet = new Set(days.map((d) => d.date));
  const firstDay = days[0]!.date;
  const sinLlamarByDate: Record<string, number> = {};
  let sinLlamarOlder = 0;
  for (const r of sinLlamarRows) {
    const ts = r.last_interaction_at ?? r.first_seen_at;
    if (!ts) continue;
    const d = tzParts(ts, tz).date;
    if (daySet.has(d)) sinLlamarByDate[d] = (sinLlamarByDate[d] ?? 0) + 1;
    else if (d < firstDay) sinLlamarOlder += 1; // anterior a la ventana = leads viejos sin llamar
  }
  const sinLlamar = days.map((dd) => ({ dia: dd.label, count: sinLlamarByDate[dd.date] ?? 0 }));
  const sinLlamarTotal = sinLlamar.reduce((s, x) => s + x.count, 0) + sinLlamarOlder;

  // Conversión por día (equipo). Robusto al tope de filas de PostgREST: pagina las
  // llamadas de la ventana y consulta el estado "ganado" SOLO de los leads tocados
  // (acotado), en vez de traer TODOS los ganados de la tienda — que en tiendas con
  // mucho volumen se truncaba a un subconjunto y hundía los pedidos del gráfico.
  let conversion: ConversionDay[] = days.map((dd) => ({ dia: dd.label, contactos: 0, pedidos: 0 }));
  try {
    conversion = await computeTeamConversion(sb, storeId, windowStartIso, days, tz);
  } catch {
    /* best-effort — deja el gráfico en ceros si falla */
  }

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
        pedidosDetalle: r.cerradosDetalle.map((o) => ({ code: o.name, fecha: shortLocalDate(o.at, tz) })),
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
    conversion,
    sinLlamar,
    sinLlamarTotal,
    sinLlamarOlder,
  };
}
