"use client";

// Piezas compartidas entre el Master de Pedidos y la ficha del pedido
// (order-drawer.tsx): formato de fechas y dinero, chapas de estado y botones
// de anular salidas. Viven aparte para que la ficha pueda montarse en
// cualquier pantalla sin arrastrar la tabla del Master.
//
// FILTRA LA BASE, NO ESTA PANTALLA. Antes se bajaban las ~10.000 filas al
// navegador y se filtraban en memoria: 13 MB por carga, otra vez enteras en cada
// cambio de pestaña, y unos diez segundos mirando el esqueleto. Ahora llega UNA
// página de 100 filas ya filtrada y ordenada (~100 KB).
//
// Los filtros viven en la URL, que es lo que permite que el servidor sepa qué
// traer. De ahí salen gratis dos cosas: una vista filtrada se puede compartir
// por enlace, y atrás/adelante del navegador funcionan.
//
// El coste, para que quede dicho: cada clic en un filtro es un viaje al
// servidor en vez de ser instantáneo. Se disimula con `useTransition`, que
// mantiene el listado anterior en pantalla mientras llega el nuevo en vez de
// parpadear a vacío.

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, cn, EmptyState, STICKY_HEAD, TABLE_LAYER, TABLE_WRAP_PAGE_X } from "@/components/ui";
import {
  frozenCellStyle,
  frozenOffsets,
  frozenTextWidth,
  type FrozenKey,
} from "@/lib/master-table-columns";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { CopyButton } from "@/components/copy-button";
import { AliclikCoverageProbe } from "@/components/aliclik-coverage-probe";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { ManualRouteOutputModal } from "@/components/manual-route-output-modal";
import { OrderClosureDesk } from "@/components/order-closure-desk";
import { OrderRouteDesk } from "@/components/order-route-desk";
import { ChecklistFilter } from "@/components/filters";
import { PickupKeyPanel, ShalomPickupKeyPanel } from "@/components/pickup-key-panel";
import { TandersGuideModal } from "@/components/tanders-guide-modal";
import { markTandersLabelGenerated } from "@/app/dashboard/pedidos/tanders-actions";
import { ShalomGuideModal } from "@/components/shalom-guide-modal";
import { cancelShalomGuide } from "@/app/dashboard/pedidos/shalom-actions";
import { shalomGuideIsCancelable } from "@/lib/shalom/draft";
import { fenixOutputIsCancelable, manualOutputIsCancelable } from "@/lib/shipment-output";
import {
  addOrderComment,
  cancelFenixOutput,
  cancelManualRouteOutput,
  clearOrderGeo,
  createManualRouteOutputsBulk,
  getOrderMasterChangeToken,
  loadOrderDetail,
  resolveLabelsForOrders,
  loadOrderGeo,
  applyOrderStatusBulk,
  loadConfirmationBrief,
  registerConfirmationAttempt,
  descartarRecuperacion,
  registerReturn,
  registerClosureAction,
  relinkGuide,
  setOrderStatus,
  setStoreConfirmationCycle,
  updateOrderGeo,
  type BulkRouteOutputFailure,
  type ManualRouteCourier,
  type MasterActionState,
  type OrderGeoInput,
} from "@/app/dashboard/pedidos/actions";
import { limaTodayKey } from "@/lib/shipments";
import { COURIER_TBD } from "@/lib/shipment-output";
import {
  AGENCY_COURIER_OPTIONS,
  needsAttestedAgencyShipment,
} from "@/lib/agency-attested-shipment";
import {
  agencyHasActivity,
  emptyFilters,
  hasActiveFilters,
  MANAGEMENT_DAY_STEPS,
  managementDayLabel,
  PAYMENT_CHECK_OPTIONS,
  type AgencySummary,
  type MasterFilters,
  type MasterSortKey,
} from "@/lib/order-master-filters";
import { buildMasterQuery } from "@/lib/master-query";
import { OrderLineItems } from "@/components/order-line-items";
import {
  ORDER_COVERAGE_LABEL,
  type OrderCoverage,
} from "@/lib/order-coverage";
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
import {
  MACRO_SUBSTAGES_BY_STAGE,
  macroStageLabel,
  macroSubstageLabel,
  type OrderMacroStage,
  type MacroSubstage,
} from "@/lib/order-macro-stage";
import { KEY_STATE_LABEL, PAYMENT_STATE_LABEL, type KeyState, type PaymentState } from "@/lib/pickup-key";
import { orderPaymentPanelPresentation } from "@/lib/order-payment-panel";
import { PAYMENT_GATEWAY_LABEL } from "@/lib/payment-gateway";
import {
  CONFIRMATION_CHANNELS,
  CONFIRMATION_MAX_DAYS,
  CONFIRMATION_RESULTS,
  confirmationChannelLabel,
  confirmationDays,
  confirmationDueBucket,
  confirmationResult,
  confirmationResultLabel,
  limaDayKey,
} from "@/lib/order-confirmation";
import {
  MASTER_VIEWS,
  type MasterCounts,
  type MasterView,
  type ConfirmationDueCounts,
  type OrderConfirmationBrief,
  type OrderMasterDetail,
  type TimelineEntry,
} from "@/lib/orders-master-access";
import {
  DISPATCH_STATE_LABEL,
  PAYMENT_REQUIREMENT_LABEL,
  PRIOR_OUTCOME_LABEL,
  countLaterOrders,
  dispatchState,
  priorCourier,
  priorOutcome,
  needsConfirmationBrief,
  priorTiming,
  sameProducts,
  type PaymentRequirement,
  type PriorOrderSnapshot,
  type PriorOutcome,
} from "@/lib/order-confirmation-brief";
import { outputDisplayCode } from "@/lib/shipment-output";
import { shopifyOrderAdminUrl } from "@/lib/shopify-urls";
import type { RouteCandidate } from "@/lib/order-route-plan";
import type { OrderMasterRow, StoreSummary } from "@/lib/types";

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function fmtDateTime(iso: string | null | undefined): string {
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
export function fmtAge(since: string | null): string {
  const days = daysInStatus(since);
  if (days === null) return "—";
  if (days === 0) return "hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}

export function fmtMoney(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `S/ ${value.toFixed(2)}`;
}

export const MODE_LABEL: Record<string, string> = {
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

const COVERAGE_TONE: Record<OrderCoverage, string> = {
  lima: "border-sky-200 bg-sky-50 text-sky-700",
  provincia_cod: "border-emerald-200 bg-emerald-50 text-emerald-700",
  agencia: "border-violet-200 bg-violet-50 text-violet-700",
  por_revisar: "border-amber-300 bg-amber-50 text-amber-800",
};

export function CoverageBadge({ coverage }: { coverage: OrderMasterRow["coverage"] }) {
  const value = coverage ?? "por_revisar";
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        COVERAGE_TONE[value],
      )}
    >
      {ORDER_COVERAGE_LABEL[value]}
    </span>
  );
}

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
export function ShalomCancelButton({
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

/**
 * Anular la guía de Swayp de una salida, también en dos pasos.
 *
 * El texto de confirmación cambia según lo que vaya a pasar, porque son dos
 * cosas distintas: si la salida era una «por definir» rellenada, la caja se
 * queda —sigue armada y rotulada— y solo deja de tener courier; si nació como
 * guía Swayp directa, la salida se anula. Prometer lo que no es haría que la
 * operadora dudara justo en el clic que no se deshace.
 */
export function FenixCancelButton({
  shipmentId,
  guideCode,
  wasFilled,
  onDone,
}: {
  shipmentId: string;
  guideCode: string | null;
  /** ¿La salida nació «por definir» y se le escribió la guía encima? */
  wasFilled: boolean;
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
          Anular guía Swayp
        </button>
        {error && <span className="w-full text-xs text-red-700">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-red-50 px-2 py-1.5">
      <span className="text-xs text-red-800">
        ¿Anular la guía <strong>{guideCode ?? "—"}</strong>?{" "}
        {wasFilled
          ? "La caja se queda como está y la salida vuelve a quedar sin courier, lista para otra guía."
          : "La salida queda anulada."}{" "}
        Solo si el paquete sigue en almacén.
      </span>
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          const res = await cancelFenixOutput(shipmentId);
          setBusy(false);
          setConfirming(false);
          if (res.error) setError(res.error);
          else onDone(res.notice ?? "Guía Swayp anulada.");
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

/**
 * Anular una salida de ruta manual, también en dos pasos.
 *
 * Es el botón que faltaba: el modal de Shalom decía "anúlala antes de crear
 * otra" y no había dónde. Una salida `por definir` creada por error dejaba el
 * pedido sin poder emitir ninguna guía ni finalizarse.
 *
 * No llama a ningún courier —estas salidas no tienen API— así que el texto de
 * confirmación habla de la caja, que es lo que la operadora tiene delante: si el
 * paquete ya salió, el camino es el retorno y no esto.
 */
export function ManualOutputCancelButton({
  shipmentId,
  label,
  onDone,
}: {
  shipmentId: string;
  label: string;
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
          Anular salida
        </button>
        {error && <span className="w-full text-xs text-red-700">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-red-50 px-2 py-1.5">
      <span className="text-xs text-red-800">
        ¿Anular <strong>{label}</strong>? Solo si la caja sigue en almacén; si ya salió con el
        motorizado, registra su retorno.
      </span>
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          const res = await cancelManualRouteOutput(shipmentId);
          setBusy(false);
          setConfirming(false);
          if (res.error) setError(res.error);
          else onDone(res.notice ?? `${label} anulada.`);
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

export function StatusBadge({ status, locked }: { status: string; locked?: boolean }) {
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

const MACRO_STAGE_TONE: Record<string, string> = {
  por_confirmar: "bg-amber-50 text-amber-800 ring-amber-600/20",
  preparacion: "bg-sky-50 text-sky-800 ring-sky-600/20",
  por_despachar: "bg-indigo-50 text-indigo-800 ring-indigo-600/20",
  en_curso: "bg-cyan-50 text-cyan-800 ring-cyan-600/20",
  por_cerrar: "bg-orange-50 text-orange-800 ring-orange-600/20",
  finalizado: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
};

export function MacroStageBadge({ stage }: { stage: string | null | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
        MACRO_STAGE_TONE[stage ?? ""] ?? "bg-slate-100 text-slate-700 ring-slate-500/20",
      )}
    >
      {macroStageLabel(stage)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------


/**
 * Indicador de cobro y clave (§"Información visible en el Master"). La clave EN
 * SÍ nunca aparece en la tabla: solo su estado.
 */
export function PaymentIndicator({
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
export function AgencyDays({
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

export const TIMELINE_LABEL: Record<string, string> = {
  created: "Pedido creado",
  confirmed: "Pedido confirmado",
  cancelled_shopify: "Anulado en Shopify",
  courier_assigned: "Courier asignado",
  guide_registered: "Guía registrada",
  route_output_created: "Salida y rótulo creados",
  route_output_cancelled: "Salida anulada",
  route_output_filled: "Courier decidido sobre la salida",
  dispatched: "Pedido despachado",
  out_for_delivery: "Salida a reparto",
  attempt_failed: "Intento fallido",
  novelty_solved: "Novedad de Swayp resuelta",
  comment: "Comentario",
  confirmation_contact: "Intento de confirmación",
  confirmation_followup: "Próximo contacto pactado",
  reschedule: "Reprogramación",
  reroute: "Reprogramación",
  courier_change: "Cambio de courier",
  delivered: "Entrega confirmada",
  return_started: "Retorno iniciado",
  return_requested: "Retorno solicitado",
  return_received: "Devolución recibida en almacén",
  returned: "Pedido devuelto",
  inventory_reconciled: "Producto reingresado a inventario",
  merma_closed: "Merma cerrada",
  liquidation_observed: "Liquidación observada",
  liquidation_closed: "Liquidación conciliada",
  indemnity_requested: "Indemnización solicitada",
  indemnity_resolved: "Indemnización resuelta",
  refund_requested: "Reembolso solicitado",
  refund_completed: "Reembolso confirmado",
  customer_return_started: "Devolución del cliente abierta",
  customer_return_resolved: "Devolución del cliente resuelta",
  order_finalized: "Expediente finalizado",
  order_reopened: "Expediente reabierto",
  status_override: "Estado cambiado manualmente",
  // Camino del pedido en Grupo GF Courier (MOM §29.13): lo que escriben la
  // bandeja, la mesa de despacho, el teléfono del motorizado y Liquidaciones 2.
  logistics_request_accepted: "Tomado por Grupo GF Courier",
  dispatch_route_assigned: "Asignado a la caja del motorizado",
  dispatch_route_reassigned: "Movido a la caja de otro motorizado",
  package_ready: "Paquete armado en almacén",
  package_added: "Paquete puesto en una caja",
  package_removed: "Paquete retirado de la caja",
  office_checked: "Cotejado en oficina",
  pickup_checked: "Lo lleva el motorizado",
  pickup_declined: "No lo llevó el motorizado",
  delivered_unconfirmed_pickup: "Entregado sin confirmar recojo",
  handed_to_courier: "Entregado al courier",
  custody_transferred: "Custodia entregada al motorizado",
  manifest_created: "Caja abierta",
  manifest_cancelled: "Caja cancelada",
  import: "Reporte importado",
  call: "Gestión con el cliente",
  state_change: "Cambio de estado",
  note: "Nota",
  system: "Automático",
  // Cola de Leads (lo de ANTES del pedido). Llevan prefijo porque `note`,
  // `call` y `system` ya existen arriba con otro significado, y sin él una
  // gestión de Repro Provincia y una llamada de la asesora se leerían igual.
  lead_sale: "Venta cerrada por la asesora",
  lead_call: "Llamada al cliente (Leads)",
  lead_state_change: "Cambio de estado del lead",
  lead_note: "Nota de la asesora",
  lead_system: "Automático (Leads)",
};
