"use client";

// Rutas de Grupo GF Courier en una sola lista (MOM §29.14): una fila por
// motorizado y día, agrupadas por fecha con cabeceras pegajosas, hoy primero.
// Filtros de motorizado y fecha con el mismo picker que Despacho del día. La
// fila abre la caja al lado (`?caja=` / `?ruta=`, courier-box-drawer.tsx).

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MouseEvent } from "react";

// La fila abre el panel con `history.pushState`, que Next sincroniza con
// `useSearchParams`, y no con un <Link>: navegar con el router vuelve a pedir
// la pantalla entera de Grupo GF Courier al servidor (miles de pedidos) y el
// panel tardaba segundos en aparecer. El `href` sigue siendo real: botón
// central, «abrir en pestaña nueva» y copiar el enlace funcionan.
function openInPlace(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState(null, "", href);
}
import { cn } from "@/components/ui";
import { Hint } from "@/components/hint";
import { Chip, Sheet } from "@/components/filter-sheet";
import { courierBoxHref, courierReportHref, courierRouteDrawerHref } from "@/lib/courier-box-href";
import { LEDGER_SITUATION_LABELS, ledgerSituation, type CourierLedgerRow, type CourierLedgerSituation } from "@/lib/courier-route-ledger";
import { routeDayLong } from "@/lib/dispatch";

export const DAY_PARAM = "dia";
export const RIDER_PARAM = "motorizado";

type DayMode = "hoy" | "todas" | "fecha";

const SITUATION_TONE: Record<CourierLedgerSituation, string> = {
  borrador: "bg-slate-100 text-slate-700",
  cotejo_oficina: "bg-amber-50 text-amber-800",
  lista_para_recojo: "bg-sky-50 text-sky-800",
  en_poder_del_courier: "bg-violet-50 text-violet-800",
  en_reparto: "bg-emerald-50 text-emerald-800",
  cerrada: "bg-slate-800 text-white",
  liquidada: "bg-emerald-600 text-white",
};

function money(value: number): string {
  return `S/ ${value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isDay(value: string | null | undefined): value is string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
}

export function CourierRoutesLedger({
  rows,
  riders,
  today,
  unassignedCount = 0,
  onShowUnassigned,
}: {
  rows: CourierLedgerRow[];
  riders: { id: string; fullName: string }[];
  today: string;
  unassignedCount?: number;
  onShowUnassigned?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const search = searchParams.toString();
  const dayParam = searchParams.get(DAY_PARAM);
  const riderParam = searchParams.get(RIDER_PARAM) ?? "";
  const dayMode: DayMode = dayParam === "todas" ? "todas" : isDay(dayParam) ? "fecha" : "hoy";
  const specificDay = isDay(dayParam) ? dayParam : "";
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Motorizado y «hoy/todas» filtran en el navegador; una fecha concreta la
  // trae el servidor (puede ser anterior a lo cargado), así que esa cambia
  // la URL con el router. Los demás solo reescriben la barra.
  function setParams(patch: { day?: string | null; rider?: string | null }, reload = false) {
    const params = new URLSearchParams(search);
    if (patch.day !== undefined) { if (patch.day) params.set(DAY_PARAM, patch.day); else params.delete(DAY_PARAM); }
    if (patch.rider !== undefined) { if (patch.rider) params.set(RIDER_PARAM, patch.rider); else params.delete(RIDER_PARAM); }
    const href = params.toString() ? `${pathname}?${params}` : pathname;
    if (reload) router.replace(href);
    else window.history.replaceState(null, "", href);
  }

  const filtered = useMemo(() => rows.filter((r) =>
    (!riderParam || r.riderId === riderParam)
    && (dayMode === "todas" || (dayMode === "hoy" ? r.routeDate === today : r.routeDate === specificDay)),
  ), [rows, riderParam, dayMode, today, specificDay]);

  const groups = useMemo(() => {
    const map = new Map<string, CourierLedgerRow[]>();
    for (const r of filtered) map.set(r.routeDate, [...(map.get(r.routeDate) ?? []), r]);
    return [...map.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
  }, [filtered]);

  const activeFilters = (riderParam ? 1 : 0) + (dayMode !== "hoy" ? 1 : 0);
  const riderName = (id: string) => riders.find((r) => r.id === id)?.fullName ?? "";
  const location = { pathname, search };
  const rowHref = (r: CourierLedgerRow) => r.manifestId ? courierBoxHref(r.manifestId, location) : courierRouteDrawerHref(r.routeId, location);
  // «Liquidación» abre el reparto y cierre de la ruta en el mismo panel lateral.
  const reportHref = (r: CourierLedgerRow) => courierReportHref(r.routeId, location);

  return (
    <section aria-label="Rutas y cajas" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            className={cn("min-h-10 rounded-lg border px-3 text-sm font-medium", activeFilters ? "border-brand-300 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-700 hover:bg-slate-50")}
          >
            Filtros{activeFilters ? ` · ${activeFilters}` : ""}
          </button>
          {filtersOpen && (
            <Sheet title="Filtros" onClose={() => setFiltersOpen(false)} anchored>
              <div className="grid gap-3 text-sm">
                <label className="grid gap-1 text-xs font-medium text-slate-600">Motorizado
                  <select value={riderParam} onChange={(e) => setParams({ rider: e.target.value })} className="block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900">
                    <option value="">Todos</option>
                    {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-600">Fecha
                  <select value={dayMode} onChange={(e) => { const v = e.target.value as DayMode; if (v === "hoy") setParams({ day: null }); else if (v === "todas") setParams({ day: "todas" }); else setParams({ day: today }, true); }} className="block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900">
                    <option value="hoy">Hoy</option>
                    <option value="fecha">Un día concreto</option>
                    <option value="todas">Todas</option>
                  </select>
                </label>
                {dayMode === "fecha" && (
                  <label className="grid gap-1 text-xs font-medium text-slate-600">Día
                    <input type="date" value={specificDay} max={today} onChange={(e) => { if (isDay(e.target.value)) setParams({ day: e.target.value }, true); }} className="block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900" />
                  </label>
                )}
                {activeFilters > 0 && <button type="button" onClick={() => setParams({ day: null, rider: null }, dayMode === "fecha")} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700">Quitar filtros</button>}
              </div>
            </Sheet>
          )}
        </div>
        {activeFilters > 0 && (
          <ul className="flex flex-wrap gap-1.5 text-xs" aria-label="Filtros activos">
            {riderParam && <Chip onRemove={() => setParams({ rider: null })}>{riderName(riderParam)}</Chip>}
            {dayMode === "todas" && <Chip onRemove={() => setParams({ day: null })}>todas las fechas</Chip>}
            {dayMode === "fecha" && <Chip onRemove={() => setParams({ day: null }, true)}>{routeDayLong(specificDay)}</Chip>}
          </ul>
        )}
        <span className="text-xs text-slate-500">{filtered.length} ruta{filtered.length === 1 ? "" : "s"}</span>
        {unassignedCount > 0 && onShowUnassigned && (
          <button type="button" onClick={onShowUnassigned} className="ml-auto min-h-10 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-800 hover:bg-amber-100">
            {unassignedCount} pedido{unassignedCount === 1 ? "" : "s"} sin ruta →
          </button>
        )}
      </div>

      <div className="max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {!groups.length && (
          <p className="px-4 py-12 text-center text-sm text-slate-500">
            {dayMode === "hoy" ? "Hoy no hay rutas todavía. Asigna pedidos desde Despacho del día." : "No hay rutas con esos filtros."}
          </p>
        )}
        {/* Desktop: tabla con una cabecera por fecha. Sin filas no se pinta:
            la cabecera de columnas debajo del aviso vacío desconcertaba. */}
        {groups.length > 0 && (
        <table className="hidden w-full text-sm lg:table">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Motorizado</th>
              <th className="px-3 py-2.5 font-medium">Situación</th>
              <th className="px-3 py-2.5 text-center font-medium">Asignados</th>
              <th className="px-3 py-2.5 text-center font-medium">Armados</th>
              <th className="px-3 py-2.5 text-center font-medium">Cotejados</th>
              <th className="px-3 py-2.5 text-center font-medium">Recibidos</th>
              <th className="px-3 py-2.5 text-right font-medium">Efectivo</th>
              <th className="px-4 py-2.5 font-medium"><span className="inline-flex items-center gap-1">Avance <Hint text="Con caja, dos barras: verde, cotejados por oficina; morada, recibidos por el motorizado con «Lo llevo». Sin caja: paradas ya reportadas." /></span></th>
              <th className="px-3 py-2.5 font-medium">Liquidación</th>
            </tr>
          </thead>
          {groups.map(([day, list]) => (
            <tbody key={day}>
              <tr>
                <th colSpan={9} scope="rowgroup" className="sticky top-[37px] z-10 border-y border-slate-200 bg-white px-4 py-2 text-left text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
                  {day === today ? "Hoy · " : ""}{routeDayLong(day)}
                </th>
              </tr>
              {list.map((r) => <LedgerRow key={r.routeId} row={r} href={rowHref(r)} reportHref={reportHref(r)} />)}
            </tbody>
          ))}
        </table>
        )}
        {/* Móvil: tarjetas bajo cada fecha. */}
        <div className="lg:hidden">
          {groups.map(([day, list]) => (
            <div key={day}>
              <p className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">{day === today ? "Hoy · " : ""}{routeDayLong(day)}</p>
              <ul className="divide-y divide-slate-100">
                {list.map((r) => <LedgerCard key={r.routeId} row={r} href={rowHref(r)} reportHref={reportHref(r)} />)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

type Bar = { pct: number; text: string; tone: "emerald" | "violet" };

/**
 * Con caja, dos barras: el cotejo de oficina y lo que el motorizado ya
 * recibió («Lo llevo»), que son los dos controles físicos de la caja. Sin
 * caja (rutas del cuaderno), una sola: paradas ya reportadas.
 */
function progressOf(r: CourierLedgerRow): Bar[] {
  if (r.manifestId && r.officeCheckedCount != null && r.pickupCheckedCount != null) {
    const pct = (n: number) => (r.assignedCount ? Math.round((n / r.assignedCount) * 100) : 0);
    const office = r.assignedCount - r.officeCheckedCount;
    const pickup = r.assignedCount - r.pickupCheckedCount;
    return [
      { pct: pct(r.officeCheckedCount), text: office > 0 ? `${office} por cotejar` : "Caja cotejada", tone: "emerald" },
      { pct: pct(r.pickupCheckedCount), text: pickup > 0 ? `${pickup} sin recibir` : "Recibida por el motorizado", tone: "violet" },
    ];
  }
  const pct = r.assignedCount ? Math.round((r.reportedCount / r.assignedCount) * 100) : 0;
  return [{ pct, text: `${r.deliveredCount} entregados · ${r.reportedCount - r.deliveredCount} no`, tone: "emerald" }];
}

function ProgressBars({ bars, compact = false }: { bars: Bar[]; compact?: boolean }) {
  return (
    <div className={cn("space-y-1", compact ? "mt-2" : "min-w-[180px]")}>
      {bars.map((bar) => (
        <div key={bar.text + bar.tone} className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <div className={cn("h-full rounded-full", bar.tone === "violet" ? "bg-violet-500" : "bg-emerald-500")} style={{ width: `${bar.pct}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-slate-600">{bar.pct}%</span>
          {compact && <span className="truncate text-xs text-slate-500">{bar.text}</span>}
        </div>
      ))}
      {!compact && <p className="text-xs text-slate-500">{bars.map((b) => b.text).join(" · ")}</p>}
    </div>
  );
}

function settlementLabel(status: string | null): string {
  if (!status) return "—";
  return status === "borrador" ? "Borrador" : status.charAt(0).toUpperCase() + status.slice(1);
}

/** Celda «Liquidación»: el estado si ya hay liquidación, o el acceso al reparto y cierre. */
function ReportLink({ row, href, className }: { row: CourierLedgerRow; href: string; className?: string }) {
  const label = row.settlementStatus ? settlementLabel(row.settlementStatus) : "Reparto y liquidación";
  return (
    <a href={href} onClick={(e) => openInPlace(e, href)} title="Paradas, cierre de la ruta y pago del motorizado" className={cn("inline-flex items-center gap-1 whitespace-nowrap font-medium text-brand-700 hover:underline", className)}>
      {label}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
    </a>
  );
}

function LedgerRow({ row, href, reportHref }: { row: CourierLedgerRow; href: string; reportHref: string }) {
  const situation = ledgerSituation(row);
  const progress = progressOf(row);
  const dash = (n: number | null) => (n == null ? "—" : n);
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
      <td className="px-4 py-2.5">
        <a href={href} onClick={(e) => openInPlace(e, href)} className="font-semibold text-slate-950 hover:underline">{row.riderName}</a>
        <p className="text-xs text-slate-500">{row.manifestId ? `Carga ${row.loadNumber ?? 1}` : "Sin caja"}</p>
      </td>
      <td className="px-3 py-2.5"><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", SITUATION_TONE[situation])}>{LEDGER_SITUATION_LABELS[situation]}</span></td>
      <td className="px-3 py-2.5 text-center font-semibold tabular-nums text-slate-900">{row.assignedCount}</td>
      <td className="px-3 py-2.5 text-center tabular-nums text-sky-700">{dash(row.armedCount)}</td>
      <td className="px-3 py-2.5 text-center tabular-nums text-emerald-700">{dash(row.officeCheckedCount)}</td>
      <td className="px-3 py-2.5 text-center tabular-nums text-violet-700">{dash(row.pickupCheckedCount)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{money(row.codAmount)}</td>
      <td className="px-4 py-2.5"><ProgressBars bars={progress} /></td>
      <td className="px-3 py-2.5 text-xs"><ReportLink row={row} href={reportHref} /></td>
    </tr>
  );
}

function LedgerCard({ row, href, reportHref }: { row: CourierLedgerRow; href: string; reportHref: string }) {
  const situation = ledgerSituation(row);
  const progress = progressOf(row);
  return (
    <li>
      <a href={href} onClick={(e) => openInPlace(e, href)} className="block px-4 py-3 hover:bg-slate-50">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-slate-950">{row.riderName}</p>
            <p className="text-xs text-slate-500">{row.manifestId ? `Carga ${row.loadNumber ?? 1}` : "Sin caja"} · {row.assignedCount} paq. · {money(row.codAmount)}</p>
          </div>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", SITUATION_TONE[situation])}>{LEDGER_SITUATION_LABELS[situation]}</span>
        </div>
        <ProgressBars bars={progress} compact />
        {row.manifestId && <p className="mt-1 text-xs text-slate-500">armados {row.armedCount} · cotejados {row.officeCheckedCount} · recibidos {row.pickupCheckedCount}</p>}
      </a>
      <div className="px-4 pb-3 text-xs"><ReportLink row={row} href={reportHref} /></div>
    </li>
  );
}
