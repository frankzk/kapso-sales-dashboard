"use client";

// Rutas de Grupo GF Courier en una sola lista (MOM §29.14): una fila por
// motorizado y día, agrupadas por fecha con cabeceras pegajosas, hoy primero.
// Filtros de motorizado y fecha con el mismo picker que Despacho del día. La
// fila abre la caja al lado (`?caja=` / `?ruta=`, courier-box-drawer.tsx).

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { Hint } from "@/components/hint";
import { Chip, Sheet } from "@/components/filter-sheet";
import { courierBoxHref, courierRouteDrawerHref } from "@/lib/courier-box-href";
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
              <th className="px-4 py-2.5 font-medium"><span className="inline-flex items-center gap-1">Avance <Hint text="Con caja: paquetes cotejados por oficina. Sin caja: paradas ya reportadas por el motorizado." /></span></th>
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
              {list.map((r) => <LedgerRow key={r.routeId} row={r} href={rowHref(r)} />)}
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
                {list.map((r) => <LedgerCard key={r.routeId} row={r} href={rowHref(r)} />)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function progressOf(r: CourierLedgerRow): { pct: number; text: string } {
  if (r.manifestId && r.officeCheckedCount != null) {
    const pct = r.assignedCount ? Math.round((r.officeCheckedCount / r.assignedCount) * 100) : 0;
    const left = r.assignedCount - r.officeCheckedCount;
    return { pct, text: left > 0 ? `${left} por cotejar` : "Caja cotejada" };
  }
  const pct = r.assignedCount ? Math.round((r.reportedCount / r.assignedCount) * 100) : 0;
  return { pct, text: `${r.deliveredCount} entregados · ${r.reportedCount - r.deliveredCount} no` };
}

function settlementLabel(status: string | null): string {
  if (!status) return "—";
  return status === "borrador" ? "Borrador" : status.charAt(0).toUpperCase() + status.slice(1);
}

function LedgerRow({ row, href }: { row: CourierLedgerRow; href: string }) {
  const situation = ledgerSituation(row);
  const progress = progressOf(row);
  const dash = (n: number | null) => (n == null ? "—" : n);
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
      <td className="px-4 py-2.5">
        <Link href={href} className="font-semibold text-slate-950 hover:underline">{row.riderName}</Link>
        <p className="text-xs text-slate-500">{row.manifestId ? `Carga ${row.loadNumber ?? 1}` : "Sin caja"}</p>
      </td>
      <td className="px-3 py-2.5"><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", SITUATION_TONE[situation])}>{LEDGER_SITUATION_LABELS[situation]}</span></td>
      <td className="px-3 py-2.5 text-center font-semibold tabular-nums text-slate-900">{row.assignedCount}</td>
      <td className="px-3 py-2.5 text-center tabular-nums text-sky-700">{dash(row.armedCount)}</td>
      <td className="px-3 py-2.5 text-center tabular-nums text-emerald-700">{dash(row.officeCheckedCount)}</td>
      <td className="px-3 py-2.5 text-center tabular-nums text-violet-700">{dash(row.pickupCheckedCount)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{money(row.codAmount)}</td>
      <td className="px-4 py-2.5">
        <div className="flex min-w-36 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress.pct}%` }} /></div>
          <span className="w-9 text-right text-xs tabular-nums text-slate-600">{progress.pct}%</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">{progress.text}</p>
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-600">{settlementLabel(row.settlementStatus)}</td>
    </tr>
  );
}

function LedgerCard({ row, href }: { row: CourierLedgerRow; href: string }) {
  const situation = ledgerSituation(row);
  const progress = progressOf(row);
  return (
    <li>
      <Link href={href} className="block px-4 py-3 hover:bg-slate-50">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-slate-950">{row.riderName}</p>
            <p className="text-xs text-slate-500">{row.manifestId ? `Carga ${row.loadNumber ?? 1}` : "Sin caja"} · {row.assignedCount} paq. · {money(row.codAmount)}</p>
          </div>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", SITUATION_TONE[situation])}>{LEDGER_SITUATION_LABELS[situation]}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress.pct}%` }} /></div>
          <span className="text-xs tabular-nums text-slate-600">{progress.text}</span>
        </div>
        {row.manifestId && <p className="mt-1 text-xs text-slate-500">armados {row.armedCount} · cotejados {row.officeCheckedCount} · recibidos {row.pickupCheckedCount}{row.settlementStatus ? ` · liquidación ${settlementLabel(row.settlementStatus).toLowerCase()}` : ""}</p>}
      </Link>
    </li>
  );
}
