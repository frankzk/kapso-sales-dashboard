"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Card } from "@/components/ui";
import {
  COURIER_REPORT_RESULTS,
  attemptLabel,
  evaluateAliclikReschedule,
  isCallable,
  isShipmentReadyForContact,
  isShipmentReadyForContactToday,
  labelOf,
  normalizeCity,
  rescheduleGuideCode,
  SHIPMENT_CLAIM_HEARTBEAT_MS,
  shipmentRequiresCourierResult,
  statusSince,
  type CourierReportResult,
  type RerouteDisposition,
} from "@/lib/shipments";
import type {
  LinkedShipmentSummary,
  ShipmentCallRow,
  ShipmentOrderDetail,
  ShipmentRow,
  StoreSummary,
} from "@/lib/types";
import { SHIPMENT_VIEWS, type ShipmentView } from "@/lib/shipments-access";
import {
  sortShipmentRows,
  type ShipmentSortDirection,
  type ShipmentSortKey,
} from "@/lib/shipment-sort";
import { REPROGRAM_STALE_DAYS, type ReprogramCounts, type ReprogramStats } from "@/lib/shipments";
import {
  claimShipment,
  createFenixGuide,
  loadShipmentDetail,
  registerCourierReportResult,
  registerRerouteCall,
  releaseShipment,
  renewShipmentClaim,
  searchShipments,
  updateShipmentDeliveryAddress,
  type ShipmentAddressInput,
} from "@/app/dashboard/envios/actions";
import { OrderLinkPicker } from "@/components/order-link-picker";

const CATEGORY_BADGE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  in_route: "bg-violet-50 text-violet-700",
  delivered: "bg-emerald-50 text-emerald-700",
  closed: "bg-slate-100 text-slate-600",
  transferred: "bg-sky-50 text-sky-700",
};

const DISPOSITIONS: { key: RerouteDisposition; label: string }[] = [
  { key: "confirma", label: "Cliente confirma reprogramación" },
  { key: "programar", label: "Programar próxima llamada" },
  { key: "no_contesta", label: "No contesta" },
  { key: "entregado", label: "Entregado (Fenix)" },
  { key: "cancela", label: "Cliente cancela / anula" },
];

/** Next reprogrammed follow-up date (next_followup_at) as "12 ago", or "—".
 *  Read in UTC: the date is picked from `<input type=date>` and stored as UTC
 *  midnight, so this shows the day the operator chose (and matches the day the
 *  Fenix guide code is stamped with) regardless of the viewer's timezone. */
function fmtReprogram(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtAliclikDate(date: string | null | undefined): string {
  if (!date) return "—";
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function shipmentHistoryLabel(call: ShipmentCallRow): string {
  if (call.kind === "call" && !call.new_status && call.next_followup_at) {
    return "Llamada programada";
  }
  const labels: Record<string, string> = {
    call: "Gestión de llamada",
    courier_report: "Reporte Fenix",
    state_change: "Corrección administrativa",
    reroute: "Reprogramación",
    address_change: "Cambio de dirección",
    system: "Actualización del sistema",
  };
  return labels[call.kind] ?? call.kind;
}

function aliclikDecisionCopy(
  decision: ReturnType<typeof evaluateAliclikReschedule>,
): string {
  if (decision.eligible) return "Disponible: menos de 3 intentos y dentro de la semana vigente.";
  if (decision.reason === "three_attempts") return "Bloqueado: Aliclik registra 3 intentos o más.";
  if (decision.reason === "outside_week") {
    return `Bloqueado: la fecha está fuera de la ventana ${decision.cutoffDate}–${decision.today}.`;
  }
  if (decision.reason === "missing_attempts") return "Bloqueado: el Excel no informó NRO. INTENTOS.";
  if (decision.reason === "missing_service_date") return "Bloqueado: el Excel no informó la fecha operativa.";
  return "No aplica: esta ya no es una guía Aliclik.";
}

function localDateInputValue(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function tomorrowDateInputValue(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return localDateInputValue(tomorrow);
}

/** Human sub-state suffix: "· Intento 3" for pending, "· por Fenix" for entregado. */
function subState(s: { status_category: string; reroute_attempts: number; delivered_source: string | null }): string {
  if (s.status_category === "pending") return ` · ${attemptLabel(s.reroute_attempts)}`;
  if (s.status_category === "delivered" && s.delivered_source)
    return ` · por ${s.delivered_source === "fenix" ? "Fenix" : "Aliclik"}`;
  return "";
}

/** "05 jul, 3:20 p. m." in the store's local time — when the shipment entered its
 *  current status (from `statusSince`). Null when the time is unknown/invalid. */
function fmtStatusSince(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function StatusBadge({
  category,
  status,
  suffix,
}: {
  category: string;
  status: string;
  suffix?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        CATEGORY_BADGE[category] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {labelOf(status)}
      {suffix}
    </span>
  );
}

const SIN_DISTRITO = "(sin distrito)";
const SIN_CIUDAD = "(sin provincia)";

export function ShipmentsBoard({
  stores,
  view,
  counts,
  shipments,
  fenixStockCities = [],
  reprogram,
}: {
  stores: StoreSummary[];
  view: ShipmentView;
  counts: Record<ShipmentView, number>;
  shipments: ShipmentRow[];
  fenixStockCities?: string[]; // normalized provinces with Fenix stock
  reprogram?: ReprogramStats;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);

  // client-side filters over the loaded view. Empty set = "all".
  const [storeFilter, setStoreFilter] = useState<Set<string>>(new Set());
  const [cityFilter, setCityFilter] = useState<Set<string>>(new Set());
  const [districtFilter, setDistrictFilter] = useState<Set<string>>(new Set());
  const [dateFilter, setDateFilter] = useState(""); // YYYY-MM-DD on next_followup_at
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [uncontactedTodayOnly, setUncontactedTodayOnly] = useState(view === "pendiente");
  const [uncontactedOnly, setUncontactedOnly] = useState(false);
  const [fenixFilter, setFenixFilter] = useState<"all" | "ok" | "no">("all"); // fenix_eligible
  const [exportingFenix, setExportingFenix] = useState(false);
  const [fenixExportError, setFenixExportError] = useState<string | null>(null);

  // global search (across all tabs, server-side)
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ShipmentRow[] | null>(null);
  const [searching, setSearching] = useState(false);

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "—";

  // distinct provinces (city) and districts present in this view, for the pickers
  const cityOptions = Array.from(
    new Set(shipments.map((s) => normalizeCity(s.city) || SIN_CIUDAD)),
  ).sort((a, b) => a.localeCompare(b));
  const districtOptions = Array.from(
    new Set(shipments.map((s) => s.district || SIN_DISTRITO)),
  ).sort((a, b) => a.localeCompare(b));

  // On view change, default-select the provinces where Fenix has stock (present
  // in this view); districts start unfiltered. Reset the other filters.
  useEffect(() => {
    const stock = new Set(fenixStockCities);
    const defaultCities = new Set(
      Array.from(new Set(shipments.map((s) => normalizeCity(s.city) || SIN_CIUDAD))).filter(
        (c) => c !== SIN_CIUDAD && stock.has(c),
      ),
    );
    setCityFilter(defaultCities);
    setDistrictFilter(new Set());
    setDateFilter("");
    setUnmatchedOnly(false);
    setUncontactedTodayOnly(view === "pendiente");
    setUncontactedOnly(false);
    setFenixFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // debounced global search
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchShipments(term);
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  const filtered = shipments.filter(
    (s) =>
      (storeFilter.size === 0 || storeFilter.has(s.store_id)) &&
      (cityFilter.size === 0 || cityFilter.has(normalizeCity(s.city) || SIN_CIUDAD)) &&
      (districtFilter.size === 0 || districtFilter.has(s.district || SIN_DISTRITO)) &&
      (!dateFilter || (s.next_followup_at ? s.next_followup_at.slice(0, 10) === dateFilter : false)) &&
      (!unmatchedOnly || !s.matched) &&
      (!uncontactedTodayOnly ||
        view !== "pendiente" ||
        isShipmentReadyForContactToday(s.today_contact_count, s.next_followup_at)) &&
      (!uncontactedOnly ||
        view !== "pendiente" ||
        isShipmentReadyForContact(s.contact_count, s.next_followup_at)) &&
      (fenixFilter === "all" || (fenixFilter === "ok" ? s.fenix_eligible : !s.fenix_eligible)),
  );
  const fenixRowsForExport = filtered.filter(
    (shipment) => shipment.courier === "fenix" && shipment.status_category === "in_route",
  );

  const searchActive = search.trim().length >= 2;

  function go(params: Record<string, string>) {
    const sp = new URLSearchParams({ view, ...params });
    router.push(`/dashboard/envios?${sp.toString()}`);
  }

  function toggleStore(id: string) {
    setStoreFilter((prev) => {
      const next = new Set(prev);
      if (next.size === 0) stores.forEach((s) => next.add(s.id)); // "all" → start from all
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function downloadFenixProgrammingWorkbook() {
    if (!dateFilter || !fenixRowsForExport.length || exportingFenix) return;
    setExportingFenix(true);
    setFenixExportError(null);
    try {
      const response = await fetch("/api/export/fenix-programacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: dateFilter,
          shipmentIds: fenixRowsForExport.map((shipment) => shipment.id),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "No se pudo generar el Excel de Fenix.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fenix_programacion_${dateFilter}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFenixExportError(
        error instanceof Error ? error.message : "No se pudo generar el Excel de Fenix.",
      );
    } finally {
      setExportingFenix(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Envíos</h1>
        <div className="flex items-center gap-2">
          {/* global search */}
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
              🔍
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar guía, pedido, guía Fenix, celular…"
              className="w-64 rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>
          <a
            href="/dashboard/envios/import"
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Importar reporte
          </a>
          <a
            href="/dashboard/envios/stock"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Stock Fenix
          </a>
        </div>
      </div>

      {reprogram && <ReprogramStrip stats={reprogram} stores={stores} />}

      {searchActive ? (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <p className="text-sm font-medium text-slate-800">
              Resultados de búsqueda {results ? `(${results.length})` : ""}
            </p>
            <button onClick={() => setSearch("")} className="text-xs text-slate-500 hover:underline">
              Limpiar búsqueda
            </button>
          </div>
          {searching ? (
            <p className="p-5 text-sm text-slate-400">Buscando…</p>
          ) : results && results.length > 0 ? (
            <ShipmentTable rows={results} stores={stores} storeName={storeName} onOpen={setOpenId} />
          ) : (
            <p className="p-5 text-sm text-slate-400">Sin coincidencias.</p>
          )}
        </Card>
      ) : (
        <>
          {/* tabs */}
          <div className="flex flex-wrap gap-1.5">
            {SHIPMENT_VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => go({ view: v.key })}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  v.key === view ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50",
                )}
              >
                {v.label}
                <span className="ml-1.5 text-xs text-slate-400">{counts[v.key]}</span>
              </button>
            ))}
          </div>

          {/* filters: store chips + district multi-select + programación date */}
          {view !== "revision" && (
            <div className="flex flex-wrap items-center gap-2">
              {stores.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-400">Tienda:</span>
                  {stores.map((s) => {
                    const active = storeFilter.size === 0 || storeFilter.has(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggleStore(s.id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                          active
                            ? "border-brand-200 bg-brand-50 text-brand-700"
                            : "border-slate-200 bg-white text-slate-400",
                        )}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {cityOptions.length > 1 && (
                <ChecklistFilter
                  label="Provincia"
                  options={cityOptions}
                  selected={cityFilter}
                  onChange={setCityFilter}
                />
              )}
              {districtOptions.length > 1 && (
                <ChecklistFilter
                  label="Distrito"
                  options={districtOptions}
                  selected={districtFilter}
                  onChange={setDistrictFilter}
                />
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                Programación:
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                />
              </label>
              {view === "en_ruta" && (
                <button
                  type="button"
                  onClick={downloadFenixProgrammingWorkbook}
                  disabled={!dateFilter || !fenixRowsForExport.length || exportingFenix}
                  title={
                    !dateFilter
                      ? "Elige primero la fecha de programación"
                      : !fenixRowsForExport.length
                        ? "No hay guías Fenix visibles para esa fecha"
                        : "Descarga las guías Fenix que quedan en la lista"
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none"
                >
                  <span aria-hidden="true">↓</span>
                  {exportingFenix
                    ? "Generando Excel…"
                    : !dateFilter
                      ? "Elige fecha para Excel"
                      : `Descargar Excel Fenix (${fenixRowsForExport.length})`}
                </button>
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                Fenix:
                <select
                  value={fenixFilter}
                  onChange={(e) => setFenixFilter(e.target.value as "all" | "ok" | "no")}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                >
                  <option value="all">Todos</option>
                  <option value="ok">Con stock (Fenix ok)</option>
                  <option value="no">Sin cobertura</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={unmatchedOnly}
                  onChange={(e) => setUnmatchedOnly(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Solo sin pedido
              </label>
              {view === "pendiente" && (
                <>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={uncontactedTodayOnly}
                      onChange={(e) => setUncontactedTodayOnly(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Solo sin contactar hoy
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={uncontactedOnly}
                      onChange={(e) => setUncontactedOnly(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Solo sin contactar
                  </label>
                </>
              )}
              {(storeFilter.size > 0 ||
                cityFilter.size > 0 ||
                districtFilter.size > 0 ||
                dateFilter ||
                unmatchedOnly ||
                uncontactedTodayOnly ||
                uncontactedOnly ||
                fenixFilter !== "all") && (
                <button
                  onClick={() => {
                    setStoreFilter(new Set());
                    setCityFilter(new Set());
                    setDistrictFilter(new Set());
                    setDateFilter("");
                    setUnmatchedOnly(false);
                    setUncontactedTodayOnly(false);
                    setUncontactedOnly(false);
                    setFenixFilter("all");
                  }}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Limpiar filtros
                </button>
              )}
              <span className="ml-auto text-xs text-slate-400">
                Mostrando {filtered.length} de {shipments.length}
              </span>
            </div>
          )}
          {fenixExportError && view === "en_ruta" && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {fenixExportError}
            </div>
          )}

          {view === "revision" ? (
            <Card>
              <p className="text-sm text-slate-500">
                Las filas por revisar se gestionan desde{" "}
                <a className="text-brand-700 underline" href="/dashboard/envios/import">
                  Importar reporte
                </a>
                .
              </p>
            </Card>
          ) : (
            <Card className="p-0">
              {filtered.length === 0 ? (
                <p className="p-5 text-sm text-slate-400">
                  {shipments.length === 0 ? "Sin envíos en esta vista." : "Ningún envío con esos filtros."}
                </p>
              ) : (
                <ShipmentTable rows={filtered} stores={stores} storeName={storeName} onOpen={setOpenId} />
              )}
            </Card>
          )}
        </>
      )}

      {openId && (
        <ShipmentDrawer
          shipmentId={openId}
          onClose={() => setOpenId(null)}
          onOpenShipment={setOpenId}
        />
      )}
    </div>
  );
}

function ShipmentTable({
  rows,
  stores,
  storeName,
  onOpen,
}: {
  rows: ShipmentRow[];
  stores: StoreSummary[];
  storeName: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const [sort, setSort] = useState<{
    key: ShipmentSortKey;
    direction: ShipmentSortDirection;
  } | null>(null);
  const sortedRows = useMemo(
    () => sort ? sortShipmentRows(rows, sort.key, sort.direction, storeName) : rows,
    [rows, sort, storeName],
  );

  function toggleSort(key: ShipmentSortKey) {
    setSort((current) => ({
      key,
      direction: current?.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            <SortableShipmentHeader label="Guía" sortKey="guide" sort={sort} onSort={toggleSort} />
            {stores.length > 1 && (
              <SortableShipmentHeader label="Tienda" sortKey="store" sort={sort} onSort={toggleSort} />
            )}
            <SortableShipmentHeader label="Pedido" sortKey="order" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Cliente" sortKey="customer" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Producto" sortKey="product" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Distrito / Ciudad" sortKey="location" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Estado" sortKey="status" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Reprogramación" sortKey="reprogramming" sort={sort} onSort={toggleSort} />
            <SortableShipmentHeader label="Ruta sugerida" sortKey="route" sort={sort} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((s) => (
            <tr
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                {s.guide_code}
                {s.courier === "fenix" && (
                  <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-700">Fenix</span>
                )}
              </td>
              {stores.length > 1 && (
                <td className="px-4 py-2.5 text-slate-600">{storeName(s.store_id)}</td>
              )}
              <td className="px-4 py-2.5 text-slate-700">
                <OrderNameLabel name={s.order_name} matched={s.matched} />
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {s.customer_name ?? "—"}
                <span className="block text-xs text-slate-400">{s.customer_phone ?? ""}</span>
              </td>
              <td className="w-44 max-w-44 px-3 py-2.5 align-middle">
                <span
                  className="line-clamp-2 text-[11px] leading-4 text-slate-600"
                  title={s.product ?? undefined}
                >
                  {s.product ?? "—"}
                </span>
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {s.district ?? "—"}
                <span className="block text-xs capitalize text-slate-400">
                  {s.city ?? ""}
                  {s.fenix_eligible && <span className="ml-1 text-emerald-600">· Fenix ok</span>}
                </span>
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge category={s.status_category} status={s.delivery_status} suffix={subState(s)} />
              </td>
              <td className="px-4 py-2.5 text-slate-600">{fmtReprogram(s.next_followup_at)}</td>
              <td className="px-4 py-2.5"><AliclikRouteCell shipment={s} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableShipmentHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: ShipmentSortKey;
  sort: { key: ShipmentSortKey; direction: ShipmentSortDirection } | null;
  onSort: (key: ShipmentSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} className="px-2 py-1 text-left font-medium first:pl-4 last:pr-4">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Ordenar por ${label}`}
        className={cn(
          "group inline-flex min-h-8 w-full items-center gap-1 rounded-md px-2 text-left transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400",
          active && "bg-brand-50 text-brand-700",
        )}
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "text-[11px] transition",
            active ? "text-brand-600" : "text-slate-300 group-hover:text-slate-500",
          )}
        >
          {active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function AliclikRouteCell({ shipment }: { shipment: ShipmentRow }) {
  if (shipment.courier !== "aliclik" || shipment.status_category !== "pending") {
    return <span className="text-slate-400">—</span>;
  }
  const decision = evaluateAliclikReschedule({
    courier: shipment.courier,
    attempts: shipment.aliclik_attempts,
    serviceDate: shipment.aliclik_service_date,
  });
  return decision.eligible ? (
    <span className="inline-flex rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
      Aliclik · {shipment.aliclik_attempts ?? 0}/3
    </span>
  ) : (
    <span className="inline-flex rounded-full bg-orange-50 px-2 py-1 text-xs font-medium text-orange-700">
      Fenix · {shipment.aliclik_attempts == null ? "sin dato" : `${shipment.aliclik_attempts}/3`}
    </span>
  );
}

function ShipmentDrawer({
  shipmentId,
  onClose,
  onOpenShipment,
}: {
  shipmentId: string;
  onClose: () => void;
  onOpenShipment: (id: string) => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<
    | {
        shipment: ShipmentRow;
        calls: ShipmentCallRow[];
        order: ShipmentOrderDetail | null;
        linkedFenixShipment: LinkedShipmentSummary | null;
      }
    | { error: string }
    | null
  >(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [claimState, setClaimState] = useState<"claiming" | "mine" | "blocked">("claiming");
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const claimSessionRef = useRef<{
    shipmentId: string;
    shouldRelease: boolean;
  } | null>(null);

  // form state
  const [disposition, setDisposition] = useState<RerouteDisposition>("confirma");
  const [note, setNote] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [courierResult, setCourierResult] = useState<CourierReportResult | "">("");
  const [courierDate, setCourierDate] = useState("");
  const [courierNote, setCourierNote] = useState("");
  const [showCourierCorrection, setShowCourierCorrection] = useState(false);
  const [fenixGuide, setFenixGuide] = useState("");
  const [showOrderPicker, setShowOrderPicker] = useState(false);
  const [showAddressEditor, setShowAddressEditor] = useState(false);
  const [address, setAddress] = useState("");
  const [addressReference, setAddressReference] = useState("");
  const [addressDistrict, setAddressDistrict] = useState("");
  const [addressCity, setAddressCity] = useState("");
  const [addressRegion, setAddressRegion] = useState("");
  const [addressLatitude, setAddressLatitude] = useState("");
  const [addressLongitude, setAddressLongitude] = useState("");
  const [reprogramProvider, setReprogramProvider] = useState<"aliclik" | "fenix">("fenix");
  const [forceAliclik, setForceAliclik] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const session = { shipmentId, shouldRelease: false };
    claimSessionRef.current = session;
    setClaimState("claiming");
    setClaimMessage(null);

    void claimShipment(shipmentId)
      .then((result) => {
        if (session.shouldRelease) {
          if (!result.error) void releaseShipment(shipmentId).catch(() => undefined);
          return;
        }
        if (!active) return;
        if (result.error) {
          setClaimState("blocked");
          setClaimMessage(result.error);
          return;
        }

        setClaimState("mine");
        heartbeat = setInterval(() => {
          void renewShipmentClaim(shipmentId)
            .then((renewal) => {
              if (!active || session.shouldRelease || !renewal.error) return;
              setClaimState("blocked");
              setClaimMessage(renewal.error);
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
            })
            .catch(() => {
              if (!active || session.shouldRelease) return;
              setClaimState("blocked");
              setClaimMessage("No pudimos renovar la reserva. Cierra y vuelve a abrir este envío.");
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
            });
        }, SHIPMENT_CLAIM_HEARTBEAT_MS);
      })
      .catch(() => {
        if (!active || session.shouldRelease) return;
        setClaimState("blocked");
        setClaimMessage("No pudimos reservar este envío. Cierra y vuelve a intentarlo.");
      });

    return () => {
      active = false;
      if (heartbeat) clearInterval(heartbeat);
    };
  }, [shipmentId]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setShowAddressEditor(false);
    loadShipmentDetail(shipmentId).then((d) => {
      if (!alive) return;
      setDetail(d);
      if (d && !("error" in d)) {
        setCourierResult("");
        setCourierDate("");
        setCourierNote("");
        setShowCourierCorrection(false);
        setMsg(null);
        const decision = evaluateAliclikReschedule({
          courier: d.shipment.courier,
          attempts: d.shipment.aliclik_attempts,
          serviceDate: d.shipment.aliclik_service_date,
        });
        setReprogramProvider(decision.eligible ? "aliclik" : "fenix");
        setForceAliclik(false);
        const shopifyAddress = d.order?.shipping_address;
        setAddress(d.shipment.delivery_address ?? shopifyAddress?.address1 ?? "");
        setAddressReference(d.shipment.delivery_reference ?? shopifyAddress?.address2 ?? "");
        setAddressDistrict(d.shipment.district ?? shopifyAddress?.city ?? "");
        setAddressCity(d.shipment.city ?? shopifyAddress?.city ?? "");
        setAddressRegion(d.shipment.region ?? shopifyAddress?.province ?? "");
        setAddressLatitude(d.shipment.latitude == null ? "" : String(d.shipment.latitude));
        setAddressLongitude(d.shipment.longitude == null ? "" : String(d.shipment.longitude));
      }
    });
    return () => {
      alive = false;
    };
  }, [shipmentId, reloadKey]);

  function refresh() {
    setDetail(null);
    setReloadKey((k) => k + 1);
    router.refresh();
  }

  function releaseCurrentClaim() {
    const session = claimSessionRef.current;
    if (!session) return;
    session.shouldRelease = true;
    void releaseShipment(session.shipmentId).catch(() => undefined);
  }

  function handleClose() {
    releaseCurrentClaim();
    onClose();
  }

  function handleOpenShipment(id: string) {
    releaseCurrentClaim();
    onOpenShipment(id);
  }

  function run(
    fn: () => Promise<{ error?: string; notice?: string }>,
    onSuccess?: () => void,
  ) {
    start(async () => {
      const r = await fn();
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        onSuccess?.();
        refresh();
      }
    });
  }

  const programDateInvalid =
    disposition === "programar" && (!nextDate || nextDate <= localDateInputValue());
  const shipment = detail && !("error" in detail) ? detail.shipment : null;
  const shopifyAddress = detail && !("error" in detail) ? detail.order?.shipping_address ?? null : null;
  const deliveryAddress = shipment?.delivery_address ?? shopifyAddress?.address1 ?? null;
  const deliveryReference = shipment?.delivery_reference ?? shopifyAddress?.address2 ?? null;
  const deliveryLocality = !shipment?.delivery_address
    ? [shopifyAddress?.city, shopifyAddress?.province].filter(Boolean).join(" · ") || null
    : null;
  const deliverySource = shipment?.address_override
    ? "Modificado en Kapta · protegido frente al siguiente Excel"
    : shipment?.delivery_address
      ? "Importado desde Aliclik"
      : shopifyAddress?.address1
        ? "Obtenido de Shopify"
        : "Sin dirección disponible";
  const aliclikDecision = shipment
    ? evaluateAliclikReschedule({
        courier: shipment.courier,
        attempts: shipment.aliclik_attempts,
        serviceDate: shipment.aliclik_service_date,
      })
    : null;
  const overrideNoteMissing =
    disposition === "confirma" && reprogramProvider === "aliclik" && forceAliclik && !note.trim();
  const fenixAutoUnavailable =
    disposition === "confirma" &&
    reprogramProvider === "fenix" &&
    shipment?.courier === "aliclik" &&
    !shipment.fenix_eligible;
  const fenixRouteAvailable =
    !!shipment && (shipment.courier !== "aliclik" || shipment.fenix_eligible);
  const requiredDateMissing =
    (disposition === "confirma" && !nextDate) ||
    programDateInvalid ||
    overrideNoteMissing ||
    fenixAutoUnavailable;
  const parsedLatitude = Number(addressLatitude.replace(",", "."));
  const parsedLongitude = Number(addressLongitude.replace(",", "."));
  const addressFormValid =
    !!address.trim() &&
    !!addressDistrict.trim() &&
    !!addressCity.trim() &&
    !!addressRegion.trim() &&
    addressLatitude.trim() !== "" &&
    addressLongitude.trim() !== "" &&
    Number.isFinite(parsedLatitude) &&
    parsedLatitude >= -90 &&
    parsedLatitude <= 90 &&
    Number.isFinite(parsedLongitude) &&
    parsedLongitude >= -180 &&
    parsedLongitude <= 180;
  const courierResultDefinition = courierResult
    ? COURIER_REPORT_RESULTS.find((item) => item.code === courierResult) ?? null
    : null;
  const courierFormValid =
    !!courierResultDefinition &&
    (!courierResultDefinition.requiresDate || !!courierDate) &&
    (!courierResultDefinition.requiresNote || !!courierNote.trim());
  const reopensClosedGuide =
    !!courierResultDefinition &&
    (shipment?.delivery_status === "anulado" || shipment?.delivery_status === "entregado") &&
    courierResultDefinition.resultingStatus !== "anulado" &&
    courierResultDefinition.resultingStatus !== "entregado";
  const fenixAwaitingCourierResult =
    shipmentRequiresCourierResult(shipment?.courier, shipment?.delivery_status);
  const fenixReadyForCustomerManagement =
    shipment?.courier === "fenix" && shipment.delivery_status === "pendiente";

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-900/30" onClick={handleClose}>
      <div
        className="h-full w-full max-w-[34rem] overflow-y-auto bg-white p-3.5 shadow-xl sm:p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {detail && "error" in detail ? (
          <p className="text-sm text-rose-600">{detail.error}</p>
        ) : !detail ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : (
          <div className="space-y-2.5">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-sm font-semibold text-slate-800">{detail.shipment.guide_code}</p>
                  <StatusBadge
                    category={detail.shipment.status_category}
                    status={detail.shipment.delivery_status}
                    suffix={subState(detail.shipment)}
                  />
                </div>
                {/* Since when it's in this status (e.g. the day it went "En ruta"),
                    derived from the transition in its history. */}
                {(() => {
                  const since = fmtStatusSince(
                    statusSince(detail.calls, detail.shipment.delivery_status),
                  );
                  return since ? <p className="mt-0.5 text-[11px] text-slate-500">Desde {since}</p> : null;
                })()}
              </div>
              <button onClick={handleClose} className="text-sm text-slate-400 hover:text-slate-700">
                Cerrar
              </button>
            </div>

            <div
              role="status"
              className={cn(
                "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
                claimState === "mine"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : claimState === "blocked"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-slate-200 bg-slate-50 text-slate-600",
              )}
            >
              <span
                className={cn(
                  "mt-1 h-2 w-2 shrink-0 rounded-full",
                  claimState === "mine"
                    ? "bg-emerald-500"
                    : claimState === "blocked"
                      ? "bg-amber-500"
                      : "animate-pulse bg-slate-400",
                )}
              />
              <span>
                {claimState === "mine" ? (
                  <><b>Reservado para ti.</b> Se liberará automáticamente al cerrar este panel.</>
                ) : claimState === "blocked" ? (
                  <><b>{claimMessage ?? "Otro asesor está atendiendo este envío."}</b> Puedes consultar la información, pero no modificarla.</>
                ) : (
                  "Reservando este envío…"
                )}
              </span>
            </div>

            <fieldset disabled={claimState !== "mine"} className="contents">

            <section className="overflow-hidden rounded-xl border border-sky-200 bg-white shadow-[0_1px_0_rgba(14,165,233,0.08)]">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm">
                <Field label="Cliente" value={detail.shipment.customer_name} />
                <Field label="Teléfono" value={detail.shipment.customer_phone} />
                <Field label="Ciudad" value={detail.shipment.city} />
                <Field label="Distrito" value={detail.shipment.district} />
                <div className="col-span-2 border-t border-slate-100 pt-1.5">
                  <Field label="Producto declarado" value={detail.shipment.product} />
                </div>
              </dl>
              <dl className="grid grid-cols-2 border-t border-sky-100 bg-sky-50/75 sm:grid-cols-4">
                <CompactMetric
                  label="Intentos Aliclik"
                  value={
                    detail.shipment.aliclik_attempts == null
                      ? "Sin dato"
                      : `${detail.shipment.aliclik_attempts} / 3`
                  }
                />
                <CompactMetric label="Fecha Aliclik" value={fmtAliclikDate(detail.shipment.aliclik_service_date)} />
                <CompactMetric label="Llamadas" value={`${detail.shipment.reroute_attempts} / 7`} />
                <CompactMetric
                  label="Fenix"
                  value={detail.shipment.fenix_eligible ? "Elegible" : "No elegible"}
                  tone={detail.shipment.fenix_eligible ? "positive" : "neutral"}
                />
              </dl>
            </section>

            <section className="overflow-hidden rounded-xl border border-teal-200 bg-white shadow-[0_1px_0_rgba(13,148,136,0.08)]">
              <div className="space-y-2 bg-teal-50/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-semibold text-teal-950">Destino de entrega</p>
                    {detail.shipment.address_override && (
                      <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                        Modificado
                      </span>
                    )}
                    <span className="text-[11px] text-teal-600">
                      · {deliverySource}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddressEditor((value) => !value)}
                  className="shrink-0 text-xs font-semibold text-teal-700 hover:text-teal-900 hover:underline"
                >
                  {showAddressEditor ? "Cerrar edición" : "Modificar destino"}
                </button>
              </div>

              {!showAddressEditor ? (
                <div className="space-y-2">
                  <div>
                    <p className="text-xs text-slate-400">Dirección completa</p>
                    <p className="text-sm leading-snug text-slate-800">
                      {deliveryAddress ?? "No informada en Aliclik ni Shopify."}
                    </p>
                    {deliveryLocality && (
                      <p className="mt-0.5 text-xs font-medium text-teal-700">{deliveryLocality}</p>
                    )}
                    {deliveryReference && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        Ref.: {deliveryReference}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Latitud</p>
                      <p className="select-all font-mono text-xs text-slate-700">
                        {detail.shipment.latitude ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Longitud</p>
                      <p className="select-all font-mono text-xs text-slate-700">
                        {detail.shipment.longitude ?? "—"}
                      </p>
                    </div>
                  </div>
                  {detail.shipment.latitude != null && detail.shipment.longitude != null && (
                    <a
                      href={`https://www.google.com/maps?q=${detail.shipment.latitude},${detail.shipment.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-xs font-medium text-brand-700 hover:underline"
                    >
                      Abrir ubicación en Google Maps ↗
                    </a>
                  )}
                </div>
              ) : (
                <div className="space-y-2 border-t border-slate-200 pt-2">
                  <label className="block text-xs text-slate-500">
                    Dirección completa
                    <textarea
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      rows={2}
                      placeholder="Calle, número, urbanización…"
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800"
                    />
                  </label>
                  <label className="block text-xs text-slate-500">
                    Referencia
                    <input
                      value={addressReference}
                      onChange={(e) => setAddressReference(e.target.value)}
                      placeholder="Frente a…, puerta color…"
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-slate-500">
                      Distrito
                      <input
                        value={addressDistrict}
                        onChange={(e) => setAddressDistrict(e.target.value)}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                      />
                    </label>
                    <label className="block text-xs text-slate-500">
                      Ciudad / provincia
                      <input
                        value={addressCity}
                        onChange={(e) => setAddressCity(e.target.value)}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                      />
                    </label>
                  </div>
                  <label className="block text-xs text-slate-500">
                    Departamento
                    <input
                      value={addressRegion}
                      onChange={(e) => setAddressRegion(e.target.value)}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-slate-500">
                      Latitud
                      <input
                        value={addressLatitude}
                        onChange={(e) => setAddressLatitude(e.target.value)}
                        inputMode="decimal"
                        placeholder="-16.409…"
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                      />
                    </label>
                    <label className="block text-xs text-slate-500">
                      Longitud
                      <input
                        value={addressLongitude}
                        onChange={(e) => setAddressLongitude(e.target.value)}
                        inputMode="decimal"
                        placeholder="-71.556…"
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                      />
                    </label>
                  </div>
                  <p className="rounded-lg bg-sky-50 px-2 py-1.5 text-[11px] leading-relaxed text-sky-800">
                    Al guardar se actualizará el pedido de Shopify y esta dirección no será reemplazada por futuros Excel.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddressEditor(false)}
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const payload: ShipmentAddressInput = {
                          address,
                          reference: addressReference,
                          district: addressDistrict,
                          city: addressCity,
                          region: addressRegion,
                          latitude: parsedLatitude,
                          longitude: parsedLongitude,
                        };
                        run(
                          () => updateShipmentDeliveryAddress(shipmentId, payload),
                          () => setShowAddressEditor(false),
                        );
                      }}
                      disabled={pending || !addressFormValid}
                      className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {pending ? "Guardando…" : "Guardar nuevo destino"}
                    </button>
                  </div>
                </div>
              )}
              </div>

            {/* order link — search+link (not just a raw UUID) for any shipment,
                so a wrong auto-match can also be corrected here */}
              <div className="space-y-1.5 border-t border-indigo-200 bg-indigo-50/65 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-indigo-950">
                  <span className="text-xs font-normal text-indigo-500">Pedido </span>
                  <OrderNameLabel name={detail.shipment.order_name} matched={detail.shipment.matched} />
                </p>
                {detail.shipment.matched && (
                  <button
                    onClick={() => setShowOrderPicker((v) => !v)}
                    className="shrink-0 text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline"
                  >
                    {showOrderPicker ? "Cancelar" : "Cambiar"}
                  </button>
                )}
              </div>
              {(!detail.shipment.matched || showOrderPicker) && (
                <OrderLinkPicker
                  shipmentId={shipmentId}
                  prefill={detail.shipment.order_name}
                  customerPhone={detail.shipment.customer_phone}
                  onLinked={() => {
                    setShowOrderPicker(false);
                    refresh();
                  }}
                />
              )}
              {detail.shipment.matched && !showOrderPicker &&
                (detail.order ? (
                  <ShipmentOrderItems order={detail.order} />
                ) : (
                  <p className="border-t border-slate-100 pt-2 text-xs text-slate-400">
                    No se encontró el detalle sincronizado de Shopify.
                  </p>
                ))}
              </div>
            </section>

            {msg && <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm text-slate-700">{msg}</p>}

            {/* Step 1 for active Fenix deliveries: process the courier outcome
                before any customer call or reprogramming can be registered. */}
            {detail.shipment.courier === "fenix" && (
              detail.shipment.delivery_status === "transferido" ? (
                <section className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-600">Guía reemplazada</p>
                  <p className="text-sm font-semibold text-sky-900">Continúa en la guía Fenix activa</p>
                  <p className="text-xs leading-relaxed text-sky-800">
                    “Transferido” lo asigna Kapta automáticamente; no es un resultado del motorizado.
                  </p>
                  {detail.linkedFenixShipment && (
                    <button
                      type="button"
                      onClick={() => handleOpenShipment(detail.linkedFenixShipment!.id)}
                      className="flex w-full items-center justify-between rounded-lg border border-sky-200 bg-white px-3 py-2 text-left hover:bg-sky-50"
                    >
                      <span>
                        <span className="block text-[10px] uppercase tracking-wide text-sky-600">Abrir guía activa</span>
                        <span className="font-mono text-xs font-semibold text-sky-900">
                          {detail.linkedFenixShipment.guide_code}
                        </span>
                      </span>
                      <span className="text-sm text-sky-700">→</span>
                    </button>
                  )}
                </section>
              ) : fenixReadyForCustomerManagement && !showCourierCorrection ? (
                <section className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Etapa 1 completada</p>
                    <p className="mt-0.5 text-sm font-semibold text-emerald-900">Pendiente de gestión con el cliente</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-emerald-800">
                      Continúa abajo con la llamada. Si confirma, recién se generará la nueva reprogramación.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCourierCorrection(true)}
                    className="shrink-0 text-[11px] font-medium text-emerald-800 hover:underline"
                  >
                    Corregir resultado
                  </button>
                </section>
              ) : (
                <section className="space-y-2.5 rounded-xl border border-orange-200 bg-orange-50/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-orange-700">
                        {fenixAwaitingCourierResult ? "Etapa 1 · obligatoria" : "Corrección del reporte"}
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-900">Registrar resultado del courier</p>
                      <p className="mt-0.5 font-mono text-xs font-semibold text-orange-800">
                        {detail.shipment.guide_code}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Estado actual</p>
                      <StatusBadge
                        category={detail.shipment.status_category}
                        status={detail.shipment.delivery_status}
                      />
                    </div>
                  </div>

                  {fenixAwaitingCourierResult && (
                    <p className="rounded-lg bg-orange-100 px-2.5 py-2 text-xs leading-relaxed text-orange-900">
                      Esta guía está En ruta. Primero registra lo informado por el motorizado; la llamada y la reprogramación se habilitarán solo si vuelve a Pendiente.
                    </p>
                  )}

                  <label className="block text-xs font-medium text-slate-600">
                    ¿Qué informó Fenix?
                    <select
                      value={courierResult}
                      onChange={(e) => {
                        setCourierResult(e.target.value as CourierReportResult | "");
                        setCourierDate("");
                      }}
                      className="mt-1 w-full rounded-lg border border-orange-200 bg-white px-2.5 py-2 text-sm text-slate-800"
                    >
                      <option value="">Selecciona el resultado…</option>
                      {COURIER_REPORT_RESULTS.map((result) => (
                        <option key={result.code} value={result.code}>{result.optionLabel}</option>
                      ))}
                    </select>
                  </label>

                  {courierResultDefinition && (
                    <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Qué sucederá</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-700">
                        {courierResultDefinition.effect}
                      </p>
                      {reopensClosedGuide && (
                        <p className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">
                          Esta corrección reabrirá una guía que actualmente está cerrada.
                        </p>
                      )}
                    </div>
                  )}

                  {courierResultDefinition?.requiresDate && (
                    <label className="block text-xs font-medium text-slate-600">
                      Nueva fecha de entrega informada por Fenix
                      <input
                        type="date"
                        value={courierDate}
                        onChange={(e) => setCourierDate(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-orange-200 bg-white px-2.5 py-2 text-sm"
                      />
                    </label>
                  )}

                  {courierResultDefinition && (
                    <label className="block text-xs font-medium text-slate-600">
                      {courierResult === "no_contesta"
                        ? "Comentario para el historial (opcional)"
                        : courierResultDefinition.requiresNote
                          ? "Motivo informado por Fenix"
                          : "Detalle del reporte (opcional)"}
                      <textarea
                        value={courierNote}
                        onChange={(e) => setCourierNote(e.target.value)}
                        rows={2}
                        placeholder={
                          courierResult === "no_contesta"
                            ? "Ej.: motorizado llamó dos veces; cliente no respondió…"
                            : courierResultDefinition.requiresNote
                              ? "Ej.: cliente rechazó el pedido…"
                              : "Detalle informado por el courier…"
                        }
                        className="mt-1 w-full rounded-lg border border-orange-200 bg-white px-2.5 py-2 text-sm"
                      />
                      {courierResult === "no_contesta" && (
                        <span className="mt-1 block text-[10px] font-normal leading-relaxed text-slate-400">
                          Se guardará en el historial junto al cambio No contesta → Pendiente.
                        </span>
                      )}
                    </label>
                  )}

                  <div className="flex gap-2">
                    {showCourierCorrection && (
                      <button
                        type="button"
                        onClick={() => setShowCourierCorrection(false)}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (!courierResult) return;
                        run(
                          () => registerCourierReportResult(shipmentId, {
                            result: courierResult,
                            deliveryDate: courierDate ? new Date(courierDate).toISOString() : null,
                            note: courierNote,
                          }),
                          () => {
                            setCourierResult("");
                            setCourierDate("");
                            setCourierNote("");
                            setShowCourierCorrection(false);
                          },
                        );
                      }}
                      disabled={pending || !courierFormValid}
                      className="flex-1 rounded-lg bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                    >
                      {pending ? "Registrando…" : "Registrar resultado y continuar"}
                    </button>
                  </div>
                </section>
              )
            )}

            {/* claim + re-route call — hidden once the shipment is terminal (entregado/
                anulado/transferido) so a stray "no contesta" can't reopen a closed guide */}
            {isCallable(detail.shipment.delivery_status) && !fenixAwaitingCourierResult && (
              <section className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/45 p-2.5 shadow-[0_1px_0_rgba(245,158,11,0.08)]">
                <p className="text-sm font-semibold text-amber-950">Registrar o programar llamada</p>
                <select
                  value={disposition}
                  onChange={(e) => setDisposition(e.target.value as RerouteDisposition)}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                >
                  {DISPOSITIONS.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {disposition === "confirma" && aliclikDecision && (
                  <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2.5">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Paso 1 · elegir ruta
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600">{aliclikDecisionCopy(aliclikDecision)}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setReprogramProvider("aliclik");
                          setForceAliclik(false);
                        }}
                        disabled={!aliclikDecision.eligible}
                        className={cn(
                          "rounded-lg border px-2.5 py-2 text-left text-xs transition",
                          reprogramProvider === "aliclik" && !forceAliclik
                            ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                            : "border-slate-200 bg-white text-slate-600",
                          !aliclikDecision.eligible && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <span className="block font-semibold">Aliclik</span>
                        <span>Misma guía</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReprogramProvider("fenix");
                          setForceAliclik(false);
                        }}
                        disabled={!fenixRouteAvailable}
                        className={cn(
                          "rounded-lg border px-2.5 py-2 text-left text-xs transition",
                          reprogramProvider === "fenix"
                            ? "border-orange-400 bg-orange-50 text-orange-800"
                            : "border-slate-200 bg-white text-slate-600",
                          !fenixRouteAvailable && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <span className="block font-semibold">Fenix</span>
                        <span>{fenixRouteAvailable ? "Nueva guía" : "Sin stock/cobertura"}</span>
                      </button>
                    </div>
                    {!aliclikDecision.eligible &&
                      aliclikDecision.reason !== "not_aliclik" &&
                      aliclikDecision.reason !== "three_attempts" && (
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={forceAliclik}
                          onChange={(e) => {
                            setForceAliclik(e.target.checked);
                            setReprogramProvider(e.target.checked ? "aliclik" : "fenix");
                          }}
                          className="mt-0.5"
                        />
                        <span>
                          <b>Excepción manual Aliclik.</b> Requiere explicar el motivo en la nota y quedará auditada.
                        </span>
                      </label>
                    )}
                    {reprogramProvider === "aliclik" ? (
                      <p className="rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
                        Primero realiza la reprogramación en Aliclik. Luego confírmala aquí: se conservará la guía actual.
                      </p>
                    ) : detail.shipment.order_name ? (
                      <p className="rounded-lg bg-orange-50 px-2.5 py-1.5 text-xs text-orange-800">
                        Se generará automáticamente una <b>nueva guía Fenix</b> con la fecha elegida.
                      </p>
                    ) : (
                      <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                        Sin N° de pedido no se puede autogenerar. Usa <b>Generar guía Fenix (manual)</b> abajo.
                      </p>
                    )}
                  </div>
                )}
                {disposition === "programar" && (
                  <p className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs text-sky-800">
                    La guía se ocultará hasta la fecha elegida y volverá a la cola ese día.
                    No aumenta los intentos ni cambia el estado del envío.
                  </p>
                )}
                <label className="block text-xs text-slate-500">
                  {disposition === "confirma"
                    ? reprogramProvider === "aliclik"
                      ? "Fecha de reprogramación en Aliclik"
                      : "Fecha de reprogramación (va en la nueva guía Fenix)"
                    : disposition === "programar"
                      ? "Fecha de próxima llamada"
                      : "Próximo intento"}
                  <input
                    type="date"
                    value={nextDate}
                    onChange={(e) => setNextDate(e.target.value)}
                    min={disposition === "programar" ? tomorrowDateInputValue() : undefined}
                    className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                  />
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Nota de la llamada…"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                  rows={2}
                />
                <button
                  onClick={() =>
                    run(() =>
                      registerRerouteCall(shipmentId, {
                        disposition,
                        note,
                        nextFollowupAt: nextDate ? new Date(nextDate).toISOString() : null,
                        reprogramProvider,
                        forceAliclik,
                      }),
                    )
                  }
                  disabled={pending || requiredDateMissing}
                  className="w-full rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {disposition === "confirma" && !nextDate
                    ? "Elige la fecha para confirmar"
                    : fenixAutoUnavailable
                      ? "Fenix no disponible; usa una excepción manual"
                    : overrideNoteMissing
                      ? "Explica el motivo de la excepción"
                    : programDateInvalid
                      ? "Elige una fecha futura"
                      : disposition === "programar"
                        ? "Programar llamada"
                        : disposition === "confirma" && reprogramProvider === "aliclik"
                          ? "Confirmar reprogramación Aliclik"
                          : disposition === "confirma"
                            ? "Crear guía Fenix y confirmar"
                            : "Registrar llamada"}
                </button>
              </section>
            )}

            {/* Fenix guide — manual fallback. The common path auto-generates the
                guide from "Cliente confirma" above; this stays for shipments
                without an order name, or to type a specific Fenix code. */}
            {detail.shipment.delivery_status === "pendiente" && (
              <section className="space-y-1.5 rounded-xl border border-orange-200 bg-orange-50/45 p-2.5 shadow-[0_1px_0_rgba(249,115,22,0.08)]">
              <p className="text-sm font-semibold text-orange-950">Generar guía Fenix (manual)</p>
              {detail.shipment.fenix_shipment_id ? (
                <p className="text-xs text-emerald-700">Ya tiene guía Fenix vinculada.</p>
              ) : (
                <>
                  <label className="block text-xs text-slate-500">
                    Fecha de reprogramación (va en la guía)
                  </label>
                  <input
                    type="date"
                    value={nextDate}
                    onChange={(e) => setNextDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                  />
                  <div className="flex gap-2">
                    <input
                      value={fenixGuide}
                      onChange={(e) => setFenixGuide(e.target.value)}
                      placeholder="N° de guía Fenix"
                      className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setFenixGuide(
                          rescheduleGuideCode(
                            detail.shipment.order_name,
                            nextDate ? new Date(nextDate).toISOString() : null,
                          ),
                        )
                      }
                      disabled={!detail.shipment.order_name}
                      title={
                        detail.shipment.order_name
                          ? undefined
                          : "Este envío no tiene N° de pedido para generar la guía"
                      }
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Autogenerar
                    </button>
                  </div>
                  <button
                    onClick={() =>
                      run(() =>
                        createFenixGuide(shipmentId, {
                          guideCode: fenixGuide,
                          nextFollowupAt: nextDate ? new Date(nextDate).toISOString() : null,
                        }),
                      )
                    }
                    disabled={pending || !fenixGuide.trim()}
                    className="w-full rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-800 hover:bg-orange-100 disabled:opacity-50"
                  >
                    Crear guía Fenix
                  </button>
                </>
              )}
              </section>
            )}

            </fieldset>

            {/* history */}
            <section className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/45 p-2.5">
              <p className="text-sm font-semibold text-violet-950">Historial</p>
              {detail.calls.length === 0 ? (
                <p className="text-xs text-slate-400">Sin registros.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.calls.map((c) => (
                    <li key={c.id} className="rounded-lg border border-violet-100 bg-white px-3 py-2 text-xs text-slate-600">
                      <div className="flex justify-between">
                        <span className="font-medium text-slate-700">
                          {shipmentHistoryLabel(c)}
                          {c.new_status ? ` → ${labelOf(c.new_status)}` : ""}
                        </span>
                        <span className="text-slate-400">{c.agent_name ?? ""}</span>
                      </div>
                      {c.note && <p className="mt-0.5">{c.note}</p>}
                      {c.next_followup_at && (
                        <p className="mt-0.5 text-slate-500">
                          {c.new_status === "en_ruta"
                            ? "Fecha de reprogramación"
                            : c.new_status
                              ? "Próximo intento"
                              : "Próxima llamada"}
                          : {fmtReprogram(c.next_followup_at)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/** Multi-select city filter: a button + popover checklist with a search box.
 *  Empty selection = no filter (all cities shown). */
function ChecklistFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const term = q.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.toLowerCase().includes(term)) : options;

  function toggle(city: string) {
    const next = new Set(selected);
    if (next.has(city)) next.delete(city);
    else next.add(city);
    onChange(next);
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "rounded-lg border px-2.5 py-1 text-xs font-medium",
          selected.size > 0
            ? "border-brand-200 bg-brand-50 text-brand-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        {label}{selected.size > 0 ? ` (${selected.size})` : ""} ▾
      </button>
      {open && (
        <div className="absolute left-0 z-10 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Buscar ${label.toLowerCase()}…`}
            className="mb-2 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          />
          {selected.size > 0 && (
            <button
              onClick={() => onChange(new Set())}
              className="mb-1 text-xs text-slate-500 hover:underline"
            >
              Limpiar selección
            </button>
          )}
          <ul className="max-h-60 overflow-y-auto">
            {shown.map((city) => (
              <li key={city}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm capitalize hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selected.has(city)}
                    onChange={() => toggle(city)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-slate-700">{city}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-1.5 py-1 text-xs text-slate-400">Sin coincidencias.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  clamp,
}: {
  label: string;
  value: string | null | undefined;
  /** Truncate long values (e.g. a product name) to 2 lines instead of
   *  eating the drawer's vertical space — full text still on hover. */
  clamp?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className={cn("text-slate-700", clamp && "line-clamp-2")} title={clamp ? (value ?? undefined) : undefined}>
        {value || "—"}
      </dd>
    </div>
  );
}

function CompactMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | null | undefined;
  tone?: "neutral" | "positive";
}) {
  return (
    <div className="min-w-0 px-2.5 py-2">
      <dt className="text-[10px] font-medium uppercase leading-tight tracking-wide text-slate-400">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-xs font-semibold leading-tight tabular-nums",
          tone === "positive" ? "text-emerald-700" : "text-slate-700",
        )}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

/**
 * The Aliclik NOTA parse can guess an order reference before it's actually
 * linked (matched=false) — but that guess is unverified (no phone check), so
 * it's never shown as if it were a real pedido. Only a confirmed vínculo
 * renders here; the guess still prefills the search box in OrderLinkPicker,
 * where it's verified against the phone before linking.
 */
function OrderNameLabel({ name, matched }: { name: string | null; matched: boolean }) {
  if (matched && name) return <>{name}</>;
  return <span className="text-slate-400">—</span>;
}

function ShipmentOrderItems({ order }: { order: ShipmentOrderDetail }) {
  const units = order.line_items.reduce(
    (total, item) => total + Math.max(0, item.quantity || 0),
    0,
  );

  return (
    <div className="border-t border-slate-100 pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-slate-600">Productos de Shopify</p>
        {order.line_items.length > 0 && (
          <p className="shrink-0 text-xs tabular-nums text-slate-400">
            {order.line_items.length} {order.line_items.length === 1 ? "producto" : "productos"}
            {" · "}
            {units} {units === 1 ? "unidad" : "unidades"}
          </p>
        )}
      </div>

      {order.line_items.length === 0 ? (
        <p className="mt-1.5 text-xs text-slate-400">Shopify no devolvió productos para este pedido.</p>
      ) : (
        <ul className="mt-1.5 divide-y divide-slate-100">
          {order.line_items.map((item, index) => (
            <li
              key={`${item.variant_id ?? item.sku ?? item.title}-${index}`}
              className="flex items-start gap-2.5 py-2 first:pt-1 last:pb-0"
            >
              <span className="inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 px-1.5 text-xs font-semibold tabular-nums text-slate-700">
                {item.quantity}×
              </span>
              <div className="min-w-0">
                <p className="text-sm leading-5 text-slate-700">
                  {item.title || "Producto sin nombre"}
                </p>
                {item.sku && <p className="mt-0.5 text-xs text-slate-400">SKU {item.sku}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


// ── Métricas de reprogramación Kapso→Fénix ───────────────────────────────────

function pctLabel(tasa: number | null): string | null {
  return tasa == null ? null : `${Math.round(tasa * 100)}%`;
}

/** Franja compacta bajo el encabezado: la tasa de entrega de lo reprogramado en
 *  Kapso (guías Fénix hijas), visible sin clics. "Ver detalle" abre el popup. */
function ReprogramStrip({ stats, stores }: { stats: ReprogramStats; stores: StoreSummary[] }) {
  const [open, setOpen] = useState(false);
  if (!stats.historico.total) return null;
  const c = stats.last30;
  const pct = pctLabel(c.tasa);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-800">🔁 Reprogramados en Kapso</span>
        <span className="text-slate-400">últimos 30 días:</span>
        <span className="font-semibold text-slate-800">{c.total}</span>
        <span>
          ✅ {c.entregados} entregados por Fénix
          {pct && (
            <>
              {" "}
              (<b>{pct}</b> de los cerrados)
            </>
          )}
        </span>
        <span>✖ {c.anulados} anulados</span>
        <span>
          🚚 {c.enCurso} en curso
          {c.enCursoViejos > 0 && (
            <span className="font-medium text-amber-600"> · ⚠️ {c.enCursoViejos} varados +{REPROGRAM_STALE_DAYS}d</span>
          )}
        </span>
        <button type="button" onClick={() => setOpen(true)} className="ml-auto font-medium text-brand-700 hover:underline">
          Ver detalle
        </button>
      </div>
      {open && <ReprogramModal stats={stats} stores={stores} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReprogramCountsRow({ label, c }: { label: string; c: ReprogramCounts }) {
  const pct = pctLabel(c.tasa);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="w-28 shrink-0 truncate font-medium text-slate-700">{label}</span>
      <span className="tabular-nums text-slate-800">{c.total}</span>
      <span className="tabular-nums text-emerald-700">✅ {c.entregados}</span>
      <span className="tabular-nums text-slate-500">✖ {c.anulados}</span>
      <span className="tabular-nums text-slate-500">🚚 {c.enCurso}</span>
      {c.enCursoViejos > 0 && <span className="tabular-nums text-amber-600">⚠️ {c.enCursoViejos}</span>}
      <span className="ml-auto font-semibold tabular-nums text-slate-800">{pct ?? "—"}</span>
    </div>
  );
}

/** Popup de análisis: histórico, tendencia semanal y split por tienda. La tasa
 *  siempre es sobre CERRADOS (entregado+anulado) — lo en curso se lista aparte. */
function ReprogramModal({
  stats,
  stores,
  onClose,
}: {
  stats: ReprogramStats;
  stores: StoreSummary[];
  onClose: () => void;
}) {
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Otra";
  const maxWeek = Math.max(1, ...stats.semanas.map((w) => w.total));
  const weekLabel = (start: string) => `${start.slice(8, 10)}/${start.slice(5, 7)}`;
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/30 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">🔁 Reprogramaciones Kapso → Fénix</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <div className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
          <ReprogramCountsRow label="Últimos 30 días" c={stats.last30} />
          <ReprogramCountsRow label="Histórico" c={stats.historico} />
        </div>

        {/* Tendencia semanal (semana = lunes local). Barra = reprogramados; el
            segmento verde son los que YA terminaron entregados. */}
        <p className="mt-4 mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Últimas 8 semanas</p>
        <div className="flex items-end gap-1.5">
          {stats.semanas.map((w) => {
            const h = Math.round((w.total / maxWeek) * 64);
            const hOk = w.total ? Math.round((w.entregados / w.total) * h) : 0;
            return (
              <div key={w.start} className="flex flex-1 flex-col items-center gap-0.5">
                <span className="text-[10px] tabular-nums text-slate-500">{w.total || ""}</span>
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-slate-100"
                  style={{ height: 64 }}
                  title={`Semana del ${weekLabel(w.start)}: ${w.total} reprogramados · ${w.entregados} entregados · ${w.anulados} anulados`}
                >
                  <div className="w-full bg-slate-300" style={{ height: Math.max(0, h - hOk) }} />
                  <div className="w-full bg-emerald-500" style={{ height: hOk }} />
                </div>
                <span className="text-[10px] text-slate-400">{weekLabel(w.start)}</span>
              </div>
            );
          })}
        </div>

        <p className="mt-4 mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Por tienda (histórico)</p>
        <div className="space-y-1.5">
          {Object.entries(stats.porTienda)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([sid, c]) => (
              <ReprogramCountsRow key={sid} label={storeName(sid)} c={c} />
            ))}
        </div>

        <p className="mt-4 text-[11px] leading-snug text-slate-400">
          Universo: guías Fénix creadas por una reprogramación confirmada en el dashboard (las entregas de primer
          intento de Aliclik no entran). La <b>tasa</b> es entregados ÷ cerrados (entregados + anulados) — lo en curso
          no la afecta. <b>⚠️ Varados</b>: en curso hace más de {REPROGRAM_STALE_DAYS} días, probables anulados sin
          confirmar.
        </p>
      </div>
    </div>
  );
}
