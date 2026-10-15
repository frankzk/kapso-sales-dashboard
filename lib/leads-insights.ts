// El «Tablero de hoy» de Leads (opción K, Frankz 15-10-2026):
//
//   • el equipo de hoy como ranking: pedidos, la diferencia contra ayer a esta
//     misma hora, el % de cierre, las horas activas contra la meta del día y
//     las llamadas;
//   • los leads sin llamar, por día de su última interacción (se filtran);
//   • la carrera de pedidos del día contra ayer y contra el mismo día de la
//     semana pasada.
//
// Nada se guarda aparte. El trabajo y las horas salen de las gestiones del día
// con las MISMAS cuentas que Productividad (lib/productivity.ts y
// lib/productivity-week.ts), los pedidos de `order_sales` y los sin llamar del
// RPC `lead_insights_rollup` (0155, aligerado en la 0263). RLS como el resto; la meta y el horario
// (0245) se leen con el cliente de servicio y a una vendedora solo le llegan
// los suyos, como en Productividad.

import { getAccessibleStores, getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { getAdvisorSchedules } from "@/lib/advisor-schedules";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { tzParts } from "@/lib/metrics";
import { getTeamToday } from "@/lib/productivity";
import type { AdvisorSchedule } from "@/lib/productivity-week";
import { buildTeamToday, type TeamToday } from "@/lib/leads-team-today";
import type { StoreScope } from "@/lib/leads-access";

export interface LeadsInsights {
  /** El equipo de hoy; null si no se pudo leer (el resto del tablero sigue). */
  team: TeamToday | null;
  sinLlamar: { date: string; dia: string; count: number }[]; // sin-gestión leads por día de última interacción
  sinLlamarTotal: number; // total sin llamar (incl. older than the window)
  sinLlamarOlder: number; // sin llamar cuya última interacción fue hace +7 días (la alarma)
  sinLlamarOlderBefore: string; // límite exclusivo del bucket +7d
}

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/** Una fila del RPC `lead_insights_rollup`: cubo, día, conteo. Desde la 0263 solo
 *  devuelve el cubo `sin_llamar`; la 0155 devolvía siete. */
export interface RollupRow {
  bucket: string;
  key: string;
  n: number | string;
}

/**
 * De las filas agrupadas en la base, los leads sin llamar por día de su última
 * interacción. Pura. Filtra el cubo a propósito: si la base todavía tuviera
 * la versión de la 0155, sus otros seis cubos (del tablero anterior) se ignoran.
 */
export function sinLlamarFromRollup(rows: readonly RollupRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.bucket !== "sin_llamar") continue;
    const n = Number(r.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[r.key] = (out[r.key] ?? 0) + n;
  }
  return out;
}

type Sb = Awaited<ReturnType<typeof createServerSupabase>>;

const PAGE_SIZE = 1000;
const PAGE_CAP = 20_000; // absolute safety bound per fetch (≈20 páginas)

/**
 * Los mismos sin llamar, drenando filas (el camino de antes). Queda como
 * respaldo para una base sin el RPC (0155): el panel sigue saliendo, solo
 * que caro. Una sola llamada devuelve como máximo ~1000 filas (max-rows) y el
 * recorte es silencioso: se pagina con un orden estable.
 */
async function drainSinLlamar(sb: Sb, storeIds: StoreScope, tz: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let from = 0; from < PAGE_CAP; from += PAGE_SIZE) {
    const { data, error } = await sb
      .from("leads")
      .select("last_interaction_at, first_seen_at")
      .in("store_id", storeIds)
      .in("category", ["open", "hot"])
      .eq("status", "nuevo")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) break;
    const batch = (data as { last_interaction_at: string | null; first_seen_at: string | null }[] | null) ?? [];
    for (const r of batch) {
      const ts = r.last_interaction_at ?? r.first_seen_at;
      if (!ts) continue;
      const d = tzParts(ts, tz).date;
      out[d] = (out[d] ?? 0) + 1;
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Sin llamar por día de última interacción. LOS CONTEOS SE AGRUPAN EN LA BASE
 * (RPC `lead_insights_rollup`, 0155): una fila por día en vez de las ~17.000
 * que se drenaban por carga (medido el 10-09-2026: 28 millones de filas al día
 * solo de este panel). La 0263 le quitó los cubos del tablero anterior, que
 * seguían costando: 162 ms → 15 ms por llamada (15-10-2026). El drenado queda
 * como respaldo si el RPC no existe todavía.
 */
async function loadSinLlamar(
  sb: Sb,
  storeIds: StoreScope,
  windowStartIso: string,
  tz: string,
  todayDate: string,
): Promise<Record<string, number>> {
  const rollup = await sb.rpc("lead_insights_rollup", {
    p_store_ids: storeIds,
    p_window_start: windowStartIso,
    p_tz: tz,
    p_today: todayDate,
  });
  if (!rollup.error && Array.isArray(rollup.data)) {
    return sinLlamarFromRollup(rollup.data as RollupRow[]);
  }
  return await drainSinLlamar(sb, storeIds, tz);
}

/**
 * El equipo de hoy con lo que quien mira puede ver. Las horas son de la
 * persona (todas sus tiendas, como la semana de Productividad); a una
 * vendedora solo le llegan las suyas: al navegador no viaja la jornada de
 * nadie más.
 */
async function loadTeamToday(storeIds: StoreScope, tz: string, nowIso: string): Promise<TeamToday> {
  const [stores, role, user] = await Promise.all([getAccessibleStores(), getUserRoleSummary(), getCurrentUser()]);
  const horasDeTodas = !role.isVendedoraOnly;
  // Las organizaciones de todas sus tiendas, como Productividad: el horario es
  // de la persona y vale el mismo se mire la tienda que se mire.
  const orgIds = [...new Set(stores.map((s) => s.org_id))];
  const [raw, schedules] = await Promise.all([
    getTeamToday(
      storeIds,
      stores.map((s) => s.id),
      tz,
      nowIso,
    ),
    getAdvisorSchedules(createAdminSupabase(), orgIds).catch(() => new Map<string, AdvisorSchedule>()),
  ]);
  return buildTeamToday({ raw, schedules, tz, nowIso, viewerId: user?.id ?? null, horasDeTodas });
}

/**
 * Assemble the Leads dashboard for the stores in scope. RLS-scoped reads; the
 * team is best-effort: if it fails, «Sin llamar» still shows.
 */
export async function getLeadsInsights(storeIds: StoreScope, tz: string): Promise<LeadsInsights> {
  const sb = await createServerSupabase();
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const todayDate = tzParts(nowIso, tz).date;

  // The last 7 local dates (today back 6 days), with weekday labels.
  const days: { date: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const p = tzParts(new Date(nowMs - i * 86_400_000).toISOString(), tz);
    days.push({ date: p.date, label: i === 0 ? "Hoy" : (WEEKDAYS[p.weekday] ?? p.date.slice(5)) });
  }
  const windowStartIso = new Date(nowMs - 7 * 86_400_000).toISOString();

  const [sinLlamarByDate, team] = await Promise.all([
    loadSinLlamar(sb, storeIds, windowStartIso, tz, todayDate),
    loadTeamToday(storeIds, tz, nowIso).catch(() => null),
  ]);

  // "Sin llamar" por día de última interacción (+ cuántos son de hace +7 días).
  const daySet = new Set(days.map((d) => d.date));
  const firstDay = days[0]!.date;
  let sinLlamarOlder = 0;
  for (const [d, n] of Object.entries(sinLlamarByDate)) {
    if (!daySet.has(d) && d < firstDay) sinLlamarOlder += n; // anterior a la ventana = leads viejos sin llamar
  }
  const sinLlamar = days.map((dd) => ({
    date: dd.date,
    dia: dd.label,
    count: sinLlamarByDate[dd.date] ?? 0,
  }));
  const sinLlamarTotal = sinLlamar.reduce((s, x) => s + x.count, 0) + sinLlamarOlder;

  return { team, sinLlamar, sinLlamarTotal, sinLlamarOlder, sinLlamarOlderBefore: firstDay };
}
