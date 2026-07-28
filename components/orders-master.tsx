"use client";

// Master de Pedidos — la vista central de control de la operación logística.
//
// Estructura, igual que el board de Repro Provincia: el servidor carga TODAS las
// tiendas accesibles para la pestaña activa y aquí se filtra en cliente, porque
// los filtros son combinables y multi-selección (§13). La lógica de qué fila
// entra y en qué orden vive en lib/order-master-filters.ts, testeada aparte;
// este archivo solo compone estado y pinta.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, cn, EmptyState } from "@/components/ui";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { ChecklistFilter } from "@/components/filters";
import { PickupKeyPanel } from "@/components/pickup-key-panel";
import { TandersGuideModal } from "@/components/tanders-guide-modal";
import { markTandersLabelGenerated } from "@/app/dashboard/pedidos/tanders-actions";
import { ShalomGuideModal } from "@/components/shalom-guide-modal";
import { cancelShalomGuide } from "@/app/dashboard/pedidos/shalom-actions";
import { shalomGuideIsCancelable } from "@/lib/shalom/draft";
import {
  addOrderComment,
  clearOrderGeo,
  loadOrderDetail,
  loadOrderGeo,
  registerReturn,
  relinkGuide,
  searchOrders,
  setOrderStatus,
  updateOrderGeo,
  type OrderGeoInput,
} from "@/app/dashboard/pedidos/actions";
import {
  agencySummary,
  applyFilters,
  emptyFilters,
  facetValues,
  hasActiveFilters,
  sortRows,
  type MasterFilters,
  type MasterSortKey,
} from "@/lib/order-master-filters";
import {
  GENERAL_STATUSES,
  daysInAgency,
  daysInStatus,
  generalLabel,
  isGeneralStatus,
  operationalLabel,
  operationalStatusesFor,
  type GeneralStatus,
} from "@/lib/order-status";
import { KEY_STATE_LABEL, PAYMENT_STATE_LABEL, usesPickupKeyFlow, type KeyState, type PaymentState } from "@/lib/pickup-key";
import { MASTER_VIEWS, type MasterCounts, type MasterView, type OrderMasterDetail } from "@/lib/orders-master-access";
import type { OrderMasterRow, StoreSummary } from "@/lib/types";

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Antigüedad legible: lo que el equipo mira para detectar lo estancado. */
function fmtAge(since: string | null): string {
  const days = daysInStatus(since);
  if (days === null) return "—";
  if (days === 0) return "hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}

function fmtMoney(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `S/ ${value.toFixed(2)}`;
}

const MODE_LABEL: Record<string, string> = {
  cod: "Contraentrega",
  agency: "Agencia",
};

const STATUS_TONE: Record<string, string> = {
  pendiente: "bg-slate-100 text-slate-700",
  en_proceso: "bg-amber-100 text-amber-800",
  entregado: "bg-emerald-100 text-emerald-800",
  anulado: "bg-slate-200 text-slate-600",
  devuelto: "bg-red-100 text-red-800",
};

/**
 * Anular una guía de Shalom, en dos pasos.
 *
 * Crear emite una guía real y cobrable de un solo clic, así que deshacer no
 * puede ser otro clic a su lado: un resbalón del ratón en una lista de guías
 * anularía un despacho. El primer clic solo cambia el botón por una pregunta con
 * el número de guía delante; el segundo es el que llama.
 *
 * El botón únicamente aparece mientras Shalom todavía deja borrar (ver
 * `shalomGuideIsCancelable`), pero eso es cortesía de interfaz: el servidor
 * revalida las mismas condiciones, porque un botón que no se pinta no es una
 * autorización.
 */
function ShalomCancelButton({
  shipmentId,
  guideCode,
  codigo,
  onDone,
}: {
  shipmentId: string;
  guideCode: string | null;
  codigo: string | null;
  onDone: (notice: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (busy) return <span className="text-xs text-slate-500">Anulando…</span>;

  if (!confirming) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="text-xs font-medium text-red-700 hover:underline"
        >
          Anular
        </button>
        {error && <span className="w-full text-xs text-red-700">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-red-50 px-2 py-1.5">
      <span className="text-xs text-red-800">
        ¿Anular la guía <strong>{guideCode ?? "—"}</strong>
        {codigo ? ` (${codigo})` : ""} en Shalom? No se puede deshacer.
      </span>
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          const res = await cancelShalomGuide(shipmentId);
          setBusy(false);
          setConfirming(false);
          if ("error" in res) setError(res.error);
          else onDone(res.notice);
        }}
        className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-800"
      >
        Sí, anular
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-xs font-medium text-slate-600 hover:underline"
      >
        Cancelar
      </button>
    </span>
  );
}

function StatusBadge({ status, locked }: { status: string; locked?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_TONE[status] ?? "bg-slate-100 text-slate-700",
      )}
      title={locked ? "Estado fijado manualmente: el recálculo automático no lo pisa" : undefined}
    >
      {generalLabel(status)}
      {locked && <span aria-hidden="true">🔒</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export function OrdersMasterBoard({
  stores,
  view,
  counts,
  rows,
  canEdit,
  canOverride,
  canCreateGuide,
  canCreateTandersGuide,
  canCreateShalomGuide,
}: {
  stores: StoreSummary[];
  view: MasterView;
  counts: MasterCounts;
  rows: OrderMasterRow[];
  canEdit: boolean;
  canOverride: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<MasterFilters>(emptyFilters);
  const [sortKey, setSortKey] = useState<MasterSortKey>("movement");
  const [showMore, setShowMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // La búsqueda va al servidor: debe encontrar pedidos fuera de la pestaña
  // activa, no solo entre los ya cargados.
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<OrderMasterRow[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const found = await searchOrders(q);
      setResults(found);
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const storeName = useMemo(() => {
    const map = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [stores]);

  const visible = useMemo(() => {
    const filtered = applyFilters(rows, filters);
    return sortRows(filtered, sortKey);
  }, [rows, filters, sortKey]);

  const agency = useMemo(() => agencySummary(rows), [rows]);

  const facets = useMemo(
    () => ({
      operational: facetValues(rows, "operational_status"),
      courier: facetValues(rows, "current_courier"),
      region: facetValues(rows, "region"),
      province: facetValues(rows, "province"),
      district: facetValues(rows, "district"),
      pickup: facetValues(rows, "pickup_state"),
    }),
    [rows],
  );

  function patch(next: Partial<MasterFilters>) {
    setFilters((f) => ({ ...f, ...next }));
  }

  function toggleStore(id: string) {
    setFilters((f) => {
      const next = new Set(f.stores);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, stores: next };
    });
  }

  const searchActive = search.trim().length >= 2;
  const listed = searchActive ? (results ?? []) : visible;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Master de Pedidos</h1>
          <p className="text-xs text-slate-500">
            Estado real de cada pedido de las dos tiendas, con su historial completo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
              🔍
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar pedido, cliente, teléfono o guía…"
              className="w-72 rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm"
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
          {!canEdit && (
            <span className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500">
              Solo lectura
            </span>
          )}
        </div>
      </div>

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
          ) : listed.length ? (
            <MasterTable rows={listed} storeName={storeName} multiStore={stores.length > 1} onOpen={setOpenId} />
          ) : (
            <p className="p-5 text-sm text-slate-400">Sin coincidencias.</p>
          )}
        </Card>
      ) : (
        <>
          {agency.total > 0 && (
            <AgencyStrip
              summary={agency}
              filters={filters}
              onFilter={(next) => setFilters((f) => ({ ...f, ...next }))}
            />
          )}

          {/* Pestañas por estado general */}
          <div className="flex flex-wrap gap-1.5">
            {MASTER_VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => router.push(`/dashboard/pedidos?view=${v.key}`)}
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

          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2">
            {stores.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-400">Tienda:</span>
                {stores.map((s) => {
                  const active = filters.stores.size === 0 || filters.stores.has(s.id);
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

            <ChecklistFilter
              label="Estado operativo"
              options={facets.operational}
              selected={filters.operationalStatuses}
              onChange={(operationalStatuses) => patch({ operationalStatuses })}
              capitalize={false}
            />
            <ChecklistFilter
              label="Courier"
              options={facets.courier}
              selected={filters.couriers}
              onChange={(couriers) => patch({ couriers })}
            />
            <ChecklistFilter
              label="Región"
              options={facets.region}
              selected={filters.regions}
              onChange={(regions) => patch({ regions })}
            />
            <ChecklistFilter
              label="Provincia"
              options={facets.province}
              selected={filters.provinces}
              onChange={(provinces) => patch({ provinces })}
            />
            <ChecklistFilter
              label="Distrito"
              options={facets.district}
              selected={filters.districts}
              onChange={(districts) => patch({ districts })}
            />
            {facets.pickup.length > 0 && (
              <ChecklistFilter
                label="Agencia"
                options={facets.pickup}
                selected={filters.pickupStates}
                onChange={(pickupStates) => patch({ pickupStates })}
                capitalize={false}
              />
            )}

            <button
              onClick={() => setShowMore((v) => !v)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {showMore ? "Menos filtros" : "Más filtros"} ▾
            </button>

            {hasActiveFilters(filters) && (
              <button
                onClick={() => setFilters(emptyFilters())}
                className="text-xs text-slate-500 hover:underline"
              >
                Limpiar filtros
              </button>
            )}

            <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
              Ordenar por:
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as MasterSortKey)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
              >
                <option value="movement">Último movimiento</option>
                <option value="created">Fecha de creación</option>
                <option value="status_age">Antigüedad en el estado</option>
                <option value="attempts">Intentos</option>
                <option value="couriers">Couriers</option>
                <option value="total">Monto</option>
              </select>
            </label>
          </div>

          {showMore && (
            <Card className="space-y-3 p-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <DateRange
                  label="Creación"
                  from={filters.createdFrom}
                  to={filters.createdTo}
                  onChange={(createdFrom, createdTo) => patch({ createdFrom, createdTo })}
                />
                <DateRange
                  label="Despacho"
                  from={filters.dispatchedFrom}
                  to={filters.dispatchedTo}
                  onChange={(dispatchedFrom, dispatchedTo) => patch({ dispatchedFrom, dispatchedTo })}
                />
                <DateRange
                  label="Último movimiento"
                  from={filters.movementFrom}
                  to={filters.movementTo}
                  onChange={(movementFrom, movementTo) => patch({ movementFrom, movementTo })}
                />
                <DateRange
                  label="Entrega"
                  from={filters.deliveredFrom}
                  to={filters.deliveredTo}
                  onChange={(deliveredFrom, deliveredTo) => patch({ deliveredFrom, deliveredTo })}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <label className="flex items-center gap-1.5">
                  Modalidad:
                  <select
                    value={[...filters.shippingModes][0] ?? ""}
                    onChange={(e) =>
                      patch({ shippingModes: e.target.value ? new Set([e.target.value]) : new Set() })
                    }
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  >
                    <option value="">Todas</option>
                    <option value="cod">Contraentrega</option>
                    <option value="agency">Agencia</option>
                  </select>
                </label>
                <Toggle
                  label="Con comentarios"
                  checked={filters.withComments}
                  onChange={(withComments) => patch({ withComments })}
                />
                <Toggle
                  label="Más de un courier"
                  checked={filters.multiCourier}
                  onChange={(multiCourier) => patch({ multiCourier })}
                />
                <Toggle
                  label="Más de un intento"
                  checked={filters.multiAttempt}
                  onChange={(multiAttempt) => patch({ multiAttempt })}
                />
                <label className="flex items-center gap-1.5">
                  Sin movimientos hace:
                  <select
                    value={filters.staleDays}
                    onChange={(e) => patch({ staleDays: Number(e.target.value) })}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  >
                    <option value={0}>—</option>
                    <option value={3}>3 días</option>
                    <option value={7}>7 días</option>
                    <option value={15}>15 días</option>
                    <option value={30}>30 días</option>
                  </select>
                </label>
              </div>
            </Card>
          )}

          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <p className="text-sm font-medium text-slate-800">
                {listed.length} {listed.length === 1 ? "pedido" : "pedidos"}
                {listed.length !== rows.length && (
                  <span className="ml-1 text-xs font-normal text-slate-400">de {rows.length}</span>
                )}
              </p>
            </div>
            {listed.length ? (
              <MasterTable
                rows={listed}
                storeName={storeName}
                multiStore={stores.length > 1}
                onOpen={setOpenId}
              />
            ) : (
              <p className="p-5 text-sm text-slate-400">
                {rows.length ? "Ningún pedido cumple los filtros." : "Todavía no hay pedidos aquí."}
              </p>
            )}
          </Card>
        </>
      )}

      {openId && (
        <OrderDrawer
          orderId={openId}
          canEdit={canEdit}
          canOverride={canOverride}
          canCreateGuide={canCreateGuide}
          canCreateTandersGuide={canCreateTandersGuide}
          canCreateShalomGuide={canCreateShalomGuide}
          storeName={storeName}
          onClose={() => setOpenId(null)}
          onSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}

/**
 * Tira de seguimiento de agencia (§10). Es lo que evita la devolución: entre el
 * 5 % y el 6 % de estos pedidos termina devuelto por no recogerse a tiempo, así
 * que lo accionable es ver cuántos están disponibles y cuántos van a vencer.
 * Cada bloque es un filtro de un clic.
 */
function AgencyStrip({
  summary,
  filters,
  onFilter,
}: {
  summary: ReturnType<typeof agencySummary>;
  filters: MasterFilters;
  onFilter: (next: Partial<MasterFilters>) => void;
}) {
  const disponiblesActive =
    filters.pickupStates.has("disponible_para_recojo") ||
    filters.pickupStates.has("pendiente_de_recojo");
  const retornoActive = filters.pickupStates.has("retorno_iniciado");

  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Envíos por agencia
        </p>
        <p className="text-xs text-slate-400">Shalom · Olva — seguimiento del recojo</p>
      </div>
      <AgencyStat label="En agencia" value={summary.total} />
      <AgencyStat
        label="Disponibles para recojo"
        value={summary.disponibles}
        active={disponiblesActive}
        onClick={() =>
          onFilter({
            pickupStates: disponiblesActive
              ? new Set()
              : new Set(["disponible_para_recojo", "pendiente_de_recojo"]),
            expiringSoon: false,
          })
        }
      />
      <AgencyStat
        label="Próximos a vencer"
        value={summary.proximosAVencer}
        tone={summary.proximosAVencer > 0 ? "warning" : undefined}
        active={filters.expiringSoon}
        onClick={() => onFilter({ expiringSoon: !filters.expiringSoon, pickupStates: new Set() })}
      />
      <AgencyStat
        label="Retorno iniciado"
        value={summary.retornoIniciado}
        tone={summary.retornoIniciado > 0 ? "warning" : undefined}
        active={retornoActive}
        onClick={() =>
          onFilter({
            pickupStates: retornoActive ? new Set() : new Set(["retorno_iniciado"]),
            expiringSoon: false,
          })
        }
      />
      <AgencyStat label="Devueltos" value={summary.devueltos} tone={summary.devueltos > 0 ? "danger" : undefined} />
    </Card>
  );
}

function AgencyStat({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "warning" | "danger";
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p
        className={cn(
          "text-xl font-semibold",
          tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-slate-900",
        )}
      >
        {value}
      </p>
      <p className="text-xs text-slate-500">{label}</p>
    </>
  );
  if (!onClick) return <div className="min-w-[7rem]">{body}</div>;
  return (
    <button
      onClick={onClick}
      className={cn(
        "min-w-[7rem] rounded-lg px-2 py-1 text-left transition hover:bg-slate-50",
        active && "bg-brand-50 ring-1 ring-brand-200",
      )}
    >
      {body}
    </button>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5"
      />
      {label}
    </label>
  );
}

function DateRange({
  label,
  from,
  to,
  onChange,
}: {
  label: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-400">{label}</p>
      <div className="flex items-center gap-1">
        <input
          type="date"
          value={from}
          onChange={(e) => onChange(e.target.value, to)}
          className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
        />
        <span className="text-xs text-slate-400">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange(from, e.target.value)}
          className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabla (§14)
// ---------------------------------------------------------------------------

/**
 * Indicador de cobro y clave (§"Información visible en el Master"). La clave EN
 * SÍ nunca aparece en la tabla: solo su estado.
 */
function PaymentIndicator({
  paymentState,
  keyState,
}: {
  paymentState: string | null;
  keyState: string | null;
}) {
  if (!paymentState && !keyState) return <>—</>;
  const pay = paymentState ? (PAYMENT_STATE_LABEL[paymentState as PaymentState] ?? paymentState) : null;
  const key = keyState ? (KEY_STATE_LABEL[keyState as KeyState] ?? keyState) : null;
  const alert = paymentState === "posible_duplicado";
  return (
    <span className={cn("text-xs", alert && "font-semibold text-red-700")} title={key ?? undefined}>
      {pay}
      {key && key !== "Sin clave" ? ` · ${key}` : ""}
    </span>
  );
}

/** Días en agencia, resaltando el vencimiento cercano — el dato accionable. */
function AgencyDays({
  arrivedAt,
  expiresAt,
}: {
  arrivedAt: string | null;
  expiresAt: string | null;
}) {
  const days = daysInAgency(arrivedAt);
  if (days === null && !expiresAt) return <>—</>;
  const left = expiresAt ? Date.parse(expiresAt) - Date.now() : null;
  const soon = left !== null && Number.isFinite(left) && left <= 3 * 86_400_000;
  return (
    <span
      className={cn(soon && "font-semibold text-amber-700")}
      title={expiresAt ? `Vence el ${fmtDate(expiresAt)}` : undefined}
    >
      {days === null ? "—" : days}
    </span>
  );
}

function MasterTable({
  rows,
  storeName,
  multiStore,
  onOpen,
}: {
  rows: OrderMasterRow[];
  storeName: (id: string) => string;
  multiStore: boolean;
  onOpen: (orderId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1500px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="px-4 py-2 font-medium">Pedido</th>
            {multiStore && <th className="px-2 py-2 font-medium">Tienda</th>}
            <th className="px-2 py-2 font-medium">Creado</th>
            <th className="px-2 py-2 font-medium">Cliente</th>
            <th className="px-2 py-2 font-medium">Teléfono</th>
            <th className="px-2 py-2 font-medium">Región</th>
            <th className="px-2 py-2 font-medium">Provincia</th>
            <th className="px-2 py-2 font-medium">Distrito</th>
            <th className="px-2 py-2 font-medium">Modalidad</th>
            <th className="px-2 py-2 font-medium">Courier</th>
            <th className="px-2 py-2 font-medium">Último courier</th>
            <th className="px-2 py-2 text-right font-medium" title="Couriers que gestionaron el pedido">
              Cour.
            </th>
            <th className="px-2 py-2 text-right font-medium" title="Intentos de entrega">
              Int.
            </th>
            <th className="px-2 py-2 font-medium">Estado</th>
            <th className="px-2 py-2 font-medium">Estado operativo</th>
            <th className="px-2 py-2 font-medium">Últ. movimiento</th>
            <th className="px-2 py-2 font-medium">Antigüedad</th>
            <th className="px-2 py-2 font-medium">Guía</th>
            <th className="px-2 py-2 font-medium">Agencia</th>
            <th className="px-2 py-2 font-medium" title="Días disponible en agencia">
              Días ag.
            </th>
            <th className="px-2 py-2 font-medium">Pago / clave</th>
            <th className="px-2 py-2 text-center font-medium">💬</th>
            <th className="px-4 py-2 text-right font-medium">Costo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r.order_id)}
              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="px-4 py-2.5 font-medium text-slate-900">{r.order_name ?? "—"}</td>
              {multiStore && <td className="px-2 py-2.5 text-slate-600">{storeName(r.store_id)}</td>}
              <td className="px-2 py-2.5 text-slate-600">{fmtDate(r.order_created_at)}</td>
              <td className="max-w-[180px] truncate px-2 py-2.5 text-slate-700" title={r.customer_name ?? ""}>
                {r.customer_name ?? "—"}
              </td>
              <td className="px-2 py-2.5 text-slate-600">{r.customer_phone ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.region ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.province ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">{r.district ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600">
                {r.shipping_mode ? (MODE_LABEL[r.shipping_mode] ?? r.shipping_mode) : "—"}
              </td>
              <td className="px-2 py-2.5 capitalize text-slate-700">{r.current_courier ?? "—"}</td>
              <td className="px-2 py-2.5 capitalize text-slate-500">{r.last_courier ?? "—"}</td>
              <td className="px-2 py-2.5 text-right text-slate-700">
                <span className={cn(r.courier_count > 1 && "font-semibold text-amber-700")}>
                  {r.courier_count}
                </span>
              </td>
              <td className="px-2 py-2.5 text-right text-slate-700">
                <span className={cn(r.attempt_count > 1 && "font-semibold text-amber-700")}>
                  {r.attempt_count}
                </span>
              </td>
              <td className="px-2 py-2.5">
                <StatusBadge status={r.general_status} locked={r.status_locked} />
              </td>
              <td className="px-2 py-2.5 text-slate-600">{operationalLabel(r.operational_status)}</td>
              <td className="px-2 py-2.5 text-slate-600">{fmtDate(r.last_movement_at)}</td>
              <td className="px-2 py-2.5 text-slate-600">{fmtAge(r.status_since)}</td>
              <td className="px-2 py-2.5 font-mono text-xs text-slate-600">{r.guide_code ?? "—"}</td>
              <td className="px-2 py-2.5 text-slate-600" title={r.agency_branch ?? undefined}>
                {r.pickup_state ? operationalLabel(r.pickup_state) : "—"}
              </td>
              <td className="px-2 py-2.5 text-slate-600">
                <AgencyDays arrivedAt={r.agency_arrived_at} expiresAt={r.agency_expires_at} />
              </td>
              <td className="px-2 py-2.5 text-slate-600">
                <PaymentIndicator paymentState={r.payment_state} keyState={r.key_state} />
              </td>
              <td className="px-2 py-2.5 text-center text-slate-500">
                {r.comment_count > 0 ? r.comment_count : ""}
              </td>
              <td className="px-4 py-2.5 text-right text-slate-600">{fmtMoney(r.logistics_cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalle + línea de tiempo (§15)
// ---------------------------------------------------------------------------

const TIMELINE_LABEL: Record<string, string> = {
  created: "Pedido creado",
  confirmed: "Pedido confirmado",
  cancelled_shopify: "Anulado en Shopify",
  courier_assigned: "Courier asignado",
  guide_registered: "Guía registrada",
  dispatched: "Pedido despachado",
  out_for_delivery: "Salida a reparto",
  attempt_failed: "Intento fallido",
  comment: "Comentario",
  reschedule: "Reprogramación",
  reroute: "Reprogramación",
  courier_change: "Cambio de courier",
  delivered: "Entrega confirmada",
  return_started: "Retorno iniciado",
  returned: "Pedido devuelto",
  status_override: "Estado cambiado manualmente",
  import: "Reporte importado",
  call: "Gestión con el cliente",
  state_change: "Cambio de estado",
  note: "Nota",
  system: "Automático",
};

function OrderDrawer({
  orderId,
  canEdit,
  canOverride,
  canCreateGuide,
  canCreateTandersGuide,
  canCreateShalomGuide,
  storeName,
  onClose,
  onSaved,
}: {
  orderId: string;
  canEdit: boolean;
  canOverride: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
  storeName: (id: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<OrderMasterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tandersOpen, setTandersOpen] = useState(false);
  const [shalomOpen, setShalomOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const reload = useMemo(
    () => async () => {
      const res = await loadOrderDetail(orderId);
      if ("error" in res) setError(res.error);
      else {
        setDetail(res.detail);
        setError(null);
      }
    },
    [orderId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  function run(action: () => Promise<{ error?: string; notice?: string }>) {
    startTransition(async () => {
      const res = await action();
      setError(res.error ?? null);
      setNotice(res.notice ?? null);
      if (!res.error) {
        await reload();
        onSaved();
      }
    });
  }

  const row = detail?.row;

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-xl"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">{row?.order_name ?? "Pedido"}</p>
            {row && (
              <p className="text-xs text-slate-500">
                {storeName(row.store_id)} · creado el {fmtDate(row.order_created_at)}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>

        {error && <p className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {notice && (
          <p className="mx-5 mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
        )}

        {!detail ? (
          <p className="p-5 text-sm text-slate-400">Cargando…</p>
        ) : (
          <div className="space-y-5 p-5">
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={detail.row.general_status} locked={detail.row.status_locked} />
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {operationalLabel(detail.row.operational_status)}
                </span>
                <span className="text-xs text-slate-400">
                  {fmtAge(detail.row.status_since)} en este estado · fuente:{" "}
                  {detail.row.status_source ?? "—"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <Field label="Cliente" value={detail.row.customer_name} />
                <Field label="Teléfono" value={detail.row.customer_phone} />
                <Field
                  label="Modalidad"
                  value={
                    detail.row.shipping_mode
                      ? (MODE_LABEL[detail.row.shipping_mode] ?? detail.row.shipping_mode)
                      : null
                  }
                />
                <Field label="Monto" value={fmtMoney(detail.row.order_total)} />
              </dl>
            </section>

            <GeoSection
              orderId={orderId}
              row={detail.row}
              canEdit={canEdit}
              onSaved={() => {
                void reload();
                onSaved();
              }}
            />

            {detail.lineItems.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Productos
                </h3>
                <ul className="space-y-1 text-sm text-slate-700">
                  {detail.lineItems.map((li, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">{li.title}</span>
                      <span className="shrink-0 text-slate-500">×{li.quantity}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Couriers y guías ({detail.guides.length})
                </h3>
                {/* Solo se ofrece crear guía si el pedido no tiene una: dos guías
                    para un mismo paquete es despacharlo dos veces. */}
                {!detail.row.guide_code && (
                  <div className="ml-auto flex gap-2">
                    {canCreateTandersGuide && (
                      <button
                        onClick={() => setTandersOpen(true)}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        + Guía Tanders
                      </button>
                    )}
                    {canCreateShalomGuide && (
                      <button
                        onClick={() => setShalomOpen(true)}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        + Guía Shalom
                      </button>
                    )}
                  </div>
                )}
              </div>
              {detail.guides.length === 0 ? (
                <p className="text-sm text-slate-400">
                  Sin gestión logística registrada todavía.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.guides.map((g) => (
                    <li
                      key={g.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      <span className="font-medium capitalize text-slate-800">{g.courier}</span>
                      <span className="font-mono text-xs text-slate-500">{g.guide_code}</span>
                      {/* Shalom muestra en su panel el nº de orden Y un código
                          corto. Sin el corto hay que abrir cada envío allá para
                          saber cuál es cuál. */}
                      {g.shalom_codigo && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-700">
                          {g.shalom_codigo}
                        </span>
                      )}
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {g.delivery_status}
                      </span>
                      {(g.aliclik_attempts ?? g.reroute_attempts) > 0 && (
                        <span className="text-xs text-amber-700">
                          {g.aliclik_attempts ?? g.reroute_attempts} intento(s)
                        </span>
                      )}
                      {g.courier === "tanders" && (
                        // Navegación real (no window.open tras un await): así el
                        // bloqueador de ventanas emergentes no se la come. El
                        // marcado en Tanders sale en paralelo, sin frenar la
                        // impresión — el rótulo ya está compuesto de nuestro lado.
                        <a
                          href={`/dashboard/pedidos/rotulos?ids=${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => void markTandersLabelGenerated([g.id])}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          Rótulo ↗
                        </a>
                      )}
                      {/* El rótulo de Shalom lo compone ELLOS, no nosotros: se
                          pide a su API y se sirve como PDF. Solo existe para las
                          guías creadas por API — las que llegaron por el Excel
                          no tienen `ose_id` y hay que bajarlas de su panel. */}
                      {g.courier === "shalom" && g.shalom_ose_id && (
                        <a
                          href={`/api/shalom/label/${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          Rótulo ↗
                        </a>
                      )}
                      {canCreateShalomGuide && shalomGuideIsCancelable(g) && (
                        <ShalomCancelButton
                          shipmentId={g.id}
                          guideCode={g.guide_code}
                          codigo={g.shalom_codigo ?? null}
                          onDone={(msg) => {
                            setNotice(msg);
                            void reload();
                            onSaved();
                          }}
                        />
                      )}
                      {g.guide_code === detail.row.guide_code && (
                        <span className="ml-auto text-xs text-slate-400">actual</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Línea de tiempo ({detail.timeline.length})
              </h3>
              {detail.timeline.length === 0 ? (
                <p className="text-sm text-slate-400">Sin movimientos registrados.</p>
              ) : (
                <ol className="space-y-2 border-l border-slate-200 pl-4">
                  {detail.timeline.map((t) => (
                    <li key={t.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-slate-300" />
                      <p className="text-sm text-slate-800">
                        {TIMELINE_LABEL[t.kind] ?? t.kind}
                        {t.newStatus && (
                          <span className="ml-1 text-slate-500">
                            → {generalLabel(t.newStatus)}
                          </span>
                        )}
                      </p>
                      {(t.note || t.reason) && (
                        <p className="text-sm text-slate-600">{t.note ?? t.reason}</p>
                      )}
                      <p className="text-xs text-slate-400">
                        {fmtDateTime(t.occurredAt)}
                        {t.actorName ? ` · ${t.actorName}` : ""}
                        {t.courier ? ` · ${t.courier}` : ""}
                        {t.guideCode ? ` · ${t.guideCode}` : ""}
                        {` · ${t.origin === "gestion" ? "Repro Provincia" : t.source}`}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {usesPickupKeyFlow(detail.row.current_courier, detail.row.shipping_mode) && (
              <PickupKeyPanel orderId={orderId} onChanged={onSaved} />
            )}

            {/* Crear guía: solo tiene sentido en un pedido que todavía no tiene
                una. En cuanto existe, el seguimiento vive en Envíos. */}
            {canCreateGuide && !detail.row.guide_code && (
              <AliclikGuidePanel
                orderId={orderId}
                hasCoordinate={detail.row.latitude != null && detail.row.longitude != null}
                onCreated={() => {
                  void reload();
                  onSaved();
                }}
              />
            )}

            {canEdit ? (
              <OrderActions
                row={detail.row}
                canOverride={canOverride}
                pending={pending}
                onStatus={(general, operational, reason) =>
                  run(() => setOrderStatus(orderId, { general, operational, reason }))
                }
                onComment={(text, type) => run(() => addOrderComment(orderId, { text, type }))}
                onReturn={(reason, guideCode) => run(() => registerReturn(orderId, { reason, guideCode }))}
                onRelink={(guideCode) => run(() => relinkGuide(guideCode, orderId))}
              />
            ) : (
              <EmptyState title="Solo lectura">
                Tu rol permite consultar el pedido, sus comentarios y su historial, pero no modificarlo.
              </EmptyState>
            )}
          </div>
        )}
      </aside>

      {tandersOpen && (
        <TandersGuideModal
          orderId={orderId}
          onClose={() => setTandersOpen(false)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}

      {shalomOpen && (
        <ShalomGuideModal
          orderId={orderId}
          onClose={() => setShalomOpen(false)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}
    </div>
  );
}


/** Enlace al mapa: por coordenadas si las hay, si no por la dirección escrita. */
function mapUrl(row: OrderMasterRow): string | null {
  if (row.latitude != null && row.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}`;
  }
  const parts = [row.address, row.district, row.province, row.region, "Perú"].filter(Boolean);
  if (parts.length <= 1) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}`;
}

const GEO_SOURCE_LABEL: Record<string, string> = {
  manual: "corregida por el equipo",
  courier: "según el reporte del courier",
  ubigeo: "provincia inferida del distrito",
  shopify: "según Shopify",
  draft: "según el formulario COD",
};

/**
 * Ubicación del pedido, editable. La dirección de Shopify sale del formulario que
 * llenó el cliente —Shopify mismo la marca como problemática a menudo— y su punto
 * del mapa suele estar desplazado. Corregirla aquí no toca `orders`: la
 * corrección vive aparte y sobrevive a la siguiente sincronización.
 */
function GeoSection({
  orderId,
  row,
  canEdit,
  onSaved,
}: {
  orderId: string;
  row: OrderMasterRow;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<OrderGeoInput>({});
  const [hasOverride, setHasOverride] = useState(row.geo_source === "manual");
  const [remember, setRemember] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function open() {
    const current = await loadOrderGeo(orderId);
    setHasOverride(current.hasOverride);
    setForm({
      region: current.region ?? row.region ?? "",
      province: current.province ?? row.province ?? "",
      district: current.district ?? row.district ?? "",
      address: current.address ?? row.address ?? "",
      reference: current.reference ?? row.reference ?? "",
      latitude: current.latitude ?? row.latitude ?? "",
      longitude: current.longitude ?? row.longitude ?? "",
      note: "",
    });
    setEditing(true);
  }

  function save() {
    startTransition(async () => {
      const res = await updateOrderGeo(orderId, { ...form, rememberDistrict: remember });
      setMessage(res.error ?? res.notice ?? null);
      if (!res.error) {
        setEditing(false);
        onSaved();
      }
    });
  }

  function clear() {
    startTransition(async () => {
      const res = await clearOrderGeo(orderId);
      setMessage(res.error ?? res.notice ?? null);
      if (!res.error) {
        setEditing(false);
        setHasOverride(false);
        onSaved();
      }
    });
  }

  const url = mapUrl(row);
  const set = (patch: Partial<OrderGeoInput>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ubicación</h3>
        {row.geo_source && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {GEO_SOURCE_LABEL[row.geo_source] ?? row.geo_source}
          </span>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-brand-700 hover:underline"
          >
            Ver mapa ↗
          </a>
        )}
        {canEdit && !editing && (
          <button onClick={open} className="ml-auto text-xs text-slate-500 hover:underline">
            {hasOverride ? "Editar corrección" : "Corregir ubicación"}
          </button>
        )}
      </div>

      {message && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{message}</p>}

      {!editing ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Field label="Región" value={row.region} />
          <Field label="Provincia" value={row.province} />
          <Field label="Distrito" value={row.district} />
          <Field label="Dirección" value={row.address} />
          <Field label="Referencia" value={row.reference} />
          <Field
            label="Coordenadas"
            value={
              row.latitude != null && row.longitude != null
                ? `${row.latitude}, ${row.longitude}`
                : null
            }
          />
        </dl>
      ) : (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500">
            Deja en blanco lo que no quieras cambiar. Esta corrección gana sobre Shopify, sobre los
            reportes de los couriers y sobre el ubigeo, y no se pierde al sincronizar.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <LabeledInput label="Región" value={form.region} onChange={(region) => set({ region })} />
            <LabeledInput
              label="Provincia"
              value={form.province}
              onChange={(province) => set({ province })}
            />
            <LabeledInput
              label="Distrito"
              value={form.district}
              onChange={(district) => set({ district })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput
              label="Dirección"
              value={form.address}
              onChange={(address) => set({ address })}
            />
            <LabeledInput
              label="Referencia"
              value={form.reference}
              onChange={(reference) => set({ reference })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput
              label="Latitud"
              value={form.latitude}
              placeholder="-12.0464"
              onChange={(latitude) => set({ latitude })}
            />
            <LabeledInput
              label="Longitud"
              value={form.longitude}
              placeholder="-77.0428"
              onChange={(longitude) => set({ longitude })}
            />
          </div>
          <LabeledInput
            label="Motivo / nota"
            value={form.note}
            onChange={(note) => set({ note })}
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Recordar esta provincia para los próximos pedidos del mismo distrito
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={pending}
              onClick={save}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Guardar ubicación
            </button>
            <button
              disabled={pending}
              onClick={() => setEditing(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            {hasOverride && (
              <button
                disabled={pending}
                onClick={clear}
                className="ml-auto text-xs text-slate-500 hover:underline"
              >
                Quitar corrección y volver al origen
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string | number | null | undefined;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value || "—"}</dd>
    </div>
  );
}

function OrderActions({
  row,
  canOverride,
  pending,
  onStatus,
  onComment,
  onReturn,
  onRelink,
}: {
  row: OrderMasterRow;
  canOverride: boolean;
  pending: boolean;
  onStatus: (general: string, operational: string, reason: string) => void;
  onComment: (text: string, type: string) => void;
  onReturn: (reason: string, guideCode: string) => void;
  onRelink: (guideCode: string) => void;
}) {
  const [general, setGeneral] = useState<GeneralStatus>(
    isGeneralStatus(row.general_status) ? row.general_status : "pendiente",
  );
  const [operational, setOperational] = useState(row.operational_status);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [commentType, setCommentType] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnGuide, setReturnGuide] = useState(row.guide_code ?? "");
  const [relinkCode, setRelinkCode] = useState("");

  const options = operationalStatusesFor(general);
  const closed = ["entregado", "anulado", "devuelto"].includes(row.general_status);
  const changingClosed = closed && general !== row.general_status;

  useEffect(() => {
    // Al cambiar el estado general, el operativo elegido puede dejar de aplicar.
    if (!options.some((o) => o.code === operational)) {
      setOperational(options[0]?.code ?? "");
    }
  }, [general, options, operational]);

  return (
    <section className="space-y-4 border-t border-slate-200 pt-4">
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Registrar estado
        </h3>
        <div className="flex flex-wrap gap-2">
          <select
            value={general}
            onChange={(e) => setGeneral(e.target.value as GeneralStatus)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            {GENERAL_STATUSES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={operational}
            onChange={(e) => setOperational(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            {options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {changingClosed && (
          <p className="text-xs text-amber-700">
            Este pedido ya está {generalLabel(row.general_status).toLowerCase()}. Cambiarlo exige un
            motivo y queda registrado en el historial
            {!canOverride && "; tu rol no lo permite"}.
          </p>
        )}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={changingClosed ? "Motivo (obligatorio)" : "Motivo u observación (opcional)"}
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <button
          disabled={pending || (changingClosed && (!canOverride || !reason.trim()))}
          onClick={() => onStatus(general, operational, reason)}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
        >
          Guardar estado
        </button>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Comentario</h3>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Cliente no responde, dirección incorrecta, pendiente de reasignación…"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <div className="flex gap-2">
          <input
            value={commentType}
            onChange={(e) => setCommentType(e.target.value)}
            placeholder="Tipo (opcional)"
            className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
          <button
            disabled={pending || !comment.trim()}
            onClick={() => {
              onComment(comment, commentType);
              setComment("");
              setCommentType("");
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            Añadir comentario
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Registrar devolución
        </h3>
        <p className="text-xs text-slate-400">
          Solo se marca como devuelto si consta el despacho y la guía; si no, queda como retorno en
          curso.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={returnGuide}
            onChange={(e) => setReturnGuide(e.target.value)}
            placeholder="Guía"
            className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
          <input
            value={returnReason}
            onChange={(e) => setReturnReason(e.target.value)}
            placeholder="Motivo de la devolución"
            className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
          <button
            disabled={pending || !returnReason.trim()}
            onClick={() => onReturn(returnReason, returnGuide)}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-white disabled:text-slate-400"
          >
            Registrar
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Corregir vínculo de guía
        </h3>
        <div className="flex gap-2">
          <input
            value={relinkCode}
            onChange={(e) => setRelinkCode(e.target.value)}
            placeholder="Código de guía a vincular a este pedido"
            className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
          <button
            disabled={pending || !relinkCode.trim()}
            onClick={() => {
              onRelink(relinkCode);
              setRelinkCode("");
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            Vincular
          </button>
        </div>
      </div>
    </section>
  );
}
