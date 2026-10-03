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
import { IconLock } from "@/components/icons";
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

// El estado comercial en chapa de 4 px y par de tono (DESIGN.md): en curso es
// información, entregado es correcto, devuelto es crítico; pendiente y anulado,
// neutros.
const STATUS_TONE: Record<string, string> = {
  pendiente: "bg-line text-ink-600",
  en_proceso: "bg-info-bg text-info-fg",
  entregado: "bg-ok-bg text-ok-fg",
  anulado: "bg-line text-ink-600",
  devuelto: "bg-crit-bg text-crit-fg",
};

// Chapa de 4 px del mundo de operación. La cobertura se lee por su texto; solo
// «Por revisar» lleva color, porque es la única que pide que alguien actúe.
const COVERAGE_TONE: Record<OrderCoverage, string> = {
  lima: "bg-line text-ink-600",
  provincia_cod: "bg-line text-ink-600",
  agencia: "bg-line text-ink-600",
  por_revisar: "bg-warn-bg text-warn-fg",
};

export function CoverageBadge({ coverage }: { coverage: OrderMasterRow["coverage"] }) {
  const value = coverage ?? "por_revisar";
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-xs font-medium leading-none",
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

  if (busy) return <span className="text-[13px] text-ink-500">Anulando…</span>;

  if (!confirming) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="inline-flex items-center text-[13px] font-medium text-crit-fg underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          Anular
        </button>
        {error && <span role="alert" className="w-full text-[13px] text-crit-fg">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-crit-wash px-3 py-2">
      <span className="text-[13px] leading-5 text-ink-700">
        ¿Anular la guía <strong className="font-semibold text-ink-900">{guideCode ?? "—"}</strong>
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
        className="inline-flex h-8 items-center rounded-md bg-white px-2.5 text-[13px] font-semibold text-crit-fg shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-crit-wash pointer-coarse:h-11"
      >
        Sí, anular
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-semibold text-ink-600 transition-colors hover:bg-white/70 hover:text-ink-900 pointer-coarse:h-11"
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

  if (busy) return <span className="text-[13px] text-ink-500">Anulando…</span>;

  if (!confirming) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="inline-flex items-center text-[13px] font-medium text-crit-fg underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          Anular guía Swayp
        </button>
        {error && <span role="alert" className="w-full text-[13px] text-crit-fg">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-crit-wash px-3 py-2">
      <span className="text-[13px] leading-5 text-ink-700">
        ¿Anular la guía <strong className="font-semibold text-ink-900">{guideCode ?? "—"}</strong>?{" "}
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
        className="inline-flex h-8 items-center rounded-md bg-white px-2.5 text-[13px] font-semibold text-crit-fg shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-crit-wash pointer-coarse:h-11"
      >
        Sí, anular
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-semibold text-ink-600 transition-colors hover:bg-white/70 hover:text-ink-900 pointer-coarse:h-11"
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

  if (busy) return <span className="text-[13px] text-ink-500">Anulando…</span>;

  if (!confirming) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="inline-flex items-center text-[13px] font-medium text-crit-fg underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          Anular salida
        </button>
        {error && <span role="alert" className="w-full text-[13px] text-crit-fg">{error}</span>}
      </>
    );
  }

  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-crit-wash px-3 py-2">
      <span className="text-[13px] leading-5 text-ink-700">
        ¿Anular <strong className="font-semibold text-ink-900">{label}</strong>? Solo si la caja sigue en almacén; si ya salió con el
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
        className="inline-flex h-8 items-center rounded-md bg-white px-2.5 text-[13px] font-semibold text-crit-fg shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-crit-wash pointer-coarse:h-11"
      >
        Sí, anular
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-semibold text-ink-600 transition-colors hover:bg-white/70 hover:text-ink-900 pointer-coarse:h-11"
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
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-xs font-medium leading-none",
        STATUS_TONE[status] ?? "bg-line text-ink-600",
      )}
      title={locked ? "Estado fijado manualmente: el recálculo automático no lo pisa" : undefined}
    >
      {generalLabel(status)}
      {locked && (
        <>
          <IconLock aria-hidden className="size-3" strokeWidth={2.2} />
          <span className="sr-only">(fijado a mano)</span>
        </>
      )}
    </span>
  );
}

// Los tonos de macroetapa son regla del MOM (§25): ámbar para confirmación,
// celeste para preparación, índigo para despacho, cian para seguimiento,
// naranja para cierre, verde para completado y gris para consulta. Son la única
// excepción a la paleta de estados del mundo de operación (DESIGN.md), y van en
// chapa de 4 px como el resto.
const MACRO_STAGE_TONE: Record<string, string> = {
  por_confirmar: "bg-amber-100 text-amber-800",
  preparacion: "bg-sky-100 text-sky-800",
  por_despachar: "bg-indigo-100 text-indigo-800",
  en_curso: "bg-cyan-100 text-cyan-800",
  por_cerrar: "bg-orange-100 text-orange-800",
  finalizado: "bg-emerald-100 text-emerald-800",
};

const MACRO_STAGE_DOT: Record<string, string> = {
  por_confirmar: "bg-amber-500",
  preparacion: "bg-sky-500",
  por_despachar: "bg-indigo-500",
  en_curso: "bg-cyan-500",
  por_cerrar: "bg-orange-500",
  finalizado: "bg-emerald-500",
};

export function MacroStageBadge({ stage }: { stage: string | null | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-xs font-medium leading-none",
        MACRO_STAGE_TONE[stage ?? ""] ?? "bg-line text-ink-600",
      )}
    >
      {macroStageLabel(stage)}
    </span>
  );
}

/** El tono de la macroetapa en un cuadro de 8 px: la leyenda de las chapas. */
export function MacroStageDot({ stage }: { stage: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", MACRO_STAGE_DOT[stage] ?? "bg-ink-300")} />;
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
    <span className={cn(alert && "font-semibold text-crit-fg")} title={key ?? undefined}>
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
      className={cn("tabular-nums", soon && "font-semibold text-warn-fg")}
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
  guide_created: "Guía creada",
  guide_cancelled: "Guía anulada",
  aliclik_duplicate_resolution: "Resolución de posible duplicado Aliclik",
  route_output_created: "Salida y rótulo creados",
  route_output_cancelled: "Salida anulada",
  olva_tracking_linked: "Tracking de Olva registrado",
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
  logistics_request_rescheduled: "Salida prevista movida al día de la caja",
  dispatch_programmed: "Salida programada",
  dispatch_program_cleared: "Salida programada quitada",
  dispatch_program_overridden: "Salió otro día que el programado",
  dispatch_route_assigned: "Asignado a la caja del motorizado",
  dispatch_route_reassigned: "Movido a la caja de otro motorizado",
  package_ready: "Paquete armado en almacén",
  package_added: "Paquete puesto en una caja",
  package_removed: "Paquete retirado de la caja",
  office_checked: "Cotejado en oficina",
  pickup_checked: "Lo lleva el motorizado",
  pickup_declined: "No lo llevó el motorizado",
  returned_to_office: "No entregado: recibido en oficina",
  stop_reported: "Reporte del motorizado",
  route_reopened: "Ruta reabierta",
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
