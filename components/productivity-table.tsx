"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, SidePanel, Skeleton } from "@/components/ops-ui";
import { categoryOf, labelOf, LEAD_SEGMENTS, type LeadSegment } from "@/lib/leads";
import { getOnlineAdvisorIds, loadAgentLeads } from "@/app/dashboard/productividad/actions";
import { RITMO_MIN_HORA, heatStatuses, ritmoPorHora, type HeatCellStatus } from "@/lib/heat";
import { SEGMENT_LABEL, SOURCE_LABEL } from "@/lib/productivity-labels";
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
function HeatLegend({ className }: { className?: string }) {
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
  const W = 108;
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
  const openRow = openId ? rows.find((r) => r.userId === openId) : undefined;

  if (!rows.length && !idleNow.length) {
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
              <span className="text-ink-500">{SEP}toca una para ver sus leads</span>
            </>
          )}
        </p>
        <HeatLegend />
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
                    <HeatStrip heat={r.heat} max={heatMax} mode={heatMode} startHour={heatStart} />
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
                </button>
              </li>
            );
          })}
          {idleNow.map((i) => (
            <li key={i.userId} className="flex items-center gap-2 px-4 py-3 text-[13px] text-ink-500 sm:px-5">
              <span className="font-medium text-ink-700">{advisorName(i.email)}</span>
              <OnlineDot online />
              <span>En línea, sin actividad registrada en el periodo</span>
            </li>
          ))}
        </ul>

        <table className="hidden w-full table-fixed text-left text-sm xl:table">
          <colgroup>
            <col className="w-[14%]" />
            <col className="w-[25%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[8%]" />
            <col className="w-[7%]" />
            <col className="w-[12%]" />
            <col className="w-[11%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead className="text-xs text-ink-600">
            <tr>
              <th scope="col" className={cn(TH, "pl-5 pr-3")}>Asesora</th>
              <th scope="col" className={cn(TH, "pr-4")}>
                Actividad por hora <span className="font-normal tabular-nums text-ink-500">07–21 h</span>
              </th>
              <th scope="col" className={cn(TH, "pr-3 text-right")}>
                Horas
                <span className={TH_SUB}>ritmo</span>
              </th>
              <th scope="col" className={cn(TH, "pr-3 text-right")}>
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
              <th scope="col" className={cn(TH, "pl-3 pr-3")} title="% de cierre por día, últimos 7 días · escala 0–50 % · guía punteada en el 10 %">
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
                    <HeatStrip heat={r.heat} max={heatMax} mode={heatMode} startHour={heatStart} />
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <span className="block tabular-nums text-ink-900">
                      {nf1.format(r.horas)} h
                      {r.dias > 1 && <span className="text-xs text-ink-500">{`${SEP}${r.dias} d`}</span>}
                    </span>
                    <Ritmo leads={r.leadsTrabajados} horas={r.horas} />
                  </td>
                  <td className="py-3 pr-3 text-right">
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
                  <td className="py-2 pl-3 pr-3">
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
            {idleNow.map((i) => (
              <tr key={i.userId} className="border-b border-line last:border-0">
                <td className="py-3 pl-5 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-ink-700">{advisorName(i.email)}</span>
                    <OnlineDot online />
                  </span>
                </td>
                <td colSpan={8} className="py-3 pr-5 text-[13px] text-ink-500">
                  En línea, sin actividad registrada en el periodo
                </td>
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
}) {
  const name = advisorName(r.email);
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

        <section className={PANEL_ZONE}>
          <ZoneHead
            title="Actividad por hora"
            help={heatMode === "avg" ? "Leads distintos gestionados por hora, en promedio por día" : "Leads distintos gestionados en cada hora, de todas las fuentes"}
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
