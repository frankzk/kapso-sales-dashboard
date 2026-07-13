"use client";

import { Fragment, useEffect, useState } from "react";
import { cn } from "@/components/ui";
import { CHART } from "@/components/palette";
import { categoryOf, labelOf, LEAD_SEGMENTS, type LeadSegment } from "@/lib/leads";
import { getOnlineAdvisorIds, loadAgentLeads } from "@/app/dashboard/productividad/actions";
import { RITMO_MIN_HORA, heatStatuses, ritmoPorHora } from "@/lib/heat";
// Type-only import: pulling runtime values from lib/productivity would drag the
// whole server data layer (supabase clients) into this client bundle.
import type { AdvisorBoardRow, AgentLeadRow, SourceBucket, TrendCell } from "@/lib/productivity";

const ONLINE_POLL_MS = 45_000; // refresco de los puntos "en línea"

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Tiny ↑/↓ change vs the previous period, rendered after a metric value. */
function DeltaInline({ value, fmt }: { value: number; fmt: (n: number) => string }) {
  if (value === 0) return <span className="ml-1 align-middle text-[11px] text-slate-300">→</span>;
  const up = value > 0;
  return (
    <span className={cn("ml-1 align-middle text-[11px] font-medium", up ? "text-emerald-600" : "text-rose-500")}>
      {up ? "↑" : "↓"}
      {fmt(Math.abs(value))}
    </span>
  );
}

/** Show the name part of the email (before @) as a friendlier label. */
function advisorName(email: string): string {
  return email.includes("@") ? email.split("@")[0]! : email;
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
}

const SOURCE_CHIP: Record<SourceBucket, { label: string; glyph: string; cls: string }> = {
  meta_ad: { label: "Campaña", glyph: "📣", cls: "bg-sky-50 text-sky-700" },
  fb_web: { label: "Meta/Web", glyph: "🌐", cls: "bg-cyan-50 text-cyan-700" },
  cod_cart: { label: "Carrito", glyph: "🛒", cls: "bg-amber-50 text-amber-700" },
  abandoned_browse: { label: "Búsqueda", glyph: "🔎", cls: "bg-orange-50 text-orange-700" },
  organic: { label: "Orgánico", glyph: "Org", cls: "bg-slate-100 text-slate-600" },
};

const SEGMENT_CHIP: Record<LeadSegment, { cls: string }> = {
  carrito: { cls: "bg-emerald-50 text-emerald-700" },
  distrito: { cls: "bg-violet-50 text-violet-700" },
  converso: { cls: "bg-sky-50 text-sky-700" },
  frio: { cls: "bg-slate-100 text-slate-500" },
};

function segmentLabel(key: LeadSegment): string {
  return LEAD_SEGMENTS.find((s) => s.key === key)?.label ?? key;
}

function statusClass(status: string): string {
  const cat = categoryOf(status);
  if (cat === "won") return "text-emerald-700";
  if (cat === "lost") return "text-slate-400";
  return "text-slate-700";
}

// ── Celdas visuales (divs/SVG a mano — recharts por fila sería pesadísimo) ─────

// CHART.brand ("#2f74ff") → "r, g, b" para pintar la celda con alpha en el
// FONDO (usar opacity en el elemento desvanecería también el número de adentro).
const BRAND_RGB = (() => {
  const h = CHART.brand.replace("#", "");
  return `${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}`;
})();

/** Franja de actividad 08–20h: 13 celdas con el NÚMERO de leads distintos
 *  gestionados esa hora adentro, y SEMÁFORO de ritmo juzgado dentro de la
 *  jornada real (heatStatuses): azul = a ritmo (≥RITMO_MIN_HORA, tinte por
 *  intensidad vs el máximo global), ámbar = bajo ritmo, rojo suave = hora
 *  muerta en pleno turno, gris = fuera de jornada (no se juzga). */
function HeatStrip({
  heat,
  max,
  mode,
  startHour,
}: {
  heat: number[];
  max: number;
  mode: "day" | "avg";
  startHour: number;
}) {
  const statuses = heatStatuses(heat);
  return (
    <span className="inline-flex gap-[2px] align-middle">
      {heat.map((v, i) => {
        const hour = startHour + i;
        const status = statuses[i]!;
        const unit = mode === "avg" ? `${v} leads/día (prom.)` : `${v} ${v === 1 ? "lead gestionado" : "leads gestionados"}`;
        const title =
          status === "muerta"
            ? `${hour}h — hora muerta: 0 leads en plena jornada (mín. ${RITMO_MIN_HORA}/h)`
            : status === "bajo"
              ? `${hour}h — ${unit} · bajo ritmo (mín. ${RITMO_MIN_HORA}/h)`
              : status === "ok"
                ? `${hour}h — ${unit} · a ritmo`
                : `${hour}h — fuera de su jornada`;
        const n = Math.round(v);
        const intensity = Math.min(1, v / max);
        return (
          <span
            key={hour}
            title={title}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-[4px] text-[9px] leading-none font-semibold tabular-nums",
              status === "fuera" && "bg-slate-100",
              status === "muerta" && "bg-rose-200 text-rose-900",
              status === "bajo" && "bg-amber-200 text-amber-900",
              status === "ok" && (intensity > 0.55 ? "text-white" : "text-slate-700"),
            )}
            style={
              status === "ok"
                ? { backgroundColor: `rgba(${BRAND_RGB}, ${(0.15 + 0.85 * intensity).toFixed(2)})` }
                : undefined
            }
          >
            {v > 0 && n > 0 ? n : ""}
          </span>
        );
      })}
    </span>
  );
}

/** Sparkline SVG (sin librerías) del % de cierre diario de los últimos 7 días.
 *  Escala 0–50% (donde vive el negocio: duplica la resolución visual; >50% se
 *  recorta arriba pero el número muestra el % real), con el % de cada día
 *  VISIBLE encima de su punto, guía punteada en el 10% (el piso esperado del
 *  equipo) y tooltip propio INSTANTÁNEO (el `title` nativo tarda ~1s). */
function Sparkline({ trend }: { trend: TrendCell[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 140;
  const H = 36;
  const TOP = 14; // y del 50%
  const BOTTOM = H - 4; // y del 0%
  const SCALE_MAX = 0.5;
  const FLOOR = 0.1; // guía del 10%
  const stepX = trend.length > 1 ? (W - 12) / (trend.length - 1) : 0;
  const pts = trend.map((t, i) => {
    const rate = t.contactos > 0 ? Math.min(1, t.pedidos / t.contactos) : t.pedidos > 0 ? 1 : 0;
    const idle = t.contactos === 0 && t.pedidos === 0;
    const y = BOTTOM - (BOTTOM - TOP) * Math.min(1, rate / SCALE_MAX);
    return { x: 6 + i * stepX, y, rate, idle, t };
  });
  const floorY = BOTTOM - (BOTTOM - TOP) * (FLOOR / SCALE_MAX);
  const h = hover != null ? pts[hover] : null;
  return (
    <span className="relative inline-block align-middle">
      <svg width={W} height={H} role="img" aria-label="Tendencia de cierre 7 días (escala 0–50%)">
        {/* piso esperado: 10% */}
        <line x1={4} x2={W - 4} y1={floorY} y2={floorY} stroke={CHART.slate} strokeDasharray="2 3" opacity={0.35} />
        <polyline
          points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={CHART.green}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* % visible de cada día (los días sin actividad no llevan número) */}
        {pts.map(
          (p, i) =>
            !p.idle && (
              <text
                key={`n${p.t.date}`}
                x={p.x}
                y={9}
                textAnchor="middle"
                fontSize="8.5"
                fontWeight="600"
                fill={hover === i ? CHART.green : CHART.slate}
              >
                {Math.round(p.rate * 100)}
              </text>
            ),
        )}
        {pts.map((p, i) => (
          <circle
            key={p.t.date}
            cx={p.x}
            cy={p.y}
            r={hover === i ? 3.2 : 2.4}
            fill={p.idle ? CHART.slate : CHART.green}
            opacity={p.idle ? 0.45 : 1}
          />
        ))}
        {/* zonas de hover generosas (columna completa por día) → tooltip al instante */}
        {pts.map((p, i) => (
          <rect
            key={`h${p.t.date}`}
            x={p.x - stepX / 2}
            y={0}
            width={stepX}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {h && (
        <span
          className="pointer-events-none absolute z-20 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] whitespace-nowrap text-slate-600 shadow-sm"
          style={{ left: Math.min(Math.max(h.x - 45, 0), W - 90), top: -22 }}
        >
          {h.t.label} {h.t.date.slice(8, 10)}/{h.t.date.slice(5, 7)} —{" "}
          <span className="font-semibold text-emerald-700">{h.t.pedidos}</span>/{h.t.contactos} ·{" "}
          {Math.round(h.rate * 100)}%
        </span>
      )}
    </span>
  );
}

/** Chips compactos "2×📣 1×🛒" con los cierres por fuente de la fila. */
function SourceMiniChips({ porFuente, currency }: { porFuente: AdvisorBoardRow["porFuente"]; currency: string }) {
  const entries = (Object.keys(SOURCE_CHIP) as SourceBucket[])
    .map((k) => ({ k, cell: porFuente[k] }))
    .filter((e) => e.cell.cerrados > 0);
  if (!entries.length) return <span className="text-slate-300">—</span>;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {entries.map(({ k, cell }) => {
        const c = SOURCE_CHIP[k];
        return (
          <span
            key={k}
            title={`${cell.cerrados} cierre${cell.cerrados === 1 ? "" : "s"} · ${c.label} · ${money(cell.ingresos, currency)}`}
            className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap", c.cls)}
          >
            {cell.cerrados}×{c.glyph}
          </span>
        );
      })}
    </span>
  );
}

/** Chips "AUR 5 · KP 12": pedidos cerrados por tienda dentro de la fila. Con una
 *  sola tienda en el filtro queda su chip solo (el desglose viene del scope). */
function StoreMiniChips({
  porTienda,
  storeInfo,
  currency,
}: {
  porTienda: AdvisorBoardRow["porTienda"];
  storeInfo: Record<string, { short: string; name: string }>;
  currency: string;
}) {
  const entries = Object.entries(porTienda)
    .filter(([, c]) => c.cerrados > 0)
    .sort((a, b) => (storeInfo[a[0]]?.short ?? "?").localeCompare(storeInfo[b[0]]?.short ?? "?"));
  if (!entries.length) return null;
  return (
    <span className="mt-1 flex justify-end gap-1">
      {entries.map(([sid, c]) => (
        <span
          key={sid}
          title={`${storeInfo[sid]?.name ?? "Otra tienda"} — ${c.cerrados} pedido${c.cerrados === 1 ? "" : "s"} · ${money(c.ingresos, currency)}`}
          className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-slate-500"
        >
          {storeInfo[sid]?.short ?? "?"} {c.cerrados}
        </span>
      ))}
    </span>
  );
}

/** Punto de presencia: verde pulsante = con el dashboard abierto ahora. */
function OnlineDot({ online }: { online: boolean }) {
  if (!online) return null;
  return (
    <span
      title="En línea ahora (dashboard abierto)"
      className="ml-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 align-middle"
    />
  );
}

type DrillContext = {
  from: string;
  to: string;
  store: string | null;
  source: SourceBucket | null;
};

type LoadState = AgentLeadRow[] | "loading" | "error" | undefined;

/** Resumen "barril roto": cerrados/trabajados por segmento de calidad del lead.
 *  Un segmento trabajado con 0 cierres se tiñe rojo — ahí está el eslabón débil. */
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
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 text-[11px]">
      <span className="text-slate-400">Cierra por tipo:</span>
      {parts.map((s) => {
        const e = agg.get(s.key)!;
        const broken = e.won === 0 && e.total >= 3; // trabajó varios y no cerró ninguno
        return (
          <span
            key={s.key}
            title={`${s.label}: cerró ${e.won} de ${e.total} trabajados`}
            className={cn(
              "rounded-md px-1.5 py-0.5 font-medium",
              broken ? "bg-rose-50 text-rose-600" : SEGMENT_CHIP[s.key].cls,
            )}
          >
            {s.label} {e.won}/{e.total}
          </span>
        );
      })}
    </div>
  );
}

function AgentLeads({ state, currency }: { state: LoadState; currency: string }) {
  if (state === "loading") return <p className="px-3 py-3 text-sm text-slate-400">Cargando leads…</p>;
  if (state === "error")
    return <p className="px-3 py-3 text-sm text-rose-500">No se pudieron cargar los leads.</p>;
  if (!state || !state.length)
    return <p className="px-3 py-3 text-sm text-slate-400">Sin leads trabajados en este período.</p>;

  return (
    <div className="pb-1">
      <SegmentSummary rows={state} />
      <div className="overflow-x-auto px-1 py-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500">
              <th className="py-2 pl-2 text-left font-medium">Lead</th>
              <th className="py-2 text-left font-medium">Estado</th>
              <th className="py-2 text-left font-medium">Fuente</th>
              <th className="py-2 text-left font-medium">Segmento</th>
              <th className="py-2 text-right font-medium">Llam.</th>
              <th className="py-2 text-right font-medium">Resultado</th>
              <th className="py-2 pr-2 text-right font-medium">Últ. toque</th>
            </tr>
          </thead>
          <tbody>
            {state.map((l) => {
              const chip = SOURCE_CHIP[l.source];
              return (
                <tr key={l.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pl-2 text-left">
                    <div className="font-medium text-slate-800">{l.name || "Sin nombre"}</div>
                    {l.phone && <div className="text-xs text-slate-400">{l.phone}</div>}
                  </td>
                  <td className={cn("py-2 text-left", statusClass(l.status))}>{labelOf(l.status)}</td>
                  <td className="py-2 text-left">
                    <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", chip.cls)}>
                      {chip.glyph === "Org" ? chip.label : `${chip.glyph} ${chip.label}`}
                    </span>
                  </td>
                  <td className="py-2 text-left">
                    <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", SEGMENT_CHIP[l.segment].cls)}>
                      {segmentLabel(l.segment)}
                    </span>
                  </td>
                  <td className="py-2 text-right text-slate-600">{l.llamadas}</td>
                  <td className="py-2 text-right">
                    {l.won ? (
                      <span className="font-semibold text-emerald-700">{money(l.net, currency)}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right text-xs text-slate-400">{shortWhen(l.lastTouch)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Dense one-screen advisor table. Column order tells the story left→right:
 *  presencia → esfuerzo (actividad/horas/leads/llamadas) → eficiencia (% cierre,
 *  tendencia) → resultado (cerrados, fuentes, ingresos). Rows expand to the
 *  lazy-loaded drill-down. The scroll container lives in the PARENT (sticky
 *  header needs a single overflow ancestor). */
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
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, LoadState>>({});
  const [onlineIds, setOnlineIds] = useState<Set<string>>(() => new Set(initialOnlineIds));

  // Live presence dots: poll every 45s while the tab is visible (same pattern
  // as the Yape alerts poller). Initial state comes from the server render.
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      if (document.hidden) return;
      try {
        const ids = await getOnlineAdvisorIds();
        if (!stopped) setOnlineIds(new Set(ids));
      } catch {
        /* best-effort: el dot se queda como estaba */
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

  if (!rows.length && !onlineIdle.length)
    return <p className="p-4 text-sm text-slate-400">Sin actividad de asesoras en este período.</p>;

  async function toggle(userId: string) {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    const cur = cache[userId];
    if (cur && cur !== "error") return; // already loaded or loading
    setCache((c) => ({ ...c, [userId]: "loading" }));
    try {
      const leads = await loadAgentLeads({ vendedoraId: userId, ...ctx });
      setCache((c) => ({ ...c, [userId]: leads }));
    } catch {
      setCache((c) => ({ ...c, [userId]: "error" }));
    }
  }

  // Solo se muestran como "en línea sin actividad" las que SIGUEN online.
  const idleNow = onlineIdle.filter((i) => onlineIds.has(i.userId));

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_#e2e8f0]">
        <tr className="text-xs text-slate-500">
          <th className="px-3 py-2 text-left font-medium">Asesora</th>
          <th
            className="py-2 text-left font-medium"
            title={`Leads distintos gestionados por hora (08–20h), todas las fuentes · azul = a ritmo (≥${RITMO_MIN_HORA}/h) · ámbar = bajo ritmo · rojo = hora muerta en plena jornada · gris = fuera de jornada`}
          >
            Actividad 08–20h
          </th>
          <th className="py-2 text-right font-medium">Horas</th>
          <th className="py-2 text-right font-medium">Leads</th>
          <th className="py-2 text-right font-medium">Llamadas</th>
          <th className="py-2 text-right font-medium">% cierre</th>
          <th
            className="py-2 pl-3 text-left font-medium"
            title="% de cierre por día, últimos 7 días · escala 0–50% · guía punteada = piso del 10%"
          >
            Tendencia 7d
          </th>
          <th
            className="cursor-help py-2 text-right font-medium"
            title="El pedido se acredita a la asesora del ÚLTIMO toque sobre el lead (llamada, mensaje o venta)"
          >
            Cerrados ⓘ
          </th>
          <th className="py-2 pl-3 text-right font-medium">Fuentes</th>
          <th className="px-3 py-2 text-right font-medium">Ingresos</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const open = expanded === r.userId;
          const showDelta = hasPrev && !r.delta.isNew; // hide arrows when there's no baseline
          return (
            <Fragment key={r.userId}>
              <tr
                onClick={() => toggle(r.userId)}
                className={cn(
                  "cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50",
                  open && "bg-slate-50",
                )}
              >
                <td className="px-3 py-2.5 text-left whitespace-nowrap">
                  <span className="mr-1.5 inline-block text-slate-400" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="font-medium text-slate-800">{advisorName(r.email)}</span>
                  <OnlineDot online={onlineIds.has(r.userId)} />
                  {hasPrev && r.delta.isNew && (
                    <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-600">
                      nuevo
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-left">
                  <HeatStrip heat={r.heat} max={heatMax} mode={heatMode} startHour={heatStart} />
                </td>
                <td className="py-2.5 text-right whitespace-nowrap">
                  <span className="text-slate-700">{r.horas}h</span>
                  {r.dias > 1 && <span className="ml-1 text-xs text-slate-400">· {r.dias}d</span>}
                  {(() => {
                    const ritmo = ritmoPorHora(r.leadsTrabajados, r.horas);
                    if (ritmo == null) return null;
                    const ok = ritmo >= RITMO_MIN_HORA;
                    return (
                      <span className="mt-1 flex justify-end">
                        <span
                          title={`Ritmo global: ${r.leadsTrabajados} leads ÷ ${r.horas}h activas · mínimo ${RITMO_MIN_HORA}/h`}
                          className={cn(
                            "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                            ok ? "bg-brand-50 text-brand-700" : "bg-amber-100 text-amber-800",
                          )}
                        >
                          {ritmo}/h
                        </span>
                      </span>
                    );
                  })()}
                </td>
                <td className="py-2.5 text-right text-slate-700">{r.leadsTrabajados}</td>
                <td className="py-2.5 text-right text-slate-700">{r.llamadas}</td>
                <td className="py-2.5 text-right whitespace-nowrap text-slate-700">
                  {pct(r.conversion)}
                  {showDelta && <DeltaInline value={r.delta.conversionPP} fmt={(n) => `${n}pp`} />}
                </td>
                <td className="py-2.5 pl-3 text-left">
                  <Sparkline trend={r.trend} />
                </td>
                <td className="py-2.5 text-right whitespace-nowrap text-slate-700">
                  <span>
                    {r.cerrados}
                    {showDelta && <DeltaInline value={r.delta.cerrados} fmt={(n) => String(n)} />}
                  </span>
                  <StoreMiniChips porTienda={r.porTienda} storeInfo={storeInfo} currency={currency} />
                </td>
                <td className="py-2.5 pl-3 text-right">
                  <SourceMiniChips porFuente={r.porFuente} currency={currency} />
                </td>
                <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap text-emerald-700">
                  {money(r.ingresos, currency)}
                  {showDelta && <DeltaInline value={r.delta.ingresos} fmt={(n) => money(n, currency)} />}
                </td>
              </tr>
              {open && (
                <tr>
                  <td colSpan={10} className="bg-slate-50/60 p-0">
                    <AgentLeads state={cache[r.userId]} currency={currency} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        {idleNow.map((i) => (
          <tr key={i.userId} className="border-b border-slate-100 text-slate-400 last:border-0">
            <td className="px-3 py-2.5 text-left whitespace-nowrap">
              <span className="mr-1.5 inline-block opacity-0" aria-hidden>
                ▸
              </span>
              <span className="font-medium">{advisorName(i.email)}</span>
              <OnlineDot online />
            </td>
            <td colSpan={9} className="py-2.5 pl-1 text-left text-xs italic">
              En línea · sin actividad registrada en el período
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
