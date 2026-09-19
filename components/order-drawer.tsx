"use client";

// La ficha del pedido: el drawer con Operar, Información y Actividad. Antes
// vivía dentro de orders-master.tsx y solo se abría desde el Master; ahora es
// un componente propio para que cualquier pantalla del panel lo monte
// (components/order-drawer-host.tsx, MOM §25). Carga su propio detalle con
// loadOrderDetail, así que solo necesita el id del pedido y los permisos.
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

import {
  AgencyDays,
  CoverageBadge,
  FenixCancelButton,
  MacroStageBadge,
  ManualOutputCancelButton,
  MODE_LABEL,
  PaymentIndicator,
  ShalomCancelButton,
  StatusBadge,
  TIMELINE_LABEL,
  fmtAge,
  fmtDate,
  fmtDateTime,
  fmtMoney,
} from "@/components/order-master-shared";

type DrawerSectionId =
  | "resumen"
  | "confirmacion"
  | "ubicacion"
  | "productos"
  | "pagos"
  | "rutas"
  | "aliclik"
  | "guias"
  | "cierre"
  | "acciones"
  | "historial";

export type DrawerWorkspaceView = "operar" | "informacion" | "actividad";

interface DrawerNextAction {
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  target?: DrawerSectionId;
  href?: string;
  tone: "indigo" | "amber" | "emerald" | "slate";
}

const DRAWER_STAGE_ORDER = MASTER_VIEWS.filter(
  (view): view is { key: OrderMacroStage; label: string } => view.key !== "todos",
);

const DRAWER_STAGE_ACCENT: Record<string, string> = {
  por_confirmar: "border-amber-500 bg-amber-500 text-white",
  preparacion: "border-sky-600 bg-sky-600 text-white",
  por_despachar: "border-indigo-600 bg-indigo-600 text-white",
  en_curso: "border-cyan-700 bg-cyan-700 text-white",
  por_cerrar: "border-orange-600 bg-orange-600 text-white",
  finalizado: "border-emerald-700 bg-emerald-700 text-white",
};

function workspaceForSection(section: DrawerSectionId): DrawerWorkspaceView {
  if (section === "ubicacion" || section === "productos") return "informacion";
  if (section === "historial") return "actividad";
  return "operar";
}

const NEXT_ACTION_TONE: Record<DrawerNextAction["tone"], string> = {
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-950",
  amber: "border-amber-200 bg-amber-50 text-amber-950",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
  slate: "border-slate-200 bg-slate-50 text-slate-950",
};

/**
 * La acción dominante del drawer sigue el MOM, no el orden accidental de los
 * formularios. Debe responder una sola pregunta: «¿qué hago ahora con este
 * pedido?». Las herramientas secundarias quedan más abajo como evidencia o
 * corrección.
 */
function drawerNextAction(row: OrderMasterRow, showPayments: boolean): DrawerNextAction {
  const stage = row.macro_stage as OrderMacroStage | null | undefined;
  const substage = row.macro_substage as MacroSubstage | null | undefined;

  if (stage === "por_confirmar") {
    // El abono pendiente ya no es una subetapa sino un motivo: manda sobre la
    // llamada porque sin él la confirmación no vale, pero deja al pedido
    // visible en la subetapa que de verdad describe su gestión.
    if ((row.macro_reasons ?? []).includes("pago_requerido_pendiente") && showPayments) {
      return {
        eyebrow: "Confirmación · pago requerido",
        title: "Validar el pago solicitado",
        description: "Registra y valida el comprobante antes de liberar la preparación del pedido.",
        cta: "Ir a pagos",
        target: "pagos",
        tone: "amber",
      };
    }
    if (substage === "ultimo_intento") {
      return {
        eyebrow: "Confirmación · último intento",
        title: "Se agotaron los siete días de gestión",
        description:
          "Resuelve el pedido: si no hay confirmación, la anulación se crea a mano en Shopify. Kapta nunca anula por su cuenta.",
        cta: "Ver la gestión",
        target: "confirmacion",
        tone: "amber",
      };
    }
    return {
      eyebrow: "Confirmación",
      title:
        substage === "volver_a_contactar"
          ? "Retomar el contacto pactado"
          : "Contactar y registrar el intento",
      description: "Llama o escribe al cliente y deja el resultado en la gestión de confirmación.",
      cta: "Registrar intento",
      target: "confirmacion",
      tone: "indigo",
    };
  }

  if (stage === "preparacion") {
    if (substage === "incidencia_preparacion") {
      return {
        eyebrow: "Preparación · incidencia",
        title: "Resolver el bloqueo de almacén",
        description: "Corrige el dato o documenta la incidencia antes de volver a imprimir y armar.",
        cta: "Registrar resolución",
        target: "acciones",
        tone: "amber",
      };
    }
    return {
      eyebrow: "Preparación",
      title: substage === "por_armar" ? "Completar el armado y escanear el rótulo" : "Elegir ruta y generar el rótulo",
      description:
        substage === "por_armar"
          ? "El paquete debe quedar completo y listo antes de incorporarlo a una ruta."
          : "La ruta define qué rótulo se genera y qué validaciones debe cumplir el pedido.",
      cta: substage === "por_armar" ? "Ir al Almacén" : "Revisar rutas",
      ...(substage === "por_armar"
        ? { href: "/dashboard/pedidos/almacen" }
        : { target: "rutas" as const }),
      tone: "indigo",
    };
  }

  if (stage === "por_despachar") {
    return {
      eyebrow: "Despacho",
      title: "Cotejar la ruta y transferir la custodia",
      description: "Oficina y motorizado deben escanear el 100 % de los paquetes antes de salir.",
      cta: "Abrir Mesa de despacho",
      href: "/dashboard/pedidos/despacho",
      tone: "indigo",
    };
  }

  if (stage === "en_curso") {
    if (substage === "pendiente_pago_diferencia" && showPayments) {
      return {
        eyebrow: "Agencia · pago pendiente",
        title: "Completar el pago antes de liberar la clave",
        description: "La clave de recojo permanece bloqueada hasta validar el monto total acumulado.",
        cta: "Revisar pagos",
        target: "pagos",
        tone: "amber",
      };
    }
    if (substage === "gestion_reproprovincia") {
      return {
        eyebrow: "Reproprovincia",
        title: "Contactar y decidir el reenvío",
        description:
          "Aliclik no entregó y el paquete ya salió. Registra el contacto y reenvía por Swayp desde el stock de su ciudad; si no hay, Shalom u Olva con adelanto. Si no hay reenvío posible, descarta con motivo.",
        cta: "Registrar contacto",
        target: "confirmacion",
        tone: "amber",
      };
    }
    if (substage === "por_reprogramar_lima") {
      return {
        eyebrow: "Seguimiento",
        title: "Volver a confirmar con el cliente",
        description: "Registra el contacto antes de crear una salida nueva con su propio QR.",
        cta: "Registrar seguimiento",
        target: "acciones",
        tone: "amber",
      };
    }
    return {
      eyebrow: "Seguimiento",
      title: "Revisar la salida activa",
      description: "Confirma el último estado del courier y atiende cualquier intento o retorno pendiente.",
      cta: "Ver salidas y guías",
      target: "guias",
      tone: "emerald",
    };
  }

  if (stage === "por_cerrar") {
    return {
      eyebrow: "Cierre",
      title: "Resolver las obligaciones abiertas",
      description: "Liquidación, devolución, inventario y reembolso se cierran como hechos independientes.",
      cta: "Abrir Mesa de cierre",
      target: "cierre",
      tone: "amber",
    };
  }

  return {
    eyebrow: "Expediente finalizado",
    title: "Pedido cerrado sin acciones pendientes",
    description: "Consulta la trazabilidad completa o reabre únicamente si aparece una incidencia nueva.",
    cta: "Ver historial",
    target: "historial",
    tone: "slate",
  };
}

function DrawerJourneyRail({ current }: { current: string | null | undefined }) {
  const currentIndex = DRAWER_STAGE_ORDER.findIndex((stage) => stage.key === current);
  return (
    <ol className="grid grid-cols-6" aria-label="Avance del pedido en el MOM">
      {DRAWER_STAGE_ORDER.map((stage, index) => {
        const isCurrent = index === currentIndex;
        const isDone = currentIndex >= 0 && index < currentIndex;
        return (
          <li key={stage.key} className="relative min-w-0 px-1 first:pl-0 last:pr-0">
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 right-1/2 top-3 h-px -translate-y-1/2",
                  isDone || isCurrent ? "bg-emerald-300" : "bg-slate-200",
                )}
              />
            )}
            {index < DRAWER_STAGE_ORDER.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-1/2 right-0 top-3 h-px -translate-y-1/2",
                  isDone ? "bg-emerald-300" : "bg-slate-200",
                )}
              />
            )}
            <div className="relative flex min-w-0 flex-col items-center text-center" aria-current={isCurrent ? "step" : undefined}>
              <span
                className={cn(
                  "relative z-[1] grid h-6 w-6 place-items-center rounded-full border text-[10px] font-bold tabular-nums",
                  isCurrent && (DRAWER_STAGE_ACCENT[stage.key] ?? "border-slate-700 bg-slate-700 text-white"),
                  isDone && "border-emerald-500 bg-emerald-500 text-white",
                  !isCurrent && !isDone && "border-slate-200 bg-white text-slate-400",
                )}
              >
                {isDone ? "✓" : index + 1}
              </span>
              <span
                className={cn(
                  "mt-1.5 max-w-[6.5rem] text-[10px] font-semibold leading-tight",
                  isCurrent ? "text-slate-900" : isDone ? "text-emerald-700" : "text-slate-400",
                )}
              >
                {stage.label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DrawerNextActionCard({
  action,
  onJump,
}: {
  action: DrawerNextAction;
  onJump: (target: DrawerSectionId) => void;
}) {
  const buttonClass = cn(
    "inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-2 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-offset-2",
    action.tone === "indigo" && "bg-indigo-700 text-white hover:bg-indigo-800 focus:ring-indigo-600",
    action.tone === "amber" && "bg-amber-800 text-white hover:bg-amber-900 focus:ring-amber-700",
    action.tone === "emerald" && "bg-emerald-800 text-white hover:bg-emerald-900 focus:ring-emerald-700",
    action.tone === "slate" && "bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-700",
  );

  return (
    <section className={cn("rounded-xl border p-4", NEXT_ACTION_TONE[action.tone])}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] opacity-65">
            Próxima acción · {action.eyebrow}
          </p>
          <h3 className="mt-1 text-base font-semibold leading-tight">{action.title}</h3>
          <p className="mt-1 max-w-xl text-sm leading-5 opacity-75">{action.description}</p>
        </div>
        {action.href ? (
          <Link href={action.href} className={cn(buttonClass, "shrink-0")}>
            {action.cta} →
          </Link>
        ) : action.target ? (
          <button
            type="button"
            onClick={() => onJump(action.target!)}
            className={cn(buttonClass, "shrink-0")}
          >
            {action.cta} ↓
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function OrderDrawer({
  orderId,
  canEdit,
  canOverride,
  canCreateGuide,
  canCreateTandersGuide,
  canCreateShalomGuide,
  closurePermissions,
  storeName,
  storeDomain,
  onClose,
  onSaved,
  initialWorkspace,
  masterHref,
}: {
  orderId: string;
  canEdit: boolean;
  canOverride: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
  closurePermissions: {
    canReturn: boolean;
    canInventory: boolean;
    canFinance: boolean;
    canFinalize: boolean;
    canRefund: boolean;
    canReopen: boolean;
  };
  storeName: (id: string) => string;
  storeDomain: (id: string) => string | null;
  onClose: () => void;
  onSaved: () => void;
  /** Con qué pestaña abre: «Ver actividad» desde Despacho o Courier pide «actividad». */
  initialWorkspace?: DrawerWorkspaceView;
  /**
   * Cuando la ficha está montada fuera del Master (order-drawer-host.tsx), el
   * enlace para ir al Master con este mismo pedido abierto: ahí están la tabla,
   * los filtros y las acciones en lote que la ficha sola no trae.
   */
  masterHref?: string | null;
}) {
  const [detail, setDetail] = useState<OrderMasterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<DrawerWorkspaceView>(initialWorkspace ?? "operar");
  const scrollRef = useRef<HTMLElement>(null);

  /**
   * Cambia primero al espacio que contiene la herramienta y después la enfoca.
   * Antes todos los formularios vivían en una sola columna y los atajos solo
   * desplazaban cientos de píxeles: técnicamente funcionaba, pero el equipo no
   * sabía en qué "modo" del pedido estaba trabajando.
   */
  const jumpTo = (id: DrawerSectionId) => {
    setWorkspace(workspaceForSection(id));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector(`[data-drawer-section="${id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  };

  function openWorkspace(next: DrawerWorkspaceView) {
    setWorkspace(next);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // Escape cierra, y el fondo deja de scrollear mientras el panel está abierto:
  // sin esto, rodar dentro del drawer arrastraba el listado de atrás y al cerrar
  // habías perdido tu sitio en la tabla.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  const [notice, setNotice] = useState<string | null>(null);
  const [tandersOpen, setTandersOpen] = useState(false);
  const [shalomOpen, setShalomOpen] = useState(false);
  const [swaypOpen, setSwaypOpen] = useState(false);
  const [manualRoute, setManualRoute] = useState<RouteCandidate | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = useMemo(
    () => async () => {
      try {
        const res = await loadOrderDetail(orderId);
        if ("error" in res) setError(res.error);
        else {
          setDetail(res.detail);
          setError(null);
        }
      } catch {
        // Una acción de servidor que revienta dejaba la promesa rechazada y el
        // drawer con el esqueleto latiendo para siempre, sin decir nada.
        setError("No se pudo cargar el pedido. Reintenta en unos segundos.");
      }
    },
    [orderId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Al cambiar de pedido la ficha vuelve a la pestaña pedida (o a Operar).
  // Antes ponía «operar» a secas y pisaba `initialWorkspace` nada más montar:
  // «Ver actividad» abría la ficha… en Operar.
  useEffect(() => {
    setWorkspace(initialWorkspace ?? "operar");
    scrollRef.current?.scrollTo({ top: 0 });
  }, [orderId, initialWorkspace]);

  function run(action: () => Promise<{ error?: string; notice?: string }>): Promise<boolean> {
    return new Promise((resolve) => {
      startTransition(async () => {
        try {
          const res = await action();
          setError(res.error ?? null);
          setNotice(res.notice ?? null);
          if (!res.error) {
            await reload();
            onSaved();
            resolve(true);
            return;
          }
          resolve(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "No se pudo completar la acción.");
          setNotice(null);
          resolve(false);
        }
      });
    });
  }

  function routeEnabled(route: RouteCandidate): boolean {
    if (route.action === "aliclik") return canCreateGuide;
    if (route.action === "shalom") return canCreateShalomGuide;
    if (route.action === "tanders") return canCreateTandersGuide;
    return canEdit;
  }

  function selectRoute(route: RouteCandidate) {
    if (route.key === "propio") {
      window.location.assign(`/dashboard/courier?pedido=${encodeURIComponent(orderId)}`);
      return;
    }
    if (route.action === "aliclik") {
      jumpTo("aliclik");
      return;
    }
    if (route.action === "shalom") {
      setShalomOpen(true);
      return;
    }
    if (route.action === "tanders") {
      setTandersOpen(true);
      return;
    }
    if (route.action === "swayp") {
      setSwaypOpen(true);
      return;
    }
    setManualRoute(route);
  }

  const row = detail?.row;
  const shopifyUrl = row
    ? shopifyOrderAdminUrl(storeDomain(row.store_id), row.shopify_order_id)
    : null;

  // El plan de rutas es quien sabe si Aliclik atiende a este pedido. Se lee de
  // ahí, no se vuelve a decidir: una segunda regla equivalente es una regla que
  // tarde o temprano deja de coincidir con la primera. `blocked` también cuenta:
  // si la ruta está frenada (por ejemplo, tope de salidas), crear la guía por el
  // panel sería saltarse el mismo límite por la puerta de atrás.
  const aliclikOffered = Boolean(
    detail?.routePlan.candidates.some(
      (candidate) => candidate.action === "aliclik" && candidate.availability !== "blocked",
    ),
  );

  // La ficha del §8 se carga aparte del detalle —recorre el historial del
  // teléfono y la matriz de tarifas— así que no se pide en cada apertura: sobre
  // un pedido ya entregado no cambia ninguna decisión.
  //
  // PERO NO SOLO EN CONFIRMACIÓN. La regla de riesgo se APLICA al crear la guía,
  // que ocurre en Preparación, después de confirmar. Cargando la ficha solo en
  // confirmación, el panel de Aliclik recibía `riskRequirement: "ninguno"` y no
  // dibujaba el campo de justificación, mientras `createAliclikGuide` —que sí se
  // trae la ficha él mismo— rechazaba la creación pidiendo esa justificación por
  // escrito. La regla se aplicaba donde la salida no existía: el pedido quedaba
  // sin forma de avanzar (#KP128958, Juliaca, 17-08-2026).
  const inConfirmation = detail?.row.macro_stage === "por_confirmar";
  const wantsBrief = needsConfirmationBrief(detail?.row.macro_stage, aliclikOffered);
  const [brief, setBrief] = useState<OrderConfirmationBrief | null>(null);
  useEffect(() => {
    if (!wantsBrief) {
      setBrief(null);
      return;
    }
    let alive = true;
    void loadConfirmationBrief(orderId).then((res) => {
      if (alive && "brief" in res) setBrief(res.brief);
    });
    return () => {
      alive = false;
    };
  }, [orderId, wantsBrief]);
  const paymentPanel = detail
    ? orderPaymentPanelPresentation({
        operation: detail.routePlan.operation,
        currentCourier: detail.row.current_courier,
        shippingMode: detail.row.shipping_mode,
        macroSubstage: detail.row.macro_substage,
        macroReasons: detail.row.macro_reasons,
        riskRequirement: brief?.risk.requirement ?? null,
        paymentState: detail.row.payment_state,
        paymentFacts: {
          financialStatus: detail.row.financial_status,
          totalRefunded: detail.row.total_refunded,
          paymentGateway: detail.row.payment_gateway,
        },
        hasAgencyCandidate:
          canCreateShalomGuide &&
          detail.routePlan.candidates.some(
            (candidate) => candidate.key === "shalom" || candidate.key === "olva",
          ),
      })
    : null;
  // Shopify dice «pagado» pero no lo cobró el checkout: se explica por qué el
  // panel sigue pidiendo la constancia (lib/payment-gateway.ts).
  const gatewayNote =
    detail &&
    (detail.row.financial_status ?? "").toLowerCase() === "paid" &&
    (detail.row.payment_gateway === "manual" || detail.row.payment_gateway === "cod")
      ? `${PAYMENT_GATEWAY_LABEL[detail.row.payment_gateway]}: no lo cobró el checkout. Para darlo por pagado, sube la constancia.`
      : null;
  const showPaymentPanel = paymentPanel?.show ?? false;
  const nextAction = detail ? drawerNextAction(detail.row, showPaymentPanel) : null;

  return (
    <div
      className="fixed inset-0 z-30 flex justify-end bg-slate-900/40 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <aside
        ref={scrollRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Pedido ${row?.order_name ?? ""}`}
        className="h-full w-full max-w-[880px] overflow-y-auto bg-white shadow-2xl"
      >
        {/* La cabecera lleva lo que hay que tener SIEMPRE a la vista: qué pedido
            es, en qué estado está y cuánto vale. Antes había que subir hasta
            arriba para recordar el estado, y el monto quedaba enterrado entre
            los datos del cliente. */}
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-semibold text-slate-900">
                  {row?.order_name ?? "Pedido"}
                </p>
                {shopifyUrl && (
                  <a
                    href={shopifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir en Shopify"
                    aria-label={`Abrir ${row?.order_name ?? "pedido"} en Shopify (nueva pestaña)`}
                    className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M7 17 17 7" />
                      <path d="M8 7h9v9" />
                    </svg>
                  </a>
                )}
                {detail && (
                  <StatusBadge
                    status={detail.row.general_status}
                    locked={detail.row.status_locked}
                  />
                )}
                {detail && (
                  <span className="text-sm font-semibold text-slate-700">
                    {fmtMoney(detail.row.order_total)}
                  </span>
                )}
                {/* La cobertura decide TODO lo que sigue —si se confirma, quién
                    lo lleva, si hay que exigir pago— así que va en la cabecera
                    fija y no dentro de una pestaña: cualquier decisión que se
                    tome en Operar la necesita a la vista. */}
                {detail && <CoverageBadge coverage={detail.row.coverage} />}
              </div>
              {row && (
                // `flex` y no un solo <p>: el botón de copiar tiene que quedar
                // FUERA del texto que se recorta. Dentro de un `truncate`, un
                // nombre de cliente largo se lo lleva por delante y el teléfono
                // deja de poder copiarse justo en los pedidos donde más se
                // necesita.
                <div className="flex min-w-0 items-center gap-1 text-xs text-slate-500">
                  <span className="truncate">
                    {storeName(row.store_id)} · creado el {fmtDate(row.order_created_at)}
                    {detail?.row.customer_name ? ` · ${detail.row.customer_name}` : ""}
                  </span>
                  {detail?.row.customer_phone && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums whitespace-nowrap">
                        {detail.row.customer_phone}
                      </span>
                      <CopyButton value={detail.row.customer_phone} label="el teléfono" />
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {detail?.row.customer_phone && (
                <>
                  <a
                    href={`tel:${detail.row.customer_phone}`}
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    title="Llamar al cliente"
                  >
                    Llamar
                  </a>
                  <a
                    href={`https://wa.me/${detail.row.customer_phone.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    title="Abrir WhatsApp"
                  >
                    WhatsApp
                  </a>
                </>
              )}
              {masterHref && (
                <a
                  href={masterHref}
                  title="Abrir en Master de Pedidos"
                  aria-label={`Abrir ${row?.order_name ?? "el pedido"} en Master de Pedidos`}
                  className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M3 10h18M9 10v10" />
                  </svg>
                  <span className="hidden sm:inline">Master de Pedidos</span>
                </a>
              )}
              <button
                onClick={onClose}
                aria-label="Cerrar"
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Tres espacios estables, como en Shopify: hacer el trabajo, consultar
              el pedido y auditar lo ocurrido. El equipo deja de navegar una
              lista accidental de formularios. */}
          {detail && (
            <div className="flex items-center gap-5 px-5" role="tablist" aria-label="Espacios del pedido">
              {(
                [
                  { id: "operar", label: "Operar", meta: "Siguiente acción" },
                  { id: "informacion", label: "Información", meta: "Cliente y pedido" },
                  {
                    id: "actividad",
                    label: "Actividad",
                    meta: `${detail.timeline.length} movimiento${detail.timeline.length === 1 ? "" : "s"}`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={workspace === tab.id}
                  aria-controls={`pedido-panel-${tab.id}`}
                  onClick={() => openWorkspace(tab.id)}
                  className={cn(
                    "relative flex min-h-11 items-center gap-2 border-b-2 px-0.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                    workspace === tab.id
                      ? "border-brand-600 text-slate-950"
                      : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
                  )}
                >
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      "hidden rounded-full px-2 py-0.5 text-[10px] font-medium lg:inline",
                      workspace === tab.id ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-500",
                    )}
                  >
                    {tab.meta}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pegados bajo la cabecera: un error que se pierde al scrollear es un
            error que nadie lee, y estas acciones mueven dinero y estados. */}
        {error && (
          <div className="sticky top-[112px] z-10 mx-5 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="sticky top-[112px] z-10 mx-5 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}

        {!detail && error ? (
          // La carga falló: ya no queda nada que esperar. El esqueleto latiendo
          // bajo el error decía justo lo contrario —«sigo trayéndolo»— y dejaba
          // al equipo mirando una pantalla que no iba a llegar nunca. Aquí el
          // pedido no se pudo traer y lo único útil es volver a intentarlo.
          <div className="space-y-3 p-5">
            <p className="text-sm text-slate-500">
              El detalle de este pedido no se pudo cargar. El pedido sigue en su sitio: esto es un
              fallo al leerlo, no un pedido perdido.
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Reintentar
            </button>
          </div>
        ) : !detail ? (
          // Un "Cargando…" suelto no dice nada; un esqueleto con la forma del
          // contenido evita que la pantalla salte cuando llega.
          <div className="space-y-4 p-5" aria-busy="true">
            <div className="h-6 w-2/3 animate-pulse rounded bg-slate-100" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
            <div className="h-24 animate-pulse rounded bg-slate-100" />
            <div className="h-40 animate-pulse rounded bg-slate-100" />
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-5">
            <section
              id="pedido-panel-operar"
              role="tabpanel"
              aria-label="Operar pedido"
              hidden={workspace !== "operar"}
              data-drawer-section="resumen"
              className="order-1 scroll-mt-28 space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
            >
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Situación del pedido
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <MacroStageBadge stage={detail.row.macro_stage} />
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
                    {macroSubstageLabel(detail.row.macro_substage)}
                  </span>
                  {/* Un motivo dice qué falta, la subetapa dice en qué punto va la
                      gestión: el pedido se ve entero sin abrir nada. En Por cerrar
                      los motivos son el trabajo mismo y los lista la mesa de cierre,
                      así que no se repiten aquí. */}
                  {detail.row.macro_stage !== "por_cerrar" &&
                    (detail.row.macro_reasons ?? []).map((reason) => (
                      <span
                        key={reason}
                        className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200"
                      >
                        {macroSubstageLabel(reason)}
                      </span>
                    ))}
                  <span className="text-xs text-slate-400">
                    {fmtAge(detail.row.macro_since ?? detail.row.status_since)} en esta macroetapa · fuente:{" "}
                    {detail.row.status_source ?? "—"}
                  </span>
                </div>
              </div>

              <DrawerJourneyRail current={detail.row.macro_stage} />
            </section>

            {nextAction && workspace === "operar" && (
              <div className="order-2">
                <DrawerNextActionCard action={nextAction} onJump={jumpTo} />
              </div>
            )}

            {/* La gestión de confirmación va arriba porque en Por confirmar ES
                el trabajo. Se muestra antes que el panel de pago para que el
                empate de `order-3` lo resuelva el orden del DOM: en Agencia el
                abono se pide DURANTE la llamada, no en vez de ella. */}
            {/* Y también en Reproprovincia: la gestión de llamadas era por GUÍA, y
                una guía anulada no admite gestión, así que estos pedidos no se
                podían llamar (0 llamadas sobre 920 en 60 días). La mesa de
                confirmación es por PEDIDO: se reutiliza tal cual. */}
            {(detail.row.macro_stage === "por_confirmar" ||
              detail.row.macro_substage === "gestion_reproprovincia") &&
              canEdit && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="confirmacion"
                className="order-3 scroll-mt-28"
              >
                <ConfirmationDesk
                  brief={brief}
                  row={detail.row}
                  tasks={detail.tasks}
                  shopifyUrl={shopifyUrl}
                  timeline={detail.timeline}
                  pending={pending}
                  onAttempt={(payload) =>
                    run(() => registerConfirmationAttempt(orderId, payload))
                  }
                />
                {detail.row.macro_substage === "gestion_reproprovincia" && (
                  <DescartarRecuperacion
                    pending={pending}
                    onDiscard={(motivo) => run(() => descartarRecuperacion(orderId, motivo))}
                  />
                )}
              </div>
            )}

            <section
              id="pedido-panel-informacion"
              role="tabpanel"
              aria-label="Información del pedido"
              hidden={workspace !== "informacion"}
              className="order-1 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                    Pedido y cliente
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Datos comerciales sincronizados desde Shopify y contexto operativo de Kapta.
                  </p>
                </div>
                {/* La cobertura vive en la cabecera fija. Repetirla aquí, a dos
                    dedos y en la misma pantalla, sugería que eran dos datos
                    distintos. La de «Ubicación y cobertura» sí se queda: ahí es
                    el sujeto de la sección y lo que se corrige. */}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-4">
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
                <Field label="Tienda" value={storeName(detail.row.store_id)} />
                <Field label="Creado" value={fmtDateTime(detail.row.order_created_at)} />
                <Field label="Courier actual" value={detail.row.current_courier} />
                <Field label="Guía actual" value={detail.row.guide_code} />
                {/* Estos cuatro vivían solo en la tabla. Al sacar sus columnas
                    del Master —para que quepa lo que se mira todos los días—
                    tienen que estar aquí, o el dato desaparecería del sistema. */}
                {detail.row.pickup_state && (
                  <>
                    <Field
                      label="Agencia"
                      value={
                        [operationalLabel(detail.row.pickup_state), detail.row.agency_branch]
                          .filter(Boolean)
                          .join(" · ") || null
                      }
                    />
                    <div>
                      <dt className="text-xs text-slate-400">Días en agencia</dt>
                      <dd className="text-slate-700">
                        <AgencyDays
                          arrivedAt={detail.row.agency_arrived_at}
                          expiresAt={detail.row.agency_expires_at}
                        />
                      </dd>
                    </div>
                  </>
                )}
                <div>
                  <dt className="text-xs text-slate-400">Pago / clave</dt>
                  <dd className="text-slate-700">
                    <PaymentIndicator
                      paymentState={detail.row.payment_state}
                      keyState={detail.row.key_state}
                    />
                  </dd>
                </div>
                <Field label="Costo logístico" value={fmtMoney(detail.row.logistics_cost)} />
              </dl>

              {/* LA NOTA DEL PEDIDO, tal como se escribió en Shopify.
                  Va FUERA de la rejilla y a ancho completo porque es texto libre
                  y de largo imprevisible: como un campo más de cuatro columnas se
                  cortaría justo donde está el dato. `whitespace-pre-wrap` respeta
                  los saltos de línea que puso quien la escribió.
                  Solo aparece si hay nota: un bloque vacío enseñaría un hueco
                  permanente en todos los pedidos que no la usan. */}
              {detail.shopifyNote && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/70 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-800">
                    Nota del pedido
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">
                    {detail.shopifyNote}
                  </p>
                </div>
              )}
            </section>

            <div hidden={workspace !== "informacion"} className="order-2 scroll-mt-28">
              <GeoSection
                orderId={orderId}
                row={detail.row}
                canEdit={canEdit}
                onSaved={() => {
                  void reload();
                  onSaved();
                }}
              />
            </div>

            {detail.lineItems.length > 0 && (
              <section
                hidden={workspace !== "informacion"}
                data-drawer-section="productos"
                className="order-3 scroll-mt-28 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                    Productos
                  </h3>
                  <p className="shrink-0 text-xs tabular-nums text-slate-500">
                    {detail.lineItems.length}{" "}
                    {detail.lineItems.length === 1 ? "producto" : "productos"}
                  </p>
                </div>
                <OrderLineItems items={detail.lineItems} totals={detail.totals} />
              </section>
            )}

            <div
              hidden={workspace !== "operar"}
              data-drawer-section="rutas"
              className="order-4 scroll-mt-28"
            >
              <OrderRouteDesk
                plan={detail.routePlan}
                gate={detail.routeGate}
                onJump={jumpTo}
                actionEnabled={routeEnabled}
                onSelect={selectRoute}
              />
            </div>

            <section
              hidden={workspace !== "operar"}
              data-drawer-section="guias"
              className="order-6 scroll-mt-28 rounded-xl border border-sky-200 bg-sky-50/40 p-4"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-sky-900">
                    Salidas y guías
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Cada salida conserva su courier, rótulo, QR y resultado independiente.
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
                  {detail.guides.length}
                </span>
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
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-100 bg-white px-3 py-2 text-sm shadow-sm"
                    >
                      <span className="font-medium capitalize text-slate-800">{g.courier}</span>
                      <span className="font-mono text-xs text-slate-500">
                        {outputDisplayCode(g.output_code, g.courier) || g.guide_code}
                      </span>
                      {/* El número con el que el COURIER conoce el envío.
                          Estaba escondido: en cuanto la salida tenía código
                          interno, `outputDisplayCode` ganaba y el `guide_code`
                          no se pintaba nunca. Es justo el dato que hay que
                          teclear en el panel del courier para buscarla, y el
                          que el rótulo de Shalom titula «N° de Orden». */}
                      {g.guide_code && outputDisplayCode(g.output_code, g.courier) && (
                        <span className="font-mono text-xs font-semibold text-slate-700">
                          N° {g.guide_code}
                        </span>
                      )}
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
                      {/* Los dos rótulos del paquete en UNA hoja: el de
                          Tanders arriba y, debajo, el QR de la salida y qué va
                          dentro de la caja. Se suma a los otros dos en vez de
                          reemplazarlos mientras se valida en el almacén. Marca
                          «rótulo generado» igual que el enlace suyo: para
                          Tanders el paquete quedó rotulado, lo imprimas junto o
                          por separado. */}
                      {g.courier === "tanders" && (
                        <a
                          href={`/api/pedidos/guia-combinada?ids=${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => void markTandersLabelGenerated([g.id])}
                          className="rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
                        >
                          Guía combinada ↗
                        </a>
                      )}
                      {/* Un solo papel para la caja de agencia: la etiqueta de
                          Shalom —que la compone ELLOS y se pide a su API—
                          arriba, y debajo nuestra banda con el QR de la salida
                          y los productos. Antes eran dos impresiones, y para
                          conseguir la segunda el almacén acababa creando una
                          salida `por definir` que después bloquea la guía.

                          Solo existe para las guías creadas por API: las que
                          llegaron por el Excel no tienen `ose_id` y su rótulo se
                          baja del panel de Shalom. */}
                      {g.courier === "shalom" && g.shalom_ose_id && (
                        <>
                          <a
                            href={`/api/shalom/rotulo/${g.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-medium text-brand-700 hover:underline"
                          >
                            Rótulo ↗
                          </a>
                          {/* El suelto se conserva a un clic de distancia: si la
                              composición falla, el mostrador de Shalom sigue
                              necesitando su papel. */}
                          <a
                            href={`/api/shalom/label/${g.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-slate-500 hover:underline"
                          >
                            solo Shalom
                          </a>
                          {/* El «Ticket Shalom», el recibo de tira del
                              mostrador. No es el rótulo: es el otro papel, el
                              que hasta ahora había que bajar a mano de
                              pro.shalom.pe envío por envío. */}
                          <a
                            href={`/api/shalom/ticket/${g.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-slate-500 hover:underline"
                          >
                            ticket
                          </a>
                        </>
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
                      {/* El botón que faltaba para Swayp. Rellenar la salida le
                          cambia la vía, así que «Anular salida» deja de
                          ofrecerse —bien: la guía ya existe del otro lado— y sin
                          esto no quedaba ninguno. Ver `cancelFenixOutput`. */}
                      {canEdit && fenixOutputIsCancelable(g) && (
                        <FenixCancelButton
                          shipmentId={g.id}
                          guideCode={g.guide_code}
                          wasFilled={detail.filledOutputIds.includes(g.id)}
                          onDone={(msg) => {
                            setNotice(msg);
                            void reload();
                            onSaved();
                          }}
                        />
                      )}
                      {/* Las salidas de ruta manual no tienen API a la que
                          avisar: anularlas es corregir NUESTRO registro, así que
                          basta el permiso con el que se crearon. */}
                      {canEdit && manualOutputIsCancelable(g) && (
                        <ManualOutputCancelButton
                          shipmentId={g.id}
                          label={g.output_code ?? g.guide_code ?? "esta salida"}
                          onDone={(msg) => {
                            setNotice(msg);
                            void reload();
                            onSaved();
                          }}
                        />
                      )}
                      {g.qr_token && (
                        <a
                          href={`/api/pedidos/rotulos?ids=${g.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Rótulo interno
                        </a>
                      )}
                      {g.guide_code === detail.row.guide_code && (
                        <span className="ml-auto text-xs text-slate-400">actual</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {/* El cobro del courier lo confirma una PERSONA en Validar
                  pagos: el lector de imágenes prepara la ficha, pero valida una
                  imagen, no un depósito. Desde acá se llega de un clic en vez
                  de buscar el pedido en la otra pantalla. */}
              {detail.row.payment_check_state && (
                <p className="mt-3 text-xs text-slate-500">
                  Cobro del courier:{" "}
                  <strong className="text-slate-700">
                    {PAYMENT_CHECK_OPTIONS.find((o) => o.value === detail.row.payment_check_state)
                      ?.label ?? detail.row.payment_check_state}
                  </strong>
                  .{" "}
                  <a
                    href="/dashboard/pagos"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-slate-700 underline"
                  >
                    Confirmarlo en Validar pagos
                  </a>
                </p>
              )}
              {detail.guides.some((guide) => guide.courier === "shalom") && (
                <ShalomPickupKeyPanel orderId={orderId} onChanged={onSaved} />
              )}
            </section>

            {["por_cerrar", "finalizado"].includes(detail.row.macro_stage ?? "") && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="cierre"
                className="order-7 scroll-mt-28"
              >
                <OrderClosureDesk
                  stage={detail.row.macro_stage}
                  reasons={(detail.row.macro_reasons ?? []) as MacroSubstage[]}
                  generalStatus={detail.row.general_status}
                  guides={detail.guides}
                  permissions={closurePermissions}
                  pending={pending}
                  onAction={(input) => run(() => registerClosureAction(orderId, input))}
                />
              </div>
            )}

            <section
              id="pedido-panel-actividad"
              role="tabpanel"
              aria-label="Actividad del pedido"
              hidden={workspace !== "actividad"}
              data-drawer-section="historial"
              className="order-1 scroll-mt-28 overflow-hidden rounded-xl border border-slate-200 bg-white"
            >
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
                    Actividad y auditoría
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {detail.timeline.length} movimiento{detail.timeline.length === 1 ? "" : "s"} · se conserva indefinidamente
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  Solo lectura
                </span>
              </div>
              <div className="px-4 py-4">
                {detail.timeline.length === 0 ? (
                  <p className="text-sm text-slate-400">Sin movimientos registrados.</p>
                ) : (
                  <ol className="space-y-3 border-l border-slate-200 pl-4">
                    {detail.timeline.map((t) => (
                      <li key={t.id} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[21px] top-1.5 h-2 w-2 rounded-full",
                            t.origin === "leads"
                              ? "bg-violet-500"
                              : /payment|liquidation|entregado/.test(t.kind)
                                ? "bg-emerald-500"
                              : /return|refund|merma|anulado/.test(t.kind)
                                ? "bg-orange-500"
                                : /guide|dispatch|route|custody/.test(t.kind)
                                  ? "bg-indigo-500"
                                  : "bg-slate-400",
                          )}
                        />
                        <p className="text-sm font-medium text-slate-800">
                          {TIMELINE_LABEL[t.kind] ?? t.kind}
                          {/* El resultado va pegado al título, no en la línea de
                              la nota: la nota es opcional y sin esto dos
                              resultados distintos se leían idénticos. */}
                          {t.confirmation?.result && (
                            <span className="ml-1 font-normal text-slate-500">
                              · {confirmationResultLabel(t.confirmation.result)}
                            </span>
                          )}
                          {(t.statusLabel ?? (t.newStatus ? generalLabel(t.newStatus) : null)) && (
                            <span className="ml-1 font-normal text-slate-500">
                              → {t.statusLabel ?? generalLabel(t.newStatus!)}
                            </span>
                          )}
                        </p>
                        {(t.note || t.reason) && (
                          <p className="mt-0.5 text-sm leading-5 text-slate-600">{t.note ?? t.reason}</p>
                        )}
                        <p className="mt-0.5 text-xs text-slate-400">
                          {fmtDateTime(t.occurredAt)}
                          {t.actorName ? ` · ${t.actorName}` : ""}
                          {t.confirmation?.channel
                            ? ` · ${confirmationChannelLabel(t.confirmation.channel)}`
                            : ""}
                          {t.courier ? ` · ${t.courier}` : ""}
                          {t.guideCode ? ` · ${t.guideCode}` : ""}
                          {` · ${
                            t.origin === "gestion"
                              ? "Repro Provincia"
                              : t.origin === "leads"
                                ? "Leads"
                                : t.source
                          }`}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>

            {/* Agencia o una regla de riesgo ponen el pago antes que la ruta.
                Provincia COD puede salir contra entrega, así que conserva la
                Mesa de ruta primero y deja el pago anticipado como herramienta
                opcional debajo. Sigue disponible antes de crear Shalom para no
                reconstruir el antiguo callejón circular guía ↔ adelanto. */}
            {showPaymentPanel && paymentPanel && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="pagos"
                className={cn(
                  "scroll-mt-28 rounded-xl border p-4",
                  paymentPanel.mode === "required"
                    ? "order-3 border-amber-200 bg-amber-50/30"
                    : "order-5 border-slate-200 bg-white",
                )}
              >
                <PickupKeyPanel
                  orderId={orderId}
                  mode={paymentPanel.mode}
                  gatewayNote={gatewayNote}
                  onChanged={onSaved}
                />
              </div>
            )}

            {/* Crear guía: solo tiene sentido en un pedido que todavía no tiene
                una. En cuanto existe, el seguimiento vive en Envíos.

                Y solo donde Aliclik atiende. El plan de rutas ya no lo ofrece
                en Agencia —ahí van Shalom u Olva—, pero este panel se dibujaba
                igual con solo tener el permiso: la pantalla mostraba las dos
                tarjetas de agencia y, debajo, un formulario para crear una guía
                de una ruta que ese pedido no puede tomar. Se lee el plan en vez
                de repetir la regla aquí, que es como se vuelven a separar. */}
            {canCreateGuide && aliclikOffered && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="aliclik"
                className="order-5 scroll-mt-28"
              >
                <AliclikGuidePanel
                  orderId={orderId}
                  hasCoordinate={detail.row.latitude != null && detail.row.longitude != null}
                  health={detail.aliclikHealth}
                  riskRequirement={brief?.risk.requirement ?? "ninguno"}
                  paymentState={detail.row.payment_state}
                  riskReasons={brief?.risk.reasons ?? []}
                  onCreated={() => {
                    void reload();
                    onSaved();
                  }}
                />
              </div>
            )}

            {/* Esconderlo sin más dejaría buscando a quien esperaba encontrarlo.
                La salida es corregir la dirección: la cobertura se recalcula a
                partir de ella y, si el pedido era Provincia COD mal clasificada,
                Aliclik vuelve solo.

                Pero eso vale mientras la ruta se está DECIDIENDO. Con una salida
                ya activa la pregunta está contestada: corregir la dirección no va
                a traer Aliclik de vuelta a un paquete que ya viaja, y el bloque
                se lee como una opción disponible cuando no lo es. */}
            {canCreateGuide &&
              !aliclikOffered &&
              detail.routePlan.operation === "agencia" &&
              detail.routePlan.activeOutputCount === 0 && (
              <div
                hidden={workspace !== "operar"}
                data-drawer-section="aliclik"
                className="order-5 scroll-mt-28 rounded-xl border border-slate-200 bg-white p-4"
              >
                <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                  Aliclik
                </h3>
                <p className="mt-1 text-sm leading-5 text-slate-600">
                  Aliclik no atiende pedidos de Agencia; este va con Shalom u Olva. Si la dirección
                  está mal clasificada, corrígela y la cobertura se recalcula sola. Y si la
                  dirección está bien pero crees que Aliclik sí llega, pregúntaselo: cotizar no
                  crea nada.
                </p>
                <button
                  type="button"
                  onClick={() => jumpTo("ubicacion")}
                  className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Revisar ubicación y cobertura ↓
                </button>
                <AliclikCoverageProbe
                  orderId={detail.row.order_id}
                  district={detail.row.district}
                  canMark={canCreateGuide}
                />
              </div>
            )}

            {canEdit ? (
              <div hidden={workspace !== "operar"} className="order-8">
                <OrderActions
                  row={detail.row}
                  canOverride={canOverride}
                  pending={pending}
                  outputCount={detail.routePlan.outputCount}
                  onStatus={(general, operational, reason, agencyCourier) =>
                    run(() => setOrderStatus(orderId, { general, operational, reason, agencyCourier }))
                  }
                  onComment={(text, type) => run(() => addOrderComment(orderId, { text, type }))}
                  onReturn={(reason, guideCode) => run(() => registerReturn(orderId, { reason, guideCode }))}
                  onRelink={(guideCode) => run(() => relinkGuide(guideCode, orderId))}
                />
              </div>
            ) : (
              <div hidden={workspace !== "operar"} className="order-8">
                <EmptyState title="Solo lectura">
                  Tu rol permite consultar el pedido, sus comentarios y su historial, pero no modificarlo.
                </EmptyState>
              </div>
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
      {swaypOpen && (
        <DirectFenixGuideModal
          initialOrderId={orderId}
          onClose={() => setSwaypOpen(false)}
          onCreated={() => {
            void reload();
            onSaved();
          }}
        />
      )}
      {manualRoute && ["axel", "urpi", "olva"].includes(manualRoute.key) && (
        <ManualRouteOutputModal
          orderId={orderId}
          route={manualRoute as RouteCandidate & { key: "axel" | "urpi" | "olva" }}
          activeOutputs={detail?.routePlan.activeOutputCount ?? 0}
          onClose={() => setManualRoute(null)}
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
  history: "historial confiable del cliente",
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
    <section
      data-drawer-section="ubicacion"
      className="scroll-mt-28 space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Ubicación y cobertura</h3>
        <CoverageBadge coverage={row.coverage} />
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

      {(row.coverage ?? "por_revisar") === "por_revisar" && !editing && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs text-amber-900">
            Completa la región y el distrito para asignar el flujo correcto.
          </p>
          {canEdit && (
            <button
              type="button"
              onClick={open}
              className="shrink-0 rounded-md bg-amber-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-800"
            >
              Completar
            </button>
          )}
        </div>
      )}

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

/**
 * Mesa de confirmación: donde se registra cada intento de contacto.
 *
 * Un solo gesto por intento. Antes esto no existía —el resolvedor leía eventos
 * que nadie escribía— y los 2.994 pedidos Por confirmar vivían en «Sin llamar»
 * por más llamadas que hiciera el equipo.
 *
 * El contador cuenta DÍAS DISTINTOS con gestión, no días transcurridos: llamar
 * el 20, el 22, el 25 y el 28 de julio son cuatro días de siete, no nueve. Los
 * días en que nadie llamó no gastan cupo.
 */
const REQUIREMENT_TONE: Record<PaymentRequirement, string> = {
  ninguno: "border-slate-200 bg-white text-slate-700",
  sugerir_adelanto: "border-amber-200 bg-amber-50 text-amber-900",
  exigir_adelanto: "border-orange-300 bg-orange-50 text-orange-900",
  pago_completo: "border-rose-300 bg-rose-50 text-rose-900",
};

/**
 * Lo que el MOM §8 manda revisar ANTES de llamar: historial del cliente,
 * duplicados y cobertura.
 *
 * Hasta ahora esto vivía en tres columnas del Excel —«Métricas», «Duplicado?» y
 * «Cobertura Aliclick o Dropi?»— resumidas a mano. Sin ellas, la tabla de riesgo
 * del §8 no se podía aplicar desde Kapta: la regla existe desde siempre en el
 * papel, pero nadie tenía el número de antecedentes delante al marcar.
 */
/**
 * Una línea del historial del cliente.
 *
 * Cada fila responde cuatro cosas que antes no se veían: cuándo fue, si es
 * POSTERIOR al pedido que se está mirando, si llegó a costar flete y qué llevaba.
 * La última importa más de lo que parece: cuatro pedidos del mismo producto y la
 * misma cantidad no son un historial de compras, son el mismo pedido repetido.
 */
function PriorOrderRow({
  row,
  referenceCreatedAt,
  currentProducts,
}: {
  row: PriorOrderSnapshot;
  referenceCreatedAt: string | null;
  currentProducts: string | null;
}) {
  const outcome = priorOutcome(row);
  const dispatch = dispatchState(row);
  const courier = priorCourier(row);
  const later = priorTiming(row, referenceCreatedAt) === "posterior";
  const repeats = sameProducts(row.products, currentProducts);
  const attempts = row.attempt_count ?? 0;

  return (
    <li className="rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="font-mono text-[11px] font-medium text-slate-800">
          {row.order_name ?? row.order_id}
        </span>
        <span className="text-[11px] text-slate-500">
          {fmtDate(row.order_created_at)} · {fmtAge(row.order_created_at)}
        </span>
        {/* El pedido abierto que se mira puede ser el MÁS VIEJO del teléfono: sin
            esta marca, un re-pedido posterior se lee como antecedente previo. */}
        {later && (
          <span className="rounded bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-800">
            posterior a este
          </span>
        )}
        <span
          className={cn(
            "ml-auto rounded px-1.5 text-[10px] font-semibold",
            outcome === "entregado"
              ? "bg-emerald-100 text-emerald-800"
              : outcome === "anulado" || outcome === "devuelto"
                ? "bg-rose-100 text-rose-800"
                : "bg-slate-200 text-slate-700",
          )}
        >
          {row.operational_status ? operationalLabel(row.operational_status) : PRIOR_OUTCOME_LABEL[outcome]}
        </span>
      </div>

      {row.products && (
        <p
          className={cn(
            "mt-0.5 truncate text-[11px]",
            repeats ? "font-semibold text-amber-800" : "text-slate-600",
          )}
          title={row.products}
        >
          {row.products}
          {repeats && " · lo mismo que este pedido"}
        </p>
      )}

      {/* Nueve de cada diez anulados nunca llegaron a despacharse. Decirlo evita
          exigir pago completo por antecedentes que no costaron un solo flete. */}
      <p className="mt-0.5 text-[10px] text-slate-500">
        {dispatch === "nunca_despachado" ? (
          <span className="font-medium text-slate-600">{DISPATCH_STATE_LABEL.nunca_despachado}</span>
        ) : (
          <>
            {courier ?? "courier sin registrar"}
            {row.guide_code ? ` · guía ${row.guide_code}` : ""}
            {attempts > 0 ? ` · ${attempts} intento${attempts === 1 ? "" : "s"}` : ""}
          </>
        )}
        {row.order_total != null ? ` · ${fmtMoney(row.order_total)}` : ""}
      </p>
    </li>
  );
}

function ConfirmationBrief({ brief }: { brief: OrderConfirmationBrief }) {
  const { counts, risk, duplicates, codCouriers, priors, orderCreatedAt, products } = brief;
  const known = priors.length;
  const later = countLaterOrders(priors, orderCreatedAt);
  const outcomes = (Object.keys(PRIOR_OUTCOME_LABEL) as PriorOutcome[]).filter(
    (key) => counts[key] > 0,
  );

  return (
    <div className="space-y-2.5 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
          Antes de llamar
        </h4>
        <span className="text-[11px] text-slate-500">
          {known === 0
            ? "Sin otros pedidos con este teléfono"
            : `${known} pedido${known === 1 ? "" : "s"} más con este teléfono` +
              (later > 0 ? ` · ${later} posterior${later === 1 ? "" : "es"} a este` : "")}
        </span>
      </div>

      {/* El desglose por desenlace, que es lo que la columna «Métricas» resume a
          mano. Los entregados van primero y bien visibles: son el argumento de
          quien decida saltarse la regla del §8 con justificación. */}
      {outcomes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {outcomes.map((key) => (
            <span
              key={key}
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                key === "entregado"
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                  : key === "anulado" || key === "devuelto"
                    ? "bg-rose-50 text-rose-800 ring-rose-200"
                    : "bg-slate-50 text-slate-700 ring-slate-200",
              )}
            >
              {PRIOR_OUTCOME_LABEL[key]}: {counts[key]}
            </span>
          ))}
        </div>
      )}

      <div className={cn("rounded-md border px-2.5 py-2", REQUIREMENT_TONE[risk.requirement])}>
        <p className="text-xs font-bold">
          {PAYMENT_REQUIREMENT_LABEL[risk.requirement]}
          {risk.antecedents > 0 && (
            <span className="font-medium">
              {" "}
              · {risk.antecedents} antecedente{risk.antecedents === 1 ? "" : "s"} de rechazo o
              devolución
            </span>
          )}
        </p>
        {risk.reasons.length > 0 && (
          <p className="mt-0.5 text-[11px] leading-4 opacity-90">{risk.reasons.join(" ")}</p>
        )}
      </div>

      {/* Un duplicado no visto termina en dos paquetes al mismo destino, y el
          flete de uno se pierde. Se listan con nombre y fecha: la decisión es
          humana, la herramienta solo se asegura de que los vea. */}
      {duplicates.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2">
          <p className="text-xs font-bold text-amber-900">
            ⚠ {duplicates.length} pedido{duplicates.length === 1 ? "" : "s"} abierto
            {duplicates.length === 1 ? "" : "s"} del mismo teléfono
          </p>
          <ul className="mt-1 space-y-0.5">
            {duplicates.slice(0, 5).map((row) => (
              <li key={row.order_id} className="text-[11px] text-amber-900">
                <span className="font-mono font-medium">{row.order_name ?? row.order_id}</span>
                {row.order_created_at ? ` · ${fmtDate(row.order_created_at)}` : ""}
                {row.order_total != null ? ` · ${fmtMoney(row.order_total)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* El historial pedido a pedido. El desglose de arriba dice CUÁNTOS; esto
          dice cuáles, cuándo y si alguno llegó a salir — que es de donde sale la
          decisión real, y lo que antes había que ir a buscar a Shopify y a
          Aliclik por separado. */}
      {priors.length > 0 && (
        <details className="group" open={priors.length <= 4}>
          <summary className="cursor-pointer list-none text-[11px] font-semibold text-slate-500 hover:text-slate-700">
            Historial del cliente
            <span className="ml-1 font-normal text-slate-400 group-open:hidden">
              (ver los {priors.length})
            </span>
          </summary>
          <ul className="mt-1.5 space-y-1">
            {priors.slice(0, 10).map((row) => (
              <PriorOrderRow
                key={row.order_id}
                row={row}
                referenceCreatedAt={orderCreatedAt}
                currentProducts={products}
              />
            ))}
          </ul>
          {priors.length > 10 && (
            <p className="mt-1 text-[10px] text-slate-400">
              y {priors.length - 10} más, no mostrados
            </p>
          )}
        </details>
      )}

      {/* La pregunta de la llamada es «¿sale por Aliclik o va a agencia?». Sale
          de la misma matriz de tarifas que ya clasifica la cobertura, así que no
          puede contradecir lo que dice la cabecera del pedido. */}
      <p className="text-[11px] text-slate-600">
        <span className="font-semibold text-slate-500">Cobertura COD:</span>{" "}
        {codCouriers.length > 0 ? (
          <span className="font-medium text-slate-800">{codCouriers.join(" · ")}</span>
        ) : (
          <span className="text-slate-500">
            sin courier COD con tarifa para este destino; va por agencia
          </span>
        )}
      </p>
    </div>
  );
}

function ConfirmationDesk({
  brief,
  row,
  tasks,
  shopifyUrl,
  timeline,
  pending,
  onAttempt,
}: {
  brief: OrderConfirmationBrief | null;
  row: OrderMasterRow;
  tasks: OrderMasterDetail["tasks"];
  shopifyUrl: string | null;
  timeline: TimelineEntry[];
  pending: boolean;
  onAttempt: (input: {
    result: string;
    channel: string;
    note?: string;
    nextContactOn?: string;
    operationId?: string;
  }) => void;
}) {
  const [result, setResult] = useState(CONFIRMATION_RESULTS[0]!.code);
  const [channel, setChannel] = useState<string>(CONFIRMATION_CHANNELS[0].code);
  const [nextContactOn, setNextContactOn] = useState("");
  const [note, setNote] = useState("");

  const events = useMemo(
    () => timeline.map((entry) => ({ kind: entry.kind, occurred_at: entry.occurredAt })),
    [timeline],
  );
  const days = useMemo(() => confirmationDays(events), [events]);
  const used = days.length;
  const today = limaDayKey(new Date().toISOString());
  // Si ya se llamó hoy, este intento NO abre día nuevo: el MOM cuenta el día,
  // no la llamada, y decirle al operador que gasta un cupo que no gasta lo
  // empujaría a no registrar los intentos siguientes.
  const opensNewDay = !days.includes(today);
  const projected = Math.min(used + (opensNewDay ? 1 : 0), CONFIRMATION_MAX_DAYS);
  const lastAttempt = used >= CONFIRMATION_MAX_DAYS;
  const cancellationTask = tasks.find(
    (task) => task.kind === "shopify_cancellation_review" && task.status === "pending",
  );
  const reminderTask = tasks.find(
    (task) => task.kind === "confirmation_reminder" && task.status === "pending",
  );
  const followupBucket = row.confirmation_next_contact_on
    ? confirmationDueBucket(row.confirmation_next_contact_on)
    : null;

  const selected = confirmationResult(result);
  const needsDate = Boolean(selected?.schedulesFollowup);
  const blocked = pending || lastAttempt || (needsDate && !nextContactOn);


  return (
    <section
      className={cn(
        "space-y-4 rounded-xl border p-4",
        lastAttempt ? "border-amber-300 bg-amber-50/50" : "border-indigo-200 bg-indigo-50/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-indigo-900">
            Gestión de confirmación
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Un registro por intento. Llamada, WhatsApp y mensaje del mismo día cuentan como un
            solo día de gestión.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-bold ring-1",
            lastAttempt
              ? "bg-white text-amber-900 ring-amber-300"
              : "bg-white text-indigo-900 ring-indigo-200",
          )}
        >
          Día {used} de {CONFIRMATION_MAX_DAYS}
        </span>
      </div>

      {used > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {days.map((day) => (
            <span
              key={day}
              className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200"
            >
              {day.slice(5).split("-").reverse().join("/")}
            </span>
          ))}
        </div>
      )}

      {lastAttempt && (
        <div className="rounded-lg bg-white px-3 py-3 text-xs leading-5 text-amber-950 ring-1 ring-amber-200">
          <p>
            <strong>Último intento completado.</strong> Se agotaron los {CONFIRMATION_MAX_DAYS} días
            de gestión. Kapta no anula automáticamente.
          </p>
          {cancellationTask && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-amber-100 pt-2">
              <span>
                Tarea asignada a {cancellationTask.assignedName ?? "la última persona que gestionó"}.
              </span>
              {shopifyUrl && (
                <a
                  href={shopifyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-amber-900 px-2.5 py-1.5 font-semibold text-white hover:bg-amber-950"
                >
                  Revisar en Shopify ↗
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {row.macro_substage === "historico_sin_gestion" && (
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-700">
          Pedido anterior al corte operativo del 01/06/2026. Se conserva en el historial y no
          cuenta como trabajo nuevo de Sin llamar.
        </p>
      )}

      {row.confirmation_next_contact_on && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs ring-1",
            followupBucket === "vencido"
              ? "bg-rose-50 text-rose-900 ring-rose-200"
              : followupBucket === "hoy"
                ? "bg-amber-50 text-amber-900 ring-amber-200"
                : "bg-sky-50 text-sky-900 ring-sky-200",
          )}
        >
          <strong>
            {followupBucket === "vencido"
              ? "Contacto vencido"
              : followupBucket === "hoy"
                ? "Contactar hoy"
                : "Próximo contacto"}
          </strong>
          <span>{fmtDate(`${row.confirmation_next_contact_on}T12:00:00.000Z`)}</span>
        </div>
      )}

      {/* El ciclo automático: sin fecha pactada el pedido igual vuelve a la cola.
          Se anuncia aquí para que quien abra el pedido sepa que lo trajo el
          ciclo y no un compromiso con el cliente. */}
      {!row.confirmation_next_contact_on && row.confirmation_cycle_due_on && !lastAttempt && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">
          <strong>
            {row.confirmation_cycle_due_on <= today
              ? "Toca hoy por ciclo automático"
              : "Vuelve a la cola por ciclo automático"}
          </strong>
          <span>
            {row.confirmation_cycle_due_on <= today
              ? "Sin fecha pactada"
              : fmtDate(`${row.confirmation_cycle_due_on}T12:00:00.000Z`)}
          </span>
        </div>
      )}

      {reminderTask?.dueAt && !lastAttempt && (
        <p className="text-xs text-slate-500">
          Recordatorio de confirmación: {fmtDateTime(reminderTask.dueAt)}.
        </p>
      )}

      {brief && <ConfirmationBrief brief={brief} />}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Canal
          </span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            {CONFIRMATION_CHANNELS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Resultado
          </span>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            {CONFIRMATION_RESULTS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected && <p className="text-xs text-slate-500">{selected.hint}</p>}

      {needsDate && (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Próximo contacto
          </span>
          <input
            type="date"
            value={nextContactOn}
            min={today}
            onChange={(e) => setNextContactOn(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm sm:w-52"
          />
        </label>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Qué dijo el cliente (opcional)"
        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={blocked}
          onClick={() => {
            onAttempt({
              result,
              channel,
              note,
              nextContactOn,
              operationId: crypto.randomUUID(),
            });
            setNote("");
            setNextContactOn("");
          }}
          className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
        >
          Registrar intento
        </button>
        <span className="text-xs text-slate-500">
          {opensNewDay
            ? `Abre el día ${projected} de ${CONFIRMATION_MAX_DAYS}.`
            : "Ya hay gestión de hoy: no consume otro día."}
        </span>
      </div>
    </section>
  );
}

function OrderActions({
  row,
  canOverride,
  pending,
  outputCount,
  onStatus,
  onComment,
  onReturn,
  onRelink,
}: {
  row: OrderMasterRow;
  canOverride: boolean;
  pending: boolean;
  /** Cuántas salidas tiene el pedido, activas o no. Un pedido de agencia que
   *  llega a la sucursal con CERO salidas es el que hay que preguntar. */
  outputCount: number;
  onStatus: (general: string, operational: string, reason: string, agencyCourier?: string) => void;
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
  const [agencyCourier, setAgencyCourier] = useState("");

  const options = operationalStatusesFor(general);
  const closed = ["entregado", "anulado", "devuelto"].includes(row.general_status);
  const changingClosed = closed && general !== row.general_status;
  // MISMA función pura que decide en el servidor. Aquí solo adelanta la pregunta
  // para no gastar un viaje de ida y vuelta; quien manda sigue siendo el servidor,
  // que rechaza el guardado si falta. Duplicar la regla en el cliente sería
  // invitarla a divergir justo donde nadie la volvería a mirar.
  const needsAgencyCourier = needsAttestedAgencyShipment({
    coverage: row.coverage,
    operational,
    shipmentCount: outputCount,
  });

  useEffect(() => {
    // Al cambiar el estado general, el operativo elegido puede dejar de aplicar.
    if (!options.some((o) => o.code === operational)) {
      setOperational(options[0]?.code ?? "");
    }
  }, [general, options, operational]);

  return (
    <section
      data-drawer-section="acciones"
      className="order-9 scroll-mt-28 space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
    >
      <div>
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
          Gestión manual
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Registra el resultado operativo o deja una nota. Las correcciones excepcionales están separadas al final.
        </p>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Registrar estado
        </h4>
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
        {/* UN PEDIDO DE AGENCIA NO PUEDE HABER LLEGADO SIN HABER SALIDO.
            Medido el 09-09-2026: los pedidos de agencia cuyo estado viene del
            rastreo de Shalom tienen salida el 100% de las veces (107 de 107); los
            marcados a mano fallan el 18,5% (42 de 227). Son 43 pedidos y S/6.140
            desde agosto invisibles para todo indicador de envío, y ocho seguían
            en la agencia sin aviso de vencimiento, el más viejo de 62 días.
            Se pregunta AQUÍ y no en un formulario aparte porque el formulario
            aparte ya existe —la salida manual admite Olva— y no se usó ni una vez
            en 40 días contra 866 salidas de Shalom. */}
        {needsAgencyCourier && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5">
            <p className="text-xs leading-5 text-amber-900">
              Este pedido no tiene ninguna salida registrada. ¿Por qué agencia se envió? Queda
              como salida con tu firma, y sin ella el pedido no aparece en los indicadores de
              envío ni en el aviso de vencimiento en agencia.
            </p>
            <select
              value={agencyCourier}
              onChange={(e) => setAgencyCourier(e.target.value)}
              className="mt-2 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">Elige la agencia…</option>
              {AGENCY_COURIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={changingClosed ? "Motivo (obligatorio)" : "Motivo u observación (opcional)"}
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <button
          disabled={
            pending ||
            (changingClosed && (!canOverride || !reason.trim())) ||
            (needsAgencyCourier && !agencyCourier)
          }
          onClick={() => onStatus(general, operational, reason, agencyCourier || undefined)}
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

      <details className="group overflow-hidden rounded-lg border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Devoluciones y correcciones avanzadas
          <span className="text-slate-400 transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="space-y-4 border-t border-slate-100 p-3">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-rose-700">
              Registrar devolución
            </h4>
            <p className="text-xs text-slate-500">
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
                className="min-w-44 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
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

          <div className="space-y-2 border-t border-slate-100 pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Corregir vínculo de guía
            </h4>
            {/* Qué hace, dicho antes de pulsar. Es la única vía para mover una
                guía que se enganchó al pedido equivocado —pasa cuando un cliente
                tiene dos pedidos y el emparejador solo tuvo el teléfono— y sin
                decirlo se lee como «vincular una guía suelta», que es lo que ya
                hace la tarjeta de Aliclik de arriba. */}
            <p className="text-xs text-slate-500">
              MUEVE la guía a este pedido, aunque esté en otro: se la quita al anterior, renumera la
              salida y deja constancia en los dos historiales. Es la corrección para una guía
              enganchada al pedido equivocado.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={relinkCode}
                onChange={(e) => setRelinkCode(e.target.value)}
                placeholder="Código de guía a vincular a este pedido"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
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
        </div>
      </details>
    </section>
  );
}

/**
 * Descartar la recuperación de provincia. Es la única puerta que MATA la venta
 * a mano en Reproprovincia; por eso pide motivo y no se esconde detrás de un
 * icono. Las otras salidas —Swayp, reprogramar Aliclik— viven en Rutas.
 */
function DescartarRecuperacion({
  pending,
  onDiscard,
}: {
  pending: boolean;
  onDiscard: (motivo: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState("");
  if (!abierto) {
    return (
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className="text-xs text-slate-500 underline-offset-2 hover:text-rose-700 hover:underline"
        >
          No hay reenvío posible · descartar la recuperación
        </button>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
      <p className="text-xs font-semibold text-rose-900">Descartar la recuperación</p>
      <p className="text-xs text-rose-800">
        El pedido pasa a cierre con este motivo escrito. No se toca la guía de Aliclik ni el inventario.
      </p>
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Motivo (obligatorio): p. ej. la clienta ya no quiere el producto"
        className="w-full rounded-lg border border-rose-200 px-2 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || motivo.trim().length < 8}
          onClick={() => onDiscard(motivo)}
          className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-40"
        >
          Descartar
        </button>
        <button
          type="button"
          onClick={() => {
            setAbierto(false);
            setMotivo("");
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

