"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, SidePanel, Skeleton } from "@/components/ops-ui";
import { categoryOf, labelOf, LEAD_SEGMENTS, type LeadSegment } from "@/lib/leads";
import { getOnlineAdvisorIds, loadAgentLeads } from "@/app/dashboard/productividad/actions";
import { RITMO_MIN_HORA, heatStatuses, ritmoPorHora, type HeatCellStatus } from "@/lib/heat";
import { SEGMENT_LABEL, SOURCE_LABEL } from "@/lib/productivity-labels";
import {
  daysLabel,
  dowShort,
  graceTimes,
  groupWeeks,
  PERIOD_DAYS_MAX,
  type AdvisorSchedule,
  type DayState,
  type PeriodWeek,
  type WeekDay,
  type WeekDayStatus,
  type WeekStatus,
} from "@/lib/productivity-week";
// Type-only import: pulling runtime values from lib/productivity would drag the
// whole server data layer (supabase clients) into this client bundle.
import type { AdvisorBoardRow, AgentLeadRow, SourceBucket, TrendCell } from "@/lib/productivity";

const ONLINE_POLL_MS = 45_000; // refresco de los puntos "en línea"

const nf = new Intl.NumberFormat("es-PE");
/** El separador de tramos: el «·» pegado a la palabra de antes (espacio duro),
 *  para que ningún renglón empiece por él (DESIGN.md). */
const SEP = "\u00a0· ";
const nf1 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 });

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

// Cifra y unidad van con espacio duro: un salto de línea nunca deja «min» o «%» solos.
function pct(x: number): string {
  return `${Math.round(x * 100)}\u00a0%`;
}

/** Copia local de formatMinutes (lib/productivity) — este archivo solo importa
 *  TIPOS de ese módulo para no arrastrar el data layer al bundle cliente. */
function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}\u00a0min`;
  if (min < 1440) return `${nf1.format(min / 60)}\u00a0h`;
  return `${nf1.format(min / 1440)}\u00a0d`;
}

/** Retrasos de la jornada en horas y minutos enteros: «24 min», «1 h 6 min», «2 h». */
function fmtDelay(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m}\u00a0min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}\u00a0h ${rest}\u00a0min` : `${h}\u00a0h`;
}

/** Tono de la 1ª gestión: verde ≤30 min · neutro ≤4 h · rojo más allá. */
function firstTouchTone(min: number | null): string {
  if (min == null) return "text-ink-300";
  if (min <= 30) return "text-ok-fg";
  if (min <= 240) return "text-ink-900";
  return "text-crit-fg";
}

/** Show the name part of the email (before @) as a friendlier label. */
function advisorName(email: string): string {
  return email.includes("@") ? email.split("@")[0]! : email;
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-PE", { day: "numeric", month: "short" });
}

/** El cambio contra el periodo anterior, con signo y en su tono. */
function Signed({ value, fmt, className }: { value: number; fmt: (n: number) => string; className?: string }) {
  const tone = value > 0 ? "text-ok-fg" : value < 0 ? "text-crit-fg" : "text-ink-500";
  return (
    <span className={cn("tabular-nums", tone, className)} title="Contra el periodo anterior">
      {value > 0 ? "+" : value < 0 ? "−" : ""}
      {fmt(Math.abs(value))}
    </span>
  );
}

// ── Actividad por hora ──────────────────────────────────────────────────────────

/** El tono de una celda a ritmo, en cuatro pasos de azul según cuánto se acerca
 *  al máximo del tablero; los dos más fuertes cambian el número a tinta o blanco
 *  para no bajar del contraste. */
function okStep(intensity: number): string {
  if (intensity >= 0.85) return "bg-brand-600 text-white";
  if (intensity >= 0.6) return "bg-brand-300 text-ink-900";
  if (intensity >= 0.35) return "bg-brand-100 text-brand-700";
  return "bg-brand-50 text-brand-700";
}

const HEAT_CELL: Record<Exclude<HeatCellStatus, "ok">, string> = {
  fuera: "bg-line",
  // La hora muerta lleva su «0» en rojo: sin número, junto al gris de fuera de
  // jornada, era la marca más pálida de la página y la que más importa.
  muerta: "bg-crit-bg text-crit-fg",
  bajo: "bg-warn-bg text-warn-fg",
};

/** Lo que dice la franja para quien no la ve: cuántas horas de cada tipo y el pico. */
function heatSummary(heat: number[], statuses: HeatCellStatus[], startHour: number): string {
  const n = (s: HeatCellStatus) => statuses.filter((x) => x === s).length;
  const ok = n("ok");
  const bajo = n("bajo");
  const muerta = n("muerta");
  if (!ok && !bajo && !muerta) return `Actividad por hora, de ${startHour} a ${startHour + heat.length - 1} h: sin actividad`;
  const peak = heat.reduce((best, v, i) => (v > heat[best]! ? i : best), 0);
  const horas = (k: number, what: string) => `${k} ${k === 1 ? "hora" : "horas"} ${what}`;
  const counts = [horas(ok, "a ritmo"), horas(bajo, "bajo ritmo"), horas(muerta, muerta === 1 ? "muerta" : "muertas")].join(", ");
  return `Actividad por hora, de ${startHour} a ${startHour + heat.length - 1} h: ${counts}; pico de ${nf1.format(heat[peak]!)} a las ${startHour + peak} h`;
}

/** Franja de actividad 07–21 h: una celda por hora con el número de leads
 *  distintos gestionados, juzgada dentro de la jornada real (heatStatuses):
 *  azul a ritmo (≥RITMO_MIN_HORA, más fuerte cuanto más), ámbar bajo ritmo,
 *  rosa hora muerta en pleno turno y gris fuera de su jornada. */
function HeatStrip({
  heat,
  max,
  mode,
  startHour,
  size = "row",
}: {
  heat: number[];
  max: number;
  mode: "day" | "avg";
  startHour: number;
  size?: "row" | "panel";
}) {
  const statuses = heatStatuses(heat);
  const big = size === "panel";
  return (
    <span
      role="img"
      aria-label={heatSummary(heat, statuses, startHour)}
      className={cn("grid w-full", big ? "gap-1" : "gap-0.5")}
      style={{ gridTemplateColumns: `repeat(${heat.length}, minmax(0, 1fr))` }}
    >
      {heat.map((v, i) => {
        const hour = startHour + i;
        const status = statuses[i]!;
        const unit = mode === "avg" ? `${nf1.format(v)} leads por día (promedio)` : `${v} ${v === 1 ? "lead gestionado" : "leads gestionados"}`;
        const title =
          status === "muerta"
            ? `${hour} h — hora muerta: 0 leads en plena jornada (mínimo ${RITMO_MIN_HORA} por hora)`
            : status === "bajo"
              ? `${hour} h — ${unit} · bajo ritmo (mínimo ${RITMO_MIN_HORA} por hora)`
              : status === "ok"
                ? `${hour} h — ${unit} · a ritmo`
                : `${hour} h — fuera de su jornada`;
        const n = Math.round(v);
        return (
          <span key={hour} className="flex min-w-0 flex-col items-center gap-1">
            <span
              title={title}
              className={cn(
                "flex w-full items-center justify-center rounded-[3px] font-semibold leading-none tabular-nums",
                big ? "h-8 text-xs" : "h-5 text-[10px]",
                status === "ok" ? okStep(Math.min(1, v / Math.max(1, max))) : HEAT_CELL[status],
              )}
            >
              {status === "muerta" ? "0" : v > 0 && n > 0 ? n : ""}
            </span>
            {big && <span className="text-xs leading-none tabular-nums text-ink-500">{String(hour).padStart(2, "0")}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** La leyenda de la franja, con sus colores de verdad. */
function HeatLegend({ className, tick = false }: { className?: string; /** Añade la marca negra de la barra de la semana. */ tick?: boolean }) {
  const item = (swatch: string, label: string) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={cn("size-3 rounded-[3px]", swatch)} />
      {label}
    </span>
  );
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600", className)}>
      {item("bg-brand-300", `A ritmo (${RITMO_MIN_HORA}+ por hora)`)}
      {item("bg-warn-bg", "Bajo ritmo")}
      {item("bg-crit-bg", "Hora muerta")}
      {item("bg-line", "Fuera de jornada")}
      {tick && <WeekTickLegend />}
    </p>
  );
}

/** La marca negra de la barra de «Esta semana», en la leyenda. */
function WeekTickLegend() {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className="h-2.5 w-0.5 rounded-full bg-ink-900" />
      Lo que ya debería llevar en la semana
    </span>
  );
}

// ── Horas por día (periodos de más de un día) ───────────────────────────────────

/** El periodo día por día: cada día de cada asesora contra su parte de la meta
 *  y su horario. Solo con más de un día; en «Hoy» y «Ayer» la franja es por hora. */
export interface ProductivityPeriod {
  days: WeekDay[];
  today: string;
  byUser: Record<string, WeekDayStatus[]>;
}

/** Celdas de la franja por día o por semana: azul si cumplió su parte de la
 *  meta, ámbar si quedó corta, rosa un día de trabajo sin nada, gris libre o por
 *  venir, y hoy en celeste con su anillo mientras dura. */
const DAY_CELL: Record<DayState, string> = {
  cumplido: "bg-brand-300 text-ink-900",
  corto: "bg-warn-bg text-warn-fg",
  sin_actividad: "bg-crit-bg text-crit-fg",
  en_curso: "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-300",
  futuro: "bg-line",
  libre: "bg-line text-ink-600",
};

const DAY_STATE_LABEL: Record<DayState, string> = {
  cumplido: "cumplió su meta",
  corto: "corto",
  sin_actividad: "sin actividad",
  en_curso: "hoy, en curso",
  futuro: "por venir",
  libre: "libre",
};

/** Lo mismo dicho de una semana. */
const WEEK_STATE_LABEL: Record<DayState, string> = {
  cumplido: "cumplió su meta",
  corto: "corta",
  sin_actividad: "sin actividad",
  en_curso: "en curso",
  futuro: "por venir",
  libre: "libre",
};

/** «12», «lun 12», «12 oct.»: una fecha local «YYYY-MM-DD» en corto. */
function dateShort(iso: string, opts: { weekday?: boolean; month?: boolean } = {}): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const parts: string[] = [];
  if (opts.weekday) parts.push(dowShort(d.getUTCDay() === 0 ? 7 : d.getUTCDay()));
  parts.push(String(d.getUTCDate()));
  // Intl escribe el mes suelto con mayúscula («Oct.»); en una fecha va en minúscula.
  if (opts.month) parts.push(d.toLocaleDateString("es-PE", { month: "short", timeZone: "UTC" }).toLowerCase());
  return parts.join(" ");
}

/** «6 – 12 oct.», «29 sept. – 5 oct.». */
function periodRangeLabel(from: string, to: string): string {
  if (from === to) return dateShort(to, { month: true });
  return `${dateShort(from, { month: from.slice(0, 7) !== to.slice(0, 7) })} – ${dateShort(to, { month: true })}`;
}

interface PeriodCell {
  key: string;
  estado: DayState;
  horas: number;
  title: string;
}

/** Hasta PERIOD_DAYS_MAX días, una celda por día; más, una por semana. */
function periodCells(dias: WeekDayStatus[]): { cells: PeriodCell[]; byWeek: boolean } {
  if (dias.length > PERIOD_DAYS_MAX) {
    return {
      byWeek: true,
      cells: groupWeeks(dias).map((w) => ({
        key: w.from,
        estado: w.estado,
        horas: w.horas,
        title: `Semana ${periodRangeLabel(w.from, w.to)}: ${nf1.format(w.horas)} h${w.meta > 0 ? ` de ${nf1.format(w.meta)} h` : ""} · ${WEEK_STATE_LABEL[w.estado]}`,
      })),
    };
  }
  return {
    byWeek: false,
    cells: dias.map((d) => ({
      key: d.date,
      estado: d.estado,
      horas: d.horas,
      title: [
        `${dateShort(d.date, { weekday: true, month: true })}: ${nf1.format(d.horas)} h${d.programado ? ` de ${nf1.format(d.meta)} h` : ""}`,
        d.first ? (d.first === d.last ? d.first : `${d.first} a ${d.last}`) : null,
        d.tardeMin != null ? `tarde ${fmtDelay(d.tardeMin)}` : null,
        d.antesMin != null ? `salió ${fmtDelay(d.antesMin)} antes` : null,
        DAY_STATE_LABEL[d.estado],
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  };
}

/** Lo que dice la franja por día para quien no la ve. */
function periodSummary(cells: PeriodCell[], byWeek: boolean, from: string, to: string): string {
  const n = (e: DayState) => cells.filter((c) => c.estado === e).length;
  const total = cells.reduce((sum, c) => sum + c.horas, 0);
  return `Horas por ${byWeek ? "semana" : "día"}, ${periodRangeLabel(from, to)}: ${nf1.format(total)} h en total. Con su meta: ${n("cumplido")}; ${byWeek ? "cortas" : "cortos"}: ${n("corto")}; sin actividad: ${n("sin_actividad")}.`;
}

/** La franja de un periodo de varios días: una celda por día (o por semana)
 *  con las horas trabajadas, en el tono de cómo le fue contra su meta. */
function PeriodStrip({ dias }: { dias: WeekDayStatus[] }) {
  if (!dias.length) return null;
  const { cells, byWeek } = periodCells(dias);
  // Con más de siete celdas solo caben horas enteras; el detalle va en el título.
  const compact = cells.length > 7;
  const label = (c: PeriodCell) => {
    if (c.horas > 0) return compact ? (c.horas < 1 ? "<1" : String(Math.round(c.horas))) : nf1.format(c.horas);
    return c.estado === "sin_actividad" ? "0" : "";
  };
  return (
    <span
      role="img"
      aria-label={periodSummary(cells, byWeek, dias[0]!.date, dias[dias.length - 1]!.date)}
      className="grid w-full gap-0.5"
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
    >
      {cells.map((c) => (
        <span
          key={c.key}
          title={c.title}
          className={cn(
            "flex h-5 w-full min-w-0 items-center justify-center rounded-[3px] text-[10px] font-semibold leading-none tabular-nums",
            DAY_CELL[c.estado],
          )}
        >
          {label(c)}
        </span>
      ))}
    </span>
  );
}

/** La leyenda de la franja por día, con sus colores de verdad. */
function PeriodLegend({
  className,
  tick = false,
  withToday = false,
  byWeek = false,
}: {
  className?: string;
  tick?: boolean;
  withToday?: boolean;
  byWeek?: boolean;
}) {
  const item = (swatch: string, label: string) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={cn("size-3 rounded-[3px]", swatch)} />
      {label}
    </span>
  );
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600", className)}>
      {item(DAY_CELL.cumplido, "Cumplió su meta")}
      {item(DAY_CELL.corto, byWeek ? "Corta" : "Corto")}
      {item(DAY_CELL.sin_actividad, "Sin actividad")}
      {withToday && item(DAY_CELL.en_curso, byWeek ? "En curso" : "Hoy, en curso")}
      {item(DAY_CELL.libre, "Libre o por venir")}
      {tick && <WeekTickLegend />}
    </p>
  );
}

// ── Cierre por día ──────────────────────────────────────────────────────────────

function dayRate(t: TrendCell): number {
  return t.contactos > 0 ? Math.min(1, t.pedidos / t.contactos) : t.pedidos > 0 ? 1 : 0;
}

/** Línea de 7 días del % de cierre para la fila (escala 0–50 %, donde vive el
 *  negocio; más arriba se recorta, el número dice el real), con el % de cada día
 *  sobre su punto y la guía del piso del 10 %. El detalle día por día está en el
 *  panel de la asesora. */
function Sparkline({ trend }: { trend: TrendCell[] }) {
  const W = 88;
  const H = 34;
  const TOP = 13;
  const BOTTOM = H - 4;
  const SCALE_MAX = 0.5;
  const FLOOR = 0.1;
  const stepX = trend.length > 1 ? (W - 12) / (trend.length - 1) : 0;
  const pts = trend.map((t, i) => {
    const rate = dayRate(t);
    const idle = t.contactos === 0 && t.pedidos === 0;
    return { x: 6 + i * stepX, y: BOTTOM - (BOTTOM - TOP) * Math.min(1, rate / SCALE_MAX), rate, idle, t };
  });
  const floorY = BOTTOM - (BOTTOM - TOP) * (FLOOR / SCALE_MAX);
  const label = trend.map((t) => (t.contactos || t.pedidos ? `${t.label} ${Math.round(dayRate(t) * 100)} %` : `${t.label} sin actividad`)).join(", ");
  return (
    <svg width={W} height={H} role="img" aria-label={`Cierre de los últimos 7 días: ${label}`} className="block overflow-visible">
      <line x1={2} x2={W - 2} y1={floorY} y2={floorY} strokeDasharray="2 3" className="stroke-ink-300" />
      <polyline
        points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="stroke-ok-fg"
      />
      {pts.map(
        (p) =>
          !p.idle && (
            <text key={`n${p.t.date}`} x={p.x} y={8} textAnchor="middle" fontSize="10" fontWeight="600" className="fill-ink-500">
              {Math.round(p.rate * 100)}
            </text>
          ),
      )}
      {pts.map((p) => (
        <circle key={p.t.date} cx={p.x} cy={p.y} r={2.4} className={p.idle ? "fill-ink-300" : "fill-ok-fg"}>
          <title>
            {p.idle ? `${p.t.label}: sin actividad` : `${p.t.label}: ${p.t.pedidos} de ${p.t.contactos} contactos · ${Math.round(p.rate * 100)} %`}
          </title>
        </circle>
      ))}
    </svg>
  );
}

/** El cierre día por día en el panel: una columna por día con su barra
 *  (escala 0–50 %, la guía del 10 %), el % y cuántos de cuántos. */
function TrendBars({ trend }: { trend: TrendCell[] }) {
  const SCALE_MAX = 0.5;
  return (
    <div>
      <div className="relative grid h-24 grid-cols-7 items-end gap-2 border-b border-line-strong">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-300" style={{ bottom: `${(0.1 / SCALE_MAX) * 100}%` }} />
        {trend.map((t) => {
          const idle = t.contactos === 0 && t.pedidos === 0;
          const rate = dayRate(t);
          return (
            <span key={t.date} className="flex h-full items-end justify-center">
              {!idle && (
                <span
                  className={cn("w-full max-w-10 rounded-t-[3px]", rate >= 0.1 ? "bg-ok-fg" : "bg-warn-fg")}
                  style={{ height: `${Math.max(3, Math.min(1, rate / SCALE_MAX) * 100)}%` }}
                />
              )}
            </span>
          );
        })}
      </div>
      <ol className="mt-2 grid grid-cols-7 gap-2 text-center">
        {trend.map((t) => {
          const idle = t.contactos === 0 && t.pedidos === 0;
          return (
            <li key={t.date} className="min-w-0">
              <p className={cn("text-sm font-semibold tabular-nums", idle ? "text-ink-300" : "text-ink-900")}>
                {idle ? "—" : `${Math.round(dayRate(t) * 100)} %`}
              </p>
              <p className="text-xs leading-4 tabular-nums text-ink-500">{idle ? "sin actividad" : `${t.pedidos} de ${t.contactos}`}</p>
              <p className="text-xs font-medium text-ink-600">{t.label}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── La semana contra la meta ────────────────────────────────────────────────────

/** La semana en curso de cada persona del tablero (siempre lunes a domingo,
 *  aunque el periodo elegido sea otro). */
export interface ProductivityWeek {
  days: WeekDay[];
  today: string;
  byUser: Record<string, WeekStatus>;
  /** Vendedoras (y quien tiene horario) sin actividad en el periodo: también se miden. */
  extra: { userId: string; email: string }[];
  /** Owner o admin: enlaza a Equipo › Horarios. */
  canEdit: boolean;
}

const WEEK_TONE: Record<WeekStatus["estado"], string> = {
  al_dia: "bg-ok-fg",
  cumplida: "bg-ok-fg",
  atrasada: "bg-warn-fg",
  no_cumplida: "bg-crit-fg",
};

/** «6 – 11 oct» de los días de la semana. */
function weekRangeLabel(days: WeekDay[]): string {
  const d = (iso: string, withMonth: boolean) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("es-PE", withMonth ? { day: "numeric", month: "short", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" });
  const first = days[0]!.date;
  const last = days[days.length - 1]!.date;
  return `lun ${d(first, first.slice(0, 7) !== last.slice(0, 7))} – dom ${d(last, true)}`;
}

/** Lo que dice la semana en una palabra o dos, con su tono de texto. */
function weekVerdict(s: WeekStatus): { text: string; tone: string; long: string } {
  const gap = Math.max(0, s.esperado - s.horas);
  const missing = Math.max(0, s.meta - s.horas);
  switch (s.estado) {
    case "al_dia":
      return { text: "Al día", tone: "text-ok-fg", long: "Al día" };
    case "cumplida":
      return { text: "Cumplida", tone: "text-ok-fg", long: "Cumplió la meta de la semana" };
    case "atrasada":
      return {
        text: `Atraso ${nf1.format(gap)}\u00a0h`,
        tone: "text-warn-fg",
        long: `Va ${nf1.format(gap)}\u00a0h por debajo`,
      };
    case "no_cumplida":
      return {
        text: `Faltaron ${nf1.format(missing)}\u00a0h`,
        tone: "text-crit-fg",
        long: `No cumplió: le faltaron ${nf1.format(missing)}\u00a0h`,
      };
  }
}

/** Barra de la semana: lo hecho contra la meta, en el tono de cómo va, y una
 *  marca donde debería ir a esta hora (mientras queden días de trabajo). */
function WeekBar({ s, size = "row" }: { s: WeekStatus; size?: "row" | "panel" }) {
  const done = s.meta > 0 ? Math.min(1, s.horas / s.meta) : 0;
  const tick = s.meta > 0 && !s.cerrada && s.esperado > 0 ? Math.min(1, s.esperado / s.meta) : null;
  return (
    <span className={cn("relative block w-full rounded-full bg-line", size === "panel" ? "h-2.5" : "h-1.5")}>
      <span className={cn("absolute inset-y-0 left-0 rounded-full", WEEK_TONE[s.estado])} style={{ width: `${done * 100}%` }} />
      {tick != null && (
        <span
          aria-hidden
          className={cn("absolute w-0.5 rounded-full bg-ink-900", size === "panel" ? "-inset-y-1" : "-inset-y-0.5")}
          style={{ left: `calc(${tick * 100}% - 1px)` }}
        />
      )}
    </span>
  );
}

/** «a esta hora debería llevar ~28.4 h»: con horario, lo esperado incluye la
 *  parte de hoy ya transcurrida; sin horario, hoy no cuenta hasta que termina,
 *  así que es «hasta ayer». Null si la semana cerró o aún no se espera nada. */
function expectedPhrase(s: WeekStatus): string | null {
  if (s.cerrada || s.esperado <= 0) return null;
  return `${s.schedule.start ? "a esta hora" : "hasta ayer"} debería llevar ~${nf1.format(s.esperado)}\u00a0h`;
}

function weekTitle(s: WeekStatus): string {
  return [
    `${nf1.format(s.horas)} h activas de ${nf1.format(s.meta)} h`,
    expectedPhrase(s),
    weekVerdict(s).long,
    s.porDefecto ? "meta por defecto, sin horario cargado" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** La celda «Semana» de la tabla. */
function WeekCell({ s }: { s: WeekStatus | undefined }) {
  if (!s) return null;
  const v = weekVerdict(s);
  return (
    <span className="block" title={weekTitle(s)}>
      <span className="block whitespace-nowrap tabular-nums text-ink-900">
        {nf1.format(s.horas)}
        <span className="text-xs text-ink-500"> / {nf1.format(s.meta)}&nbsp;h</span>
      </span>
      <span className="mt-1.5 block">
        <WeekBar s={s} />
      </span>
      <span className={cn("mt-1 block text-xs font-medium tabular-nums", v.tone)}>{v.text}</span>
    </span>
  );
}

/** La semana en la lista del teléfono: una línea y su barra. */
function WeekLine({ s }: { s: WeekStatus | undefined }) {
  if (!s) return null;
  const v = weekVerdict(s);
  return (
    <span className="mt-2.5 block" title={weekTitle(s)}>
      <span className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-ink-600">
          Esta semana <span className="font-semibold tabular-nums text-ink-900">{nf1.format(s.horas)}</span>
          <span className="tabular-nums"> de {nf1.format(s.meta)}&nbsp;h</span>
        </span>
        <span className={cn("text-xs font-medium tabular-nums", v.tone)}>{v.text}</span>
      </span>
      <span className="mt-1.5 block">
        <WeekBar s={s} />
      </span>
    </span>
  );
}

// ── Piezas de la fila ───────────────────────────────────────────────────────────

/** «KP 7/44 · AUR 4/27»: cerrados de cuántos leads trabajados por tienda. Una
 *  tienda con leads y sin cierres va en rojo: es el barril roto. */
function StoreSplit({
  porTienda,
  storeInfo,
}: {
  porTienda: AdvisorBoardRow["porTienda"];
  storeInfo: Record<string, { short: string; name: string }>;
}) {
  const entries = Object.entries(porTienda)
    .filter(([, c]) => c.cerrados > 0 || c.leads > 0)
    .sort((a, b) => (storeInfo[a[0]]?.short ?? "?").localeCompare(storeInfo[b[0]]?.short ?? "?"));
  if (entries.length < 2) return null;
  // Cada tienda entera en su renglón si no caben juntas: partida no se lee.
  return (
    <span className="flex flex-wrap justify-end gap-x-2 text-xs tabular-nums text-ink-500">
      {entries.map(([sid, c]) => (
        <span
          key={sid}
          title={`${storeInfo[sid]?.name ?? "Otra tienda"}: ${c.cerrados} de ${c.leads} leads trabajados`}
          className={cn("whitespace-nowrap", c.cerrados === 0 && c.leads > 0 && "font-medium text-crit-fg")}
        >
          {storeInfo[sid]?.short ?? "?"} {c.cerrados}/{c.leads}
        </span>
      ))}
    </span>
  );
}

/** Ritmo global de la fila: leads trabajados ÷ horas activas; sin horas no se juzga. */
function Ritmo({ leads, horas }: { leads: number; horas: number }) {
  const ritmo = ritmoPorHora(leads, horas);
  if (ritmo == null) return null;
  const ok = ritmo >= RITMO_MIN_HORA;
  return (
    <span
      title={`Ritmo: ${leads} leads ÷ ${nf1.format(horas)} h activas · mínimo ${RITMO_MIN_HORA} por hora`}
      className={cn("text-xs tabular-nums", ok ? "text-ink-600" : "font-medium text-warn-fg")}
    >
      {nf1.format(ritmo)}/h
    </span>
  );
}

/** Punto de presencia: con el panel abierto ahora. Late, salvo con movimiento reducido. */
function OnlineDot({ online }: { online: boolean }) {
  if (!online) return null;
  return (
    <span title="En línea ahora (panel abierto)" className="inline-flex shrink-0 items-center">
      <span aria-hidden className="size-2 rounded-full bg-ok-fg motion-safe:animate-pulse" />
      <span className="sr-only">en línea</span>
    </span>
  );
}

type DrillContext = {
  from: string;
  to: string;
  store: string | null;
  source: SourceBucket | null;
};

type LoadState = AgentLeadRow[] | "loading" | "error" | undefined;

const TH = "sticky top-0 z-[1] border-b border-line bg-white py-2 font-semibold";
/** El segundo renglón del encabezado: el dato que va debajo en la celda. */
const TH_SUB = "block font-normal text-ink-500";

/**
 * La tabla por asesora. Las columnas cuentan la historia de izquierda a
 * derecha: presencia → esfuerzo (actividad, horas, leads y llamadas) →
 * eficiencia (1ª gestión, % cierre, tendencia) → resultado (cerrados por
 * tienda, ingresos). Tocar una asesora abre su panel con los leads, que se
 * cargan al abrirlo. El desplazamiento lo da la tarjeta que la envuelve (la
 * cabecera pegajosa necesita un solo ancestro con scroll).
 */
export function ProductivityTable({
  rows,
  currency,
  hasPrev,
  ctx,
  heatMax,
  heatMode,
  heatStart,
  storeInfo,
  onlineIdle,
  initialOnlineIds,
  solo = false,
  periodLabel,
  week = null,
  period = null,
}: {
  rows: AdvisorBoardRow[];
  currency: string;
  hasPrev: boolean;
  ctx: DrillContext;
  heatMax: number;
  heatMode: "day" | "avg";
  heatStart: number;
  storeInfo: Record<string, { short: string; name: string }>;
  onlineIdle: { userId: string; email: string }[];
  initialOnlineIds: string[];
  solo?: boolean;
  /** «Lunes 12 de octubre», «Octubre 2026»: el periodo, para el panel. */
  periodLabel: string;
  week?: ProductivityWeek | null;
  /** Con más de un día: la franja va por día (o por semana) en vez de por hora. */
  period?: ProductivityPeriod | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, LoadState>>({});
  const [onlineIds, setOnlineIds] = useState<Set<string>>(() => new Set(initialOnlineIds));

  // Puntos de presencia en vivo: cada 45 s mientras la pestaña se ve (como el
  // aviso de Yape). El estado inicial viene del render del servidor.
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      if (document.hidden) return;
      try {
        const ids = await getOnlineAdvisorIds();
        if (!stopped) setOnlineIds(new Set(ids));
      } catch {
        /* best-effort: el punto se queda como estaba */
      }
    }
    const timer = setInterval(refresh, ONLINE_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  async function load(userId: string) {
    setCache((c) => ({ ...c, [userId]: "loading" }));
    try {
      const leads = await loadAgentLeads({ vendedoraId: userId, ...ctx });
      setCache((c) => ({ ...c, [userId]: leads }));
    } catch {
      setCache((c) => ({ ...c, [userId]: "error" }));
    }
  }

  function open(userId: string) {
    setOpenId(userId);
    const cur = cache[userId];
    if (!cur || cur === "error") void load(userId);
  }

  // Solo se muestran como «en línea sin actividad» las que SIGUEN en línea.
  const idleNow = onlineIdle.filter((i) => onlineIds.has(i.userId));
  // Con horario cargado y sin nada en el periodo: también se miden en la
  // semana (la que hoy no entró es justo la que hay que ver).
  const quiet = [
    ...idleNow.map((i) => ({ ...i, online: true })),
    ...(week?.extra ?? []).filter((e) => !idleNow.some((i) => i.userId === e.userId)).map((e) => ({ ...e, online: onlineIds.has(e.userId) })),
  ];
  const openRow = openId ? rows.find((r) => r.userId === openId) : undefined;

  if (!rows.length && !quiet.length) {
    return (
      <div className="px-4 py-10 text-center sm:px-5">
        <p className="text-sm font-medium text-ink-900">
          {solo ? "Sin actividad tuya en este periodo." : "Sin actividad de asesoras en este periodo."}
        </p>
        <p className="mt-1 text-[13px] text-ink-500">Prueba con otro periodo, o quita la tienda o la fuente.</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <p className="text-[13px] text-ink-600">
          {solo ? (
            "Toca tu fila para ver tus leads."
          ) : (
            <>
              <b className="font-semibold tabular-nums text-ink-900">{nf.format(rows.length)}</b>{" "}
              {rows.length === 1 ? "asesora" : "asesoras"}
              {idleNow.length > 0 && `${SEP}${nf.format(idleNow.length)} en línea sin actividad`}
              {quiet.length > idleNow.length &&
                `${SEP}${nf.format(quiet.length - idleNow.length)} ${idleNow.length ? "más " : ""}sin actividad en el periodo`}
              <span className="text-ink-500">{SEP}toca una para ver sus leads</span>
            </>
          )}
        </p>
        {period ? (
          <PeriodLegend
            tick={!!week}
            withToday={period.days.some((d) => d.date === period.today)}
            byWeek={period.days.length > PERIOD_DAYS_MAX}
          />
        ) : (
          <HeatLegend tick={!!week} />
        )}
      </div>

      <div className="xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain">
        {/* Bajo 1280 px: una lista; la tabla de nueve columnas no cabe al lado de la barra lateral. */}
        <ul className="divide-y divide-line xl:hidden">
          {rows.map((r) => {
            const showDelta = hasPrev && !r.delta.isNew;
            return (
              <li key={r.userId}>
                <button
                  type="button"
                  onClick={() => open(r.userId)}
                  aria-haspopup="dialog"
                  className={cn(
                    "block w-full px-4 py-3.5 text-left transition-colors hover:bg-wash sm:px-5",
                    openId === r.userId && "bg-brand-50/70",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink-900">{advisorName(r.email)}</span>
                      <OnlineDot online={onlineIds.has(r.userId)} />
                      {hasPrev && r.delta.isNew && <Badge tone="info">Nueva</Badge>}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="text-base font-semibold tabular-nums text-ink-900">{pct(r.conversion)}</span>
                      <span className="text-xs text-ink-500"> cierre</span>
                      {showDelta && (
                        <Signed value={r.delta.conversionPP} fmt={(n) => `${nf1.format(n)} pp`} className="ml-1.5 text-xs font-medium" />
                      )}
                    </span>
                  </span>
                  <span className="mt-2.5 block">
                    {period ? (
                      <PeriodStrip dias={period.byUser[r.userId] ?? []} />
                    ) : (
                      <HeatStrip heat={r.heat} max={heatMax} mode={heatMode} startHour={heatStart} />
                    )}
                  </span>
                  {/* Cada dato entero en su tramo: un salto de línea nunca parte «12 min». */}
                  <span className="mt-2.5 flex flex-wrap gap-x-1.5 text-[13px] leading-5 text-ink-600">
                    <span className="whitespace-nowrap">
                      <span className="font-medium tabular-nums text-ink-900">{nf.format(r.leadsTrabajados)}</span>
                      {" leads\u00a0·"}
                    </span>
                    <span className="whitespace-nowrap">
                      <span className="font-medium tabular-nums text-ink-900">{nf.format(r.llamadas)}</span>
                      {" llamadas\u00a0·"}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">
                      {nf1.format(r.horas)} h{r.dias > 1 && ` en ${r.dias} días`}
                      {ritmoPorHora(r.leadsTrabajados, r.horas) != null && (
                        <>
                          {SEP}
                          <Ritmo leads={r.leadsTrabajados} horas={r.horas} />
                        </>
                      )}
                      {r.primeraGestion.medianMin != null && "\u00a0·"}
                    </span>
                    {r.primeraGestion.medianMin != null && (
                      <span className="whitespace-nowrap">
                        1ª gestión{" "}
                        <span className={cn("font-medium tabular-nums", firstTouchTone(r.primeraGestion.medianMin))}>
                          {fmtMin(r.primeraGestion.medianMin)}
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-[13px]">
                    <span className="text-ink-600">
                      <span className="font-semibold tabular-nums text-ink-900">{nf.format(r.cerrados)}</span>{" "}
                      {r.cerrados === 1 ? "cerrado" : "cerrados"}
                      {showDelta && <Signed value={r.delta.cerrados} fmt={nf.format} className="ml-1 text-xs font-medium" />}
                    </span>
                    <span className="font-semibold tabular-nums text-ink-900">
                      {money(r.ingresos, currency)}
                      {showDelta && (
                        <Signed value={r.delta.ingresos} fmt={(n) => money(n, currency)} className="ml-1.5 text-xs font-medium" />
                      )}
                    </span>
                  </span>
                  <WeekLine s={week?.byUser[r.userId]} />
                </button>
              </li>
            );
          })}
          {quiet.map((i) => (
            <li key={i.userId} className="px-4 py-3 text-[13px] text-ink-500 sm:px-5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-ink-700">{advisorName(i.email)}</span>
                <OnlineDot online={i.online} />
                <span>{i.online ? "En línea, sin actividad registrada en el periodo" : "Sin actividad registrada en el periodo"}</span>
              </span>
              <WeekLine s={week?.byUser[i.userId]} />
            </li>
          ))}
        </ul>

        <table className="hidden w-full table-fixed text-left text-sm xl:table">
          {/* Los anchos salen de 1280 px con la barra lateral (≈976 px de tabla):
              el nombre, quince celdas de ~12 px, la línea de 7 días entera y
              «Semana» con su barra. */}
          <colgroup>
            <col className={week ? "w-[12%]" : "w-[13%]"} />
            <col className="w-[23%]" />
            <col className="w-[6.5%]" />
            {week && <col className="w-[9.5%]" />}
            <col className="w-[6%]" />
            <col className="w-[7.5%]" />
            <col className="w-[6%]" />
            <col className="w-[11%]" />
            <col className="w-[9.5%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead className="text-xs text-ink-600">
            <tr>
              <th scope="col" className={cn(TH, "pl-5 pr-3")}>Asesora</th>
              <th scope="col" className={cn(TH, "pr-4")}>
                {period ? (
                  <span title="Horas trabajadas cada día (gestiones de leads y de envíos) contra su parte de la meta de la semana · toca una asesora para verlas día por día">
                    Horas por {period.days.length > PERIOD_DAYS_MAX ? "semana" : "día"}{" "}
                    <span className="font-normal tabular-nums text-ink-500">
                      {periodRangeLabel(period.days[0]!.date, period.days[period.days.length - 1]!.date)}
                    </span>
                  </span>
                ) : (
                  <>
                    Actividad por hora <span className="font-normal tabular-nums text-ink-500">07–21 h</span>
                  </>
                )}
              </th>
              <th scope="col" className={cn(TH, "pr-3 text-right")}>
                Horas
                <span className={TH_SUB}>ritmo</span>
              </th>
              {week && (
                <th
                  scope="col"
                  className={cn(TH, "pr-3")}
                  title="Horas activas de la semana en curso, de lunes a domingo (leads y envíos), contra su meta, sea cual sea el periodo · la marca negra es lo que ya debería llevar: con horario, hasta esta hora; sin horario, hasta ayer"
                >
                  Esta semana
                  <span className={TH_SUB}>de la meta</span>
                </th>
              )}
              <th scope="col" className={cn(TH, "pr-2 text-right")}>
                Leads
                <span className={TH_SUB}>llamadas</span>
              </th>
              <th
                scope="col"
                className={cn(TH, "pr-3 text-right")}
                title="Mediana de minutos desde que el lead llega hasta su primera gestión humana, en los leads que ella tocó primero · verde hasta 30 min, rojo más de 4 h"
              >
                1ª gestión
                <span className={TH_SUB}>leads</span>
              </th>
              <th scope="col" className={cn(TH, "pr-3 text-right")}>
                Cierre
                {hasPrev && <span className={TH_SUB}>cambio</span>}
              </th>
              <th scope="col" className={cn(TH, "pl-2 pr-2")} title="% de cierre por día, últimos 7 días · escala 0–50 % · guía punteada en el 10 %">
                Cierre 7 días
              </th>
              <th
                scope="col"
                className={cn(TH, "pr-3 text-right")}
                title="El pedido se acredita a la asesora del último toque sobre el lead (llamada, mensaje o venta)"
              >
                Cerrados
                <span className={TH_SUB}>por tienda</span>
              </th>
              <th scope="col" className={cn(TH, "pr-5 text-right")}>
                Ingresos
                {hasPrev && <span className={TH_SUB}>cambio</span>}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const showDelta = hasPrev && !r.delta.isNew;
              const selected = openId === r.userId;
              return (
                <tr
                  key={r.userId}
                  onClick={() => open(r.userId)}
                  className={cn(
                    "cursor-pointer border-b border-line align-top transition-colors last:border-0",
                    selected ? "bg-brand-50/70" : "hover:bg-wash",
                  )}
                >
                  <td className="py-3 pl-5 pr-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          open(r.userId);
                        }}
                        aria-haspopup="dialog"
                        className={cn("truncate font-semibold hover:underline", selected ? "text-brand-700" : "text-ink-900")}
                      >
                        {advisorName(r.email)}
                      </button>
                      <OnlineDot online={onlineIds.has(r.userId)} />
                    </span>
                    {hasPrev && r.delta.isNew && (
                      <span className="mt-1 block">
                        <Badge tone="info" title="Sin actividad en el periodo anterior: no hay con qué comparar">
                          Nueva
                        </Badge>
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {period ? (
                      <PeriodStrip dias={period.byUser[r.userId] ?? []} />
                    ) : (
                      <HeatStrip heat={r.heat} max={heatMax} mode={heatMode} startHour={heatStart} />
                    )}
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <span className="block tabular-nums text-ink-900">
                      {nf1.format(r.horas)} h
                      {r.dias > 1 && <span className="text-xs text-ink-500">{`${SEP}${r.dias} d`}</span>}
                    </span>
                    <Ritmo leads={r.leadsTrabajados} horas={r.horas} />
                  </td>
                  {week && (
                    <td className="py-3 pr-3">
                      <WeekCell s={week.byUser[r.userId]} />
                    </td>
                  )}
                  <td className="py-3 pr-2 text-right">
                    <span className="block tabular-nums text-ink-900">{nf.format(r.leadsTrabajados)}</span>
                    <span className="block text-xs tabular-nums text-ink-500">{nf.format(r.llamadas)}</span>
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <span className={cn("block font-medium tabular-nums", firstTouchTone(r.primeraGestion.medianMin))}>
                      {fmtMin(r.primeraGestion.medianMin)}
                    </span>
                    {r.primeraGestion.n > 0 && (
                      <span className="block text-xs tabular-nums text-ink-500" title="Leads del periodo que tocó primero">
                        {nf.format(r.primeraGestion.n)}
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <span className="block font-semibold tabular-nums text-ink-900">{pct(r.conversion)}</span>
                    {showDelta && (
                      <Signed value={r.delta.conversionPP} fmt={(n) => `${nf1.format(n)} pp`} className="block text-xs font-medium" />
                    )}
                  </td>
                  <td className="py-2 pl-2 pr-2">
                    <Sparkline trend={r.trend} />
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <span className="block tabular-nums text-ink-900">
                      {nf.format(r.cerrados)}
                      {showDelta && <Signed value={r.delta.cerrados} fmt={nf.format} className="ml-1.5 text-xs font-medium" />}
                    </span>
                    <StoreSplit porTienda={r.porTienda} storeInfo={storeInfo} />
                  </td>
                  <td className="py-3 pr-5 text-right">
                    <span className="block font-semibold tabular-nums text-ink-900">{money(r.ingresos, currency)}</span>
                    {showDelta && (
                      <Signed value={r.delta.ingresos} fmt={(n) => money(n, currency)} className="block text-xs font-medium" />
                    )}
                  </td>
                </tr>
              );
            })}
            {quiet.map((i) => (
              <tr key={i.userId} className="border-b border-line align-top last:border-0">
                <td className="py-3 pl-5 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-ink-700">{advisorName(i.email)}</span>
                    <OnlineDot online={i.online} />
                  </span>
                </td>
                <td colSpan={2} className="py-3 pr-4 text-[13px] text-ink-500">
                  {i.online ? "En línea, sin actividad registrada en el periodo" : "Sin actividad registrada en el periodo"}
                </td>
                {week && (
                  <td className="py-3 pr-3">
                    <WeekCell s={week.byUser[i.userId]} />
                  </td>
                )}
                <td colSpan={6} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openRow && (
        <AdvisorPanel
          row={openRow}
          state={cache[openRow.userId]}
          onRetry={() => void load(openRow.userId)}
          onClose={() => setOpenId(null)}
          currency={currency}
          hasPrev={hasPrev}
          heatMax={heatMax}
          heatMode={heatMode}
          heatStart={heatStart}
          storeInfo={storeInfo}
          online={onlineIds.has(openRow.userId)}
          periodLabel={periodLabel}
          solo={solo}
          week={week}
          period={period}
        />
      )}
    </>
  );
}

// ── Panel de la asesora ─────────────────────────────────────────────────────────

const PANEL_ZONE = "-mx-4 border-t border-line px-4 pt-5 sm:-mx-6 sm:px-6";

function ZoneHead({ title, help, aside }: { title: string; help?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {help && <p className="mt-0.5 text-[13px] text-ink-500">{help}</p>}
      </div>
      {aside}
    </div>
  );
}

/** Una celda del marco de cifras del panel, sobre `wash`. */
function PanelFigure({ label, value, tone, extra }: { label: string; value: string; tone?: string; extra?: ReactNode }) {
  return (
    <div className="min-w-0 bg-wash px-3.5 py-3">
      <dt className="text-xs font-medium text-ink-600">{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-semibold leading-7 tabular-nums", tone ?? "text-ink-900")}>{value}</dd>
      {extra && <dd className="text-xs leading-4 text-ink-600">{extra}</dd>}
    </div>
  );
}

function AdvisorPanel({
  row: r,
  state,
  onRetry,
  onClose,
  currency,
  hasPrev,
  heatMax,
  heatMode,
  heatStart,
  storeInfo,
  online,
  periodLabel,
  solo,
  week,
  period,
}: {
  row: AdvisorBoardRow;
  state: LoadState;
  onRetry: () => void;
  onClose: () => void;
  currency: string;
  hasPrev: boolean;
  heatMax: number;
  heatMode: "day" | "avg";
  heatStart: number;
  storeInfo: Record<string, { short: string; name: string }>;
  online: boolean;
  periodLabel: string;
  solo: boolean;
  week: ProductivityWeek | null;
  period: ProductivityPeriod | null;
}) {
  const name = advisorName(r.email);
  const periodDias = period?.byUser[r.userId];
  const weekStatus = week?.byUser[r.userId];
  const showDelta = hasPrev && !r.delta.isNew;
  const ritmo = ritmoPorHora(r.leadsTrabajados, r.horas);

  // Escape cierra el panel, como la hoja de los filtros.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tiendas = Object.entries(r.porTienda)
    .filter(([, c]) => c.cerrados > 0 || c.leads > 0)
    .sort((a, b) => b[1].leads - a[1].leads);
  const fuentes = (Object.keys(SOURCE_LABEL) as SourceBucket[])
    .map((k) => ({ k, cell: r.porFuente[k] }))
    .filter((e) => e.cell.cerrados > 0);

  return (
    <SidePanel
      label={solo ? "Mi productividad" : `Productividad de ${name}`}
      title={solo ? "Mis leads y mi cierre" : name}
      badge={
        <>
          {online && <Badge tone="ok">En línea</Badge>}
          {hasPrev && r.delta.isNew && <Badge tone="info">Nueva</Badge>}
        </>
      }
      meta={periodLabel}
      width="max-w-[720px]"
      onClose={onClose}
    >
      <div className="flex flex-col gap-6">
        <section aria-label="Cifras">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-4">
            <PanelFigure
              label="Cierre"
              value={pct(r.conversion)}
              extra={showDelta ? <Signed value={r.delta.conversionPP} fmt={(n) => `${nf1.format(n)} pp`} className="font-medium" /> : undefined}
            />
            <PanelFigure
              label="Cerrados"
              value={nf.format(r.cerrados)}
              extra={
                <>
                  de {nf.format(r.leadsTrabajados)} leads
                  {showDelta && (
                    <>
                      {SEP}
                      <Signed value={r.delta.cerrados} fmt={nf.format} className="font-medium" />
                    </>
                  )}
                </>
              }
            />
            <PanelFigure
              label="Ingresos"
              value={money(r.ingresos, currency)}
              extra={showDelta ? <Signed value={r.delta.ingresos} fmt={(n) => money(n, currency)} className="font-medium" /> : undefined}
            />
            <PanelFigure
              label="1ª gestión"
              value={fmtMin(r.primeraGestion.medianMin)}
              tone={firstTouchTone(r.primeraGestion.medianMin)}
              extra={r.primeraGestion.n > 0 ? `mediana de ${nf.format(r.primeraGestion.n)} leads` : "sin leads tocados primero"}
            />
          </dl>
          <p className="mt-3 text-[13px] leading-5 text-ink-600">
            <span className="font-medium tabular-nums text-ink-900">{nf.format(r.llamadas)}</span> llamadas{SEP}
            <span className="tabular-nums">{nf1.format(r.horas)} h</span> activas
            {r.dias > 1 && <span className="tabular-nums"> en {r.dias} días</span>}
            {ritmo != null && (
              <>
                {SEP}
                <span className={cn("font-medium tabular-nums", ritmo >= RITMO_MIN_HORA ? "text-ink-900" : "text-warn-fg")}>
                  {nf1.format(ritmo)} leads por hora
                </span>{" "}
                <span className="text-ink-500">(mínimo {RITMO_MIN_HORA})</span>
              </>
            )}
          </p>
        </section>

        {period && periodDias && periodDias.length > 0 && (
          <PeriodZone dias={periodDias} today={period.today} schedule={weekStatus?.schedule ?? null} />
        )}

        {week && weekStatus && (
          <WeekZone s={weekStatus} userId={r.userId} days={week.days} today={week.today} canEdit={week.canEdit} />
        )}

        <section className={PANEL_ZONE}>
          <ZoneHead
            title="Actividad por hora"
            help={
              heatMode === "avg"
                ? `A qué horas trabaja: leads distintos gestionados en cada hora, en promedio por día de los ${nf.format(period?.days.length ?? r.dias)} días`
                : "Leads distintos gestionados en cada hora, de todas las fuentes"
            }
          />
          <HeatStrip heat={r.heat} max={heatMax} mode={heatMode} startHour={heatStart} size="panel" />
          <HeatLegend className="mt-3" />
        </section>

        <section className={PANEL_ZONE}>
          <ZoneHead title="Cierre de los últimos 7 días" help="Pedidos de cuántos contactos, cada día · la guía punteada es el piso del 10 %" />
          <TrendBars trend={r.trend} />
        </section>

        {(tiendas.length > 0 || fuentes.length > 0) && (
          <section className={cn(PANEL_ZONE, "grid gap-6 sm:grid-cols-2")}>
            {tiendas.length > 0 && (
              <div>
                <ZoneHead title="Por tienda" />
                <ul className="divide-y divide-line border-y border-line text-[13px]">
                  {tiendas.map(([sid, c]) => {
                    const broken = c.cerrados === 0 && c.leads > 0;
                    return (
                      <li key={sid} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="min-w-0 truncate font-medium text-ink-900">{storeInfo[sid]?.name ?? "Otra tienda"}</span>
                        <span className={cn("shrink-0 tabular-nums", broken ? "font-medium text-crit-fg" : "text-ink-600")}>
                          {nf.format(c.cerrados)} de {nf.format(c.leads)}
                          {c.leads > 0 && `${SEP}${Math.round((c.cerrados / c.leads) * 100)}\u00a0%`}
                          {c.ingresos > 0 && <span className="text-ink-900">{SEP}{money(c.ingresos, currency)}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div>
              <ZoneHead title="Cierres por fuente" />
              {fuentes.length ? (
                <ul className="divide-y divide-line border-y border-line text-[13px]">
                  {fuentes.map(({ k, cell }) => (
                    <li key={k} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="font-medium text-ink-900">{SOURCE_LABEL[k]}</span>
                      <span className="shrink-0 tabular-nums text-ink-600">
                        {nf.format(cell.cerrados)} {cell.cerrados === 1 ? "cierre" : "cierres"}{SEP}
                        <span className="text-ink-900">{money(cell.ingresos, currency)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-500">Sin cierres en el periodo.</p>
              )}
            </div>
          </section>
        )}

        <section className={PANEL_ZONE}>
          <AgentLeads state={state} currency={currency} onRetry={onRetry} />
        </section>
      </div>
    </SidePanel>
  );
}

const DAY_BADGE: Partial<Record<WeekStatus["dias"][number]["estado"], { tone: "ok" | "warn" | "crit" | "info" | "neutral"; label: string }>> = {
  cumplido: { tone: "ok", label: "Cumplido" },
  corto: { tone: "warn", label: "Corto" },
  sin_actividad: { tone: "crit", label: "Sin actividad" },
  en_curso: { tone: "info", label: "En curso" },
};

/**
 * La semana de la asesora en el panel: cuánto lleva contra su meta, lo que
 * debería llevar a esta hora y cada día con sus horas, su primera y última
 * actividad, y si llegó tarde o se fue antes de su horario.
 */
function WeekZone({
  s,
  userId,
  days,
  today,
  canEdit,
}: {
  s: WeekStatus;
  userId: string;
  days: WeekDay[];
  today: string;
  canEdit: boolean;
}) {
  const v = weekVerdict(s);
  const sched = s.schedule;
  const grace = graceTimes(sched);
  const expected = expectedPhrase(s);
  const help = [
    weekRangeLabel(days),
    `meta ${nf1.format(s.meta)}\u00a0h`,
    daysLabel(sched.days),
    sched.start ? `${sched.start} a ${sched.end}` : "sin horario",
  ].join(SEP);
  return (
    <section className={PANEL_ZONE} aria-label="Esta semana">
      <ZoneHead
        title="Esta semana"
        help={help}
        aside={
          canEdit ? (
            <Link
              href={`/dashboard/team?tab=horarios&user=${encodeURIComponent(userId)}`}
              className="inline-flex items-center text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
            >
              {s.porDefecto ? "Definir horario" : "Editar horario"}
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-ink-600">
          <span className="text-xl font-semibold tabular-nums text-ink-900">{nf1.format(s.horas)}&nbsp;h</span> activas de{" "}
          <span className="tabular-nums">{nf1.format(s.meta)}&nbsp;h</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-600">
          {expected && <span className="tabular-nums">{expected}</span>}
          <span className={cn("font-medium", v.tone)}>{v.long}</span>
        </p>
      </div>
      <div className="mt-2.5">
        <WeekBar s={s} size="panel" />
      </div>
      <DayRows dias={s.dias} today={today} className="mt-4" />
      <p className="mt-2 text-xs text-ink-500">
        {s.porDefecto
          ? `Sin horario cargado: se usa la meta por defecto (${nf1.format(s.meta)}\u00a0h, ${daysLabel(sched.days)}) y no se juzgan llegadas ni salidas.`
          : grace
            ? `Primera y última actividad de cada día. «Tarde» si la primera pasa de las ${grace.tarde}; «Salió antes» si la última es antes de las ${grace.antes}, en días ya cerrados.`
            : "Primera y última actividad de cada día. Sin horario fijo no se juzgan llegadas ni salidas."}
      </p>
    </section>
  );
}

/** Una fila por día: el día, una barra corta contra su parte de la meta (desde
 *  640 px), las horas, la primera y la última actividad, y sus chapas. */
function DayRows({ dias, today, className }: { dias: WeekDayStatus[]; today: string; className?: string }) {
  const dayNum = (iso: string) => Number(iso.slice(8, 10));
  return (
    <ul className={cn("divide-y divide-line border-y border-line", className)}>
      {dias.map((d) => {
        const badge = DAY_BADGE[d.estado];
        const quiet = d.estado === "futuro" || (d.estado === "libre" && !d.first);
        const share = d.meta > 0 ? Math.min(1, d.horas / d.meta) : 0;
        // Con «Tarde» o «Salió antes», «Cumplido» sobra donde se ve la barra del
        // día; en el teléfono no hay barra, así que ahí sí va.
        const cumplidoConAviso = d.estado === "cumplido" && (d.tardeMin != null || d.antesMin != null);
        return (
          <li
            key={d.date}
            className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 text-[13px] sm:grid-cols-[3.25rem_4.5rem_3.5rem_minmax(0,1fr)_auto]"
          >
            <span className={cn("font-medium tabular-nums", quiet ? "text-ink-500" : d.date === today ? "text-ink-900" : "text-ink-700")}>
              {dowShort(d.isoDow)} {dayNum(d.date)}
            </span>
            <span className="hidden sm:block">
              {d.programado && d.estado !== "futuro" && (
                <span className="relative block h-1.5 rounded-full bg-line" title={`${nf1.format(d.horas)} de ${nf1.format(d.meta)} h`}>
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      d.estado === "en_curso" ? "bg-ink-500" : d.estado === "corto" || d.estado === "sin_actividad" ? "bg-warn-fg" : "bg-ok-fg",
                    )}
                    style={{ width: `${share * 100}%` }}
                  />
                </span>
              )}
            </span>
            <span className={cn("text-right tabular-nums sm:text-left", quiet ? "text-ink-500" : "font-medium text-ink-900")}>
              {quiet ? "—" : `${nf1.format(d.horas)}\u00a0h`}
            </span>
            <span className={cn("col-span-3 tabular-nums sm:col-span-1", quiet ? "text-ink-500" : "text-ink-600")}>
              {d.first ? (d.first === d.last ? d.first : `${d.first} – ${d.last}`) : d.estado === "libre" ? "Libre" : ""}
            </span>
            <span className="col-span-3 flex flex-wrap gap-1.5 sm:col-span-1 sm:justify-end">
              {d.tardeMin != null && <Badge tone="warn">Tarde {fmtDelay(d.tardeMin)}</Badge>}
              {d.antesMin != null && <Badge tone="warn">Salió {fmtDelay(d.antesMin)} antes</Badge>}
              {badge && (
                <Badge tone={badge.tone} className={cumplidoConAviso ? "sm:hidden" : undefined}>
                  {badge.label}
                </Badge>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const WEEK_BADGE: Partial<Record<DayState, { tone: "ok" | "warn" | "crit" | "info"; label: string }>> = {
  cumplido: { tone: "ok", label: "Cumplida" },
  corto: { tone: "warn", label: "Corta" },
  sin_actividad: { tone: "crit", label: "Sin actividad" },
  en_curso: { tone: "info", label: "En curso" },
};

/** Una fila por semana, para los periodos largos: el tramo, la barra contra lo
 *  que tocaba, las horas y cómo le fue. */
function WeekRows({ weeks, className }: { weeks: PeriodWeek[]; className?: string }) {
  return (
    <ul className={cn("divide-y divide-line border-y border-line", className)}>
      {weeks.map((w) => {
        const badge = WEEK_BADGE[w.estado];
        const share = w.meta > 0 ? Math.min(1, w.horas / w.meta) : 0;
        return (
          <li
            key={w.from}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 text-[13px] sm:grid-cols-[7.5rem_4.5rem_6.5rem_minmax(0,1fr)_auto]"
          >
            <span className="font-medium tabular-nums text-ink-700">{periodRangeLabel(w.from, w.to)}</span>
            <span className="hidden sm:block">
              {w.meta > 0 && w.estado !== "futuro" && (
                <span className="relative block h-1.5 rounded-full bg-line">
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      w.estado === "en_curso" ? "bg-ink-500" : w.estado === "cumplido" ? "bg-ok-fg" : "bg-warn-fg",
                    )}
                    style={{ width: `${share * 100}%` }}
                  />
                </span>
              )}
            </span>
            <span className="text-right tabular-nums sm:text-left">
              <span className="font-medium text-ink-900">{nf1.format(w.horas)}&nbsp;h</span>
              {w.meta > 0 && <span className="text-ink-500"> de {nf1.format(w.meta)}&nbsp;h</span>}
            </span>
            <span className="hidden sm:block" />
            <span className="col-span-3 flex sm:col-span-1 sm:justify-end">{badge && <Badge tone={badge.tone}>{badge.label}</Badge>}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** El periodo elegido, día por día (o por semana si pasa de un mes): cuántas
 *  horas trabajó cada día, cuándo empezó y terminó, y cómo le fue contra su
 *  parte de la meta. */
function PeriodZone({ dias, today, schedule }: { dias: WeekDayStatus[]; today: string; schedule: AdvisorSchedule | null }) {
  const from = dias[0]!.date;
  const to = dias[dias.length - 1]!.date;
  const byWeek = dias.length > 31;
  const total = dias.reduce((sum, d) => sum + d.horas, 0);
  // Lo que tocaba hasta hoy: los días de trabajo ya empezados del periodo.
  const tocaba = dias.reduce((sum, d) => sum + (d.programado && d.date <= today ? d.meta : 0), 0);
  const daily = dias.find((d) => d.programado)?.meta ?? 0;
  const grace = schedule ? graceTimes(schedule) : null;
  const help = [
    periodRangeLabel(from, to),
    daily > 0 ? `meta ${nf1.format(daily)}\u00a0h por día` : null,
    schedule?.start ? `${schedule.start} a ${schedule.end}` : null,
  ]
    .filter(Boolean)
    .join(SEP);
  return (
    <section className={PANEL_ZONE} aria-label={byWeek ? "Por semana" : "Por día"}>
      <ZoneHead
        title={byWeek ? "Por semana" : "Por día"}
        help={help}
        aside={
          <span className="text-[13px] tabular-nums text-ink-600">
            <b className="font-semibold text-ink-900">{nf1.format(total)}&nbsp;h</b>
            {tocaba > 0 && <> de {nf1.format(tocaba)}&nbsp;h</>}
          </span>
        }
      />
      {byWeek ? <WeekRows weeks={groupWeeks(dias)} /> : <DayRows dias={dias} today={today} />}
      <p className="mt-2 text-xs text-ink-500">
        Horas trabajadas: gestiones de leads y de envíos, de la primera a la última acción del día (una pausa de más de 45
        min corta el bloque); la columna «Horas» cuenta solo leads.
        {grace && !byWeek && ` «Tarde» si la primera pasa de las ${grace.tarde}; «Salió antes» si la última es antes de las ${grace.antes}.`}
      </p>
    </section>
  );
}

/** «Con carrito 2 de 2 · Frío 0 de 4»: cerrados de trabajados por tipo de lead.
 *  Un tipo trabajado varias veces y sin ningún cierre va en rojo: ahí está el
 *  eslabón débil. */
function SegmentSummary({ rows }: { rows: AgentLeadRow[] }) {
  const agg = new Map<LeadSegment, { won: number; total: number }>();
  for (const l of rows) {
    const e = agg.get(l.segment) ?? { won: 0, total: 0 };
    e.total += 1;
    if (l.won) e.won += 1;
    agg.set(l.segment, e);
  }
  const parts = LEAD_SEGMENTS.filter((s) => agg.has(s.key));
  if (!parts.length) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] text-ink-600">Cierra por tipo:</span>
      {parts.map((s) => {
        const e = agg.get(s.key)!;
        const broken = e.won === 0 && e.total >= 3;
        return (
          <Badge key={s.key} tone={broken ? "crit" : "neutral"} title={`${SEGMENT_LABEL[s.key]}: cerró ${e.won} de ${e.total} trabajados`}>
            {SEGMENT_LABEL[s.key]} <span className="tabular-nums">{e.won} de {e.total}</span>
          </Badge>
        );
      })}
    </div>
  );
}

function statusTone(status: string): string {
  const cat = categoryOf(status);
  if (cat === "won") return "font-medium text-ok-fg";
  if (cat === "lost") return "text-ink-500";
  return "text-ink-700";
}

function AgentLeads({ state, currency, onRetry }: { state: LoadState; currency: string; onRetry: () => void }) {
  const count = Array.isArray(state) ? state.length : null;
  return (
    <>
      <ZoneHead
        title="Leads trabajados"
        help="Los que tocó en el periodo, del más reciente al más antiguo"
        aside={count != null && count > 0 ? <span className="text-[13px] tabular-nums text-ink-500">{nf.format(count)}</span> : undefined}
      />
      {state === "loading" || state === undefined ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Cargando leads">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
            </div>
          ))}
        </div>
      ) : state === "error" ? (
        <Banner tone="crit" role="alert" title="No se pudieron cargar los leads">
          <OpsButton size="sm" onClick={onRetry} className="mt-2 pointer-coarse:h-11">
            Reintentar
          </OpsButton>
        </Banner>
      ) : !state.length ? (
        <p className="text-[13px] text-ink-500">Sin leads trabajados en este periodo.</p>
      ) : (
        <>
          <SegmentSummary rows={state} />
          <ul className="divide-y divide-line border-y border-line">
            {state.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    <span className="font-medium text-ink-900">{l.name || "Sin nombre"}</span>
                    {l.phone && <span className="tabular-nums text-ink-500">{SEP}{l.phone}</span>}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-600">
                    <span className={statusTone(l.status)}>{labelOf(l.status)}</span>
                    {`${SEP}${SOURCE_LABEL[l.source]}${SEP}${SEGMENT_LABEL[l.segment]}${SEP}`}
                    <span className="tabular-nums">
                      {l.llamadas} {l.llamadas === 1 ? "llamada" : "llamadas"}
                      {SEP}
                      {shortWhen(l.lastTouch)}
                    </span>
                  </p>
                </div>
                <span className="shrink-0 pt-px text-sm tabular-nums">
                  {l.won ? (
                    <span className="font-semibold text-ok-fg">{money(l.net, currency)}</span>
                  ) : (
                    <span className="text-ink-300" aria-label="Sin venta">—</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
