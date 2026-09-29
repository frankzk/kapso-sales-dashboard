"use client";

// Rutas de Grupo GF Courier en una sola lista (MOM §29.14): una fila por
// motorizado y día, agrupadas por fecha con cabeceras pegajosas, hoy primero.
// Filtros de motorizado y fecha con el mismo picker que Despacho del día. La
// fila abre la caja al lado (`?caja=` / `?ruta=`, courier-box-drawer.tsx).
// Mundo de operación (29-09-2026, DESIGN.md): filtros en píldoras, situación
// en chapas y una tabla de líneas finas, como Despacho del día.

import { useMemo, useRef, useState, useTransition } from "react";
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
import { Sheet } from "@/components/filter-sheet";
import { AttentionPill, Badge, FIELD, FilterPill, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { IconPackage } from "@/components/icons";
import { courierBoxHref, courierReportHref, courierRouteDrawerHref } from "@/lib/courier-box-href";
import { LEDGER_SITUATION_LABELS, ledgerSituation, type CourierLedgerRow, type CourierLedgerSituation } from "@/lib/courier-route-ledger";
import { routeDayLong } from "@/lib/dispatch";

export const DAY_PARAM = "dia";
export const RIDER_PARAM = "motorizado";

type DayMode = "hoy" | "todas" | "fecha";

const SITUATION_TONE: Record<CourierLedgerSituation, BadgeTone> = {
  borrador: "neutral",
  cotejo_oficina: "warn",
  lista_para_recojo: "info",
  en_poder_del_courier: "info",
  en_reparto: "info",
  cerrada: "neutral",
  liquidada: "ok",
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
  const [openPill, setOpenPill] = useState<"fecha" | "motorizado" | null>(null);

  // Motorizado, «hoy/todas» y cualquier día que ya esté cargado filtran en el
  // navegador: solo se reescribe la barra. Al servidor se va únicamente por un
  // día que no está en las filas (anterior a las últimas 150 rutas), y se
  // avisa mientras tarda: la página entera se vuelve a calcular. Antes
  // «Quitar filtros», la × del chip y elegir «Un día concreto» también iban al
  // servidor, y el picker parecía no responder durante esos segundos.
  const [navPending, startNav] = useTransition();
  const loadedDays = useMemo(() => new Set(rows.map((r) => r.routeDate)), [rows]);
  function setParams(patch: { day?: string | null; rider?: string | null }) {
    const params = new URLSearchParams(search);
    if (patch.day !== undefined) { if (patch.day) params.set(DAY_PARAM, patch.day); else params.delete(DAY_PARAM); }
    if (patch.rider !== undefined) { if (patch.rider) params.set(RIDER_PARAM, patch.rider); else params.delete(RIDER_PARAM); }
    const href = params.toString() ? `${pathname}?${params}` : pathname;
    const needsServer = isDay(patch.day) && !loadedDays.has(patch.day);
    if (needsServer) startNav(() => router.replace(href));
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
  const dayPill = useRef<HTMLButtonElement>(null);
  const riderPill = useRef<HTMLButtonElement>(null);
  const dayValue = dayMode === "todas" ? "Todas" : dayMode === "fecha" ? routeDayLong(specificDay) : "Hoy";
  const riderName = (id: string) => riders.find((r) => r.id === id)?.fullName ?? "";
  const location = { pathname, search };
  const rowHref = (r: CourierLedgerRow) => r.manifestId ? courierBoxHref(r.manifestId, location) : courierRouteDrawerHref(r.routeId, location);
  // «Liquidación» abre el reparto y cierre de la ruta en el mismo panel lateral.
  const reportHref = (r: CourierLedgerRow) => courierReportHref(r.routeId, location);

  return (
    <section aria-label="Rutas y cajas" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Fecha siempre dice qué muestra; la «x» vuelve a hoy. */}
        <FilterPill ref={dayPill} label="Fecha" value={dayValue} expanded={openPill === "fecha"} onClick={() => setOpenPill((v) => (v === "fecha" ? null : "fecha"))} onClear={dayMode !== "hoy" ? () => setParams({ day: null }) : undefined} />
        <FilterPill ref={riderPill} label="Motorizado" value={riderParam ? riderName(riderParam) : null} expanded={openPill === "motorizado"} onClick={() => setOpenPill((v) => (v === "motorizado" ? null : "motorizado"))} onClear={() => setParams({ rider: null })} />
        {activeFilters > 0 && <OpsButton variant="ghost" size="sm" onClick={() => setParams({ day: null, rider: null })}>Quitar filtros</OpsButton>}
        {openPill === "fecha" && (
          <Sheet look="ops" title="Fecha" onClose={() => setOpenPill(null)} anchored anchorRef={dayPill}>
            <div className="grid gap-3 text-sm">
              <select value={dayMode} aria-label="Fecha" onChange={(e) => { const v = e.target.value as DayMode; if (v === "hoy") setParams({ day: null }); else if (v === "todas") setParams({ day: "todas" }); else setParams({ day: today }); }} className={FIELD}>
                <option value="hoy">Hoy</option>
                <option value="fecha">Un día concreto</option>
                <option value="todas">Todas</option>
              </select>
              {dayMode === "fecha" && (
                <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">Día
                  <input type="date" value={specificDay} max={today} onChange={(e) => { if (isDay(e.target.value)) setParams({ day: e.target.value }); }} className={FIELD} />
                </label>
              )}
              {navPending && <p className="text-[13px] text-ink-500">Cargando ese día…</p>}
            </div>
          </Sheet>
        )}
        {openPill === "motorizado" && (
          <Sheet look="ops" title="Motorizado" onClose={() => setOpenPill(null)} anchored anchorRef={riderPill}>
            <select value={riderParam} aria-label="Motorizado" onChange={(e) => { setParams({ rider: e.target.value }); setOpenPill(null); }} className={FIELD}>
              <option value="">Todos</option>
              {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
            </select>
          </Sheet>
        )}
        <span className="text-[13px] text-ink-500"><b className="font-semibold tabular-nums text-ink-900">{filtered.length}</b> ruta{filtered.length === 1 ? "" : "s"}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {unassignedCount > 0 && onShowUnassigned && (
            <AttentionPill icon={IconPackage} label="Pedidos sin ruta" count={unassignedCount} active={false} hint="Tomados que todavía no están en la caja de un motorizado: ábrelos en Despacho del día." onClick={onShowUnassigned} />
          )}
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto rounded-lg bg-white shadow-control ring-1 ring-line">
        {!groups.length && (
          <p className="px-4 py-12 text-center text-sm text-ink-500">
            {dayMode === "hoy" ? "Hoy no hay rutas todavía. Asigna pedidos desde Despacho del día." : "No hay rutas con esos filtros."}
          </p>
        )}
        {/* Desktop: tabla con una cabecera por fecha. Sin filas no se pinta:
            la cabecera de columnas debajo del aviso vacío desconcertaba. */}
        {groups.length > 0 && (
        <table className="hidden w-full text-sm lg:table">
          <thead className="sticky top-0 z-10 bg-white text-left text-xs font-semibold text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
            <tr>
              <th className="px-4 py-2.5">Motorizado</th>
              <th className="px-3 py-2.5">Situación</th>
              <th className="px-2 py-2.5 text-center">Asignados</th>
              <th className="px-2 py-2.5 text-center">Armados</th>
              <th className="px-2 py-2.5 text-center">Cotejados</th>
              <th className="px-2 py-2.5 text-center">Recibidos</th>
              <th className="px-3 py-2.5 text-center"><span className="inline-flex items-center gap-1">Devolver <Hint text="No entregados que el motorizado tiene que traer de vuelta: devueltos / por devolver. Se reciben en Despacho del día, píldora «Devoluciones»." /></span></th>
              <th className="px-3 py-2.5 text-right">Efectivo</th>
              <th className="px-4 py-2.5"><span className="inline-flex items-center gap-1">Avance <Hint text="Con caja, dos barras: verde, cotejados por oficina; azul, recibidos por el motorizado con «Lo llevo». Sin caja: paradas ya reportadas." /></span></th>
              <th className="px-3 py-2.5">Liquidación</th>
            </tr>
          </thead>
          {groups.map(([day, list]) => (
            <tbody key={day}>
              <tr>
                <th colSpan={10} scope="rowgroup" className="sticky top-[37px] z-10 bg-wash px-4 py-2 text-left text-xs font-semibold text-ink-700 shadow-[inset_0_-1px_0_var(--color-line)]">
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
              <p className="sticky top-0 z-10 border-b border-line bg-wash px-4 py-2 text-xs font-semibold text-ink-700">{day === today ? "Hoy · " : ""}{routeDayLong(day)}</p>
              <ul className="divide-y divide-line">
                {list.map((r) => <LedgerCard key={r.routeId} row={r} href={rowHref(r)} reportHref={reportHref(r)} />)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

type Bar = { pct: number; text: string; tone: "ok" | "brand" };

/**
 * Con caja, dos barras: el cotejo de oficina y lo que el motorizado ya
 * recibió («Lo llevo»), que son los dos controles físicos de la caja. Sin
 * caja (rutas del cuaderno), una sola: paradas ya reportadas.
 */
function progressOf(r: CourierLedgerRow): Bar[] {
  // Con la ruta cerrada lo que importa es el resultado del reparto, no la
  // caja: misma barra que las rutas históricas del cuaderno.
  if (r.manifestId && r.routeStatus !== "cerrada" && r.officeCheckedCount != null && r.pickupCheckedCount != null) {
    const pct = (n: number) => (r.assignedCount ? Math.round((n / r.assignedCount) * 100) : 0);
    const office = r.assignedCount - r.officeCheckedCount;
    const pickup = r.assignedCount - r.pickupCheckedCount;
    return [
      { pct: pct(r.officeCheckedCount), text: office > 0 ? `${office} por cotejar` : "Caja cotejada", tone: "ok" },
      { pct: pct(r.pickupCheckedCount), text: pickup > 0 ? `${pickup} sin recibir` : "Recibida por el motorizado", tone: "brand" },
    ];
  }
  const pct = r.assignedCount ? Math.round((r.reportedCount / r.assignedCount) * 100) : 0;
  return [{ pct, text: `${r.deliveredCount} entregados · ${r.reportedCount - r.deliveredCount} no`, tone: "ok" }];
}

function ProgressBars({ bars, compact = false }: { bars: Bar[]; compact?: boolean }) {
  return (
    <div className={cn("space-y-1", compact ? "mt-2" : "min-w-[150px]")}>
      {bars.map((bar) => (
        <div key={bar.text + bar.tone} className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className={cn("h-full rounded-full", bar.tone === "brand" ? "bg-info-fg" : "bg-ok-fg")} style={{ width: `${bar.pct}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-600">{bar.pct}%</span>
          {compact && <span className="truncate text-xs text-ink-500">{bar.text}</span>}
        </div>
      ))}
      {!compact && <p className="max-w-[12rem] truncate text-xs text-ink-500" title={bars.map((b) => b.text).join(" · ")}>{bars.map((b) => b.text).join(" · ")}</p>}
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
  // Parte en dos líneas si la tabla no cabe, pero la flecha va siempre con la
  // última palabra: a 1.440 px una sola línea empujaba la columna fuera de vista.
  const cut = label.lastIndexOf(" ");
  return (
    <a href={href} onClick={(e) => openInPlace(e, href)} title="Paradas, cierre de la ruta y pago del motorizado" className={cn("inline-block min-w-[6.5rem] text-[13px] font-medium leading-5 text-brand-700 hover:underline", className)}>
      {cut > 0 && `${label.slice(0, cut)} `}
      <span className="whitespace-nowrap">
        {label.slice(cut + 1)}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ml-1 inline-block align-[-1px]"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </span>
    </a>
  );
}

function LedgerRow({ row, href, reportHref }: { row: CourierLedgerRow; href: string; reportHref: string }) {
  const situation = ledgerSituation(row);
  const progress = progressOf(row);
  const dash = (n: number | null) => (n == null ? "—" : n);
  return (
    <tr className="border-b border-line transition-colors last:border-0 hover:bg-wash">
      <td className="whitespace-nowrap px-4 py-3">
        <a href={href} onClick={(e) => openInPlace(e, href)} className="font-semibold text-ink-900 hover:text-brand-700">{row.riderName}</a>
        <p className="text-xs text-ink-500">{row.manifestId ? `Carga ${row.loadNumber ?? 1}` : "Sin caja"}</p>
      </td>
      <td className="px-3 py-3"><Badge tone={SITUATION_TONE[situation]}>{LEDGER_SITUATION_LABELS[situation]}</Badge></td>
      <td className="px-2 py-3 text-center font-semibold tabular-nums text-ink-900">{row.assignedCount}</td>
      <td className="px-2 py-3 text-center tabular-nums text-ink-700">{dash(row.armedCount)}</td>
      <td className="px-2 py-3 text-center tabular-nums text-ink-700">{dash(row.officeCheckedCount)}</td>
      <td className="px-2 py-3 text-center tabular-nums text-ink-700">{dash(row.pickupCheckedCount)}</td>
      <td className="px-3 py-3 text-center"><ReturnsBadge row={row} /></td>
      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-ink-900">{money(row.codAmount)}</td>
      <td className="px-4 py-3"><ProgressBars bars={progress} /></td>
      <td className="px-3 py-3"><ReportLink row={row} href={reportHref} /></td>
    </tr>
  );
}

function LedgerCard({ row, href, reportHref }: { row: CourierLedgerRow; href: string; reportHref: string }) {
  const situation = ledgerSituation(row);
  const progress = progressOf(row);
  return (
    <li>
      <a href={href} onClick={(e) => openInPlace(e, href)} className="block px-4 py-3 transition-colors hover:bg-wash">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-ink-900">{row.riderName}</p>
            <p className="text-xs tabular-nums text-ink-500">{row.manifestId ? `Carga ${row.loadNumber ?? 1}` : "Sin caja"} · {row.assignedCount} paq. · <span className="whitespace-nowrap">{money(row.codAmount)}</span></p>
          </div>
          <Badge tone={SITUATION_TONE[situation]} className="shrink-0">{LEDGER_SITUATION_LABELS[situation]}</Badge>
        </div>
        <ProgressBars bars={progress} compact />
        {row.manifestId && <p className="mt-1 text-xs tabular-nums text-ink-500">armados {row.armedCount} · cotejados {row.officeCheckedCount} · recibidos {row.pickupCheckedCount}</p>}
        {row.returnsDue > 0 && <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-600">Devolver <ReturnsBadge row={row} /></p>}
      </a>
      <div className="px-4 pb-3 text-xs"><ReportLink row={row} href={reportHref} /></div>
    </li>
  );
}

/** «Devolver»: devueltos / por devolver; verde completo, rojo si falta alguno. */
function ReturnsBadge({ row }: { row: CourierLedgerRow }) {
  if (!row.returnsDue) return <span className="text-ink-500">—</span>;
  const done = row.returnsDone >= row.returnsDue;
  return (
    <Badge tone={done ? "ok" : "crit"} title={done ? "Todos los no entregados volvieron a la oficina" : `${row.returnsDue - row.returnsDone} por devolver`} className="tabular-nums">
      {row.returnsDone}/{row.returnsDue}
    </Badge>
  );
}
