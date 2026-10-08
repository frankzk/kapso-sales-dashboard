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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/components/ui";
import {
  Badge,
  Banner,
  CARD_ZONE,
  CHECKBOX,
  FIELD,
  FIELD_BOX,
  OpsButton,
  SECTION_CARD,
  SectionHead,
  Skeleton,
  opsButtonClass,
  type BadgeTone,
} from "@/components/ops-ui";
import {
  IconArrowUpRight,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconList,
  IconLock,
  IconMapPin,
  IconPhone,
  IconReceipt,
  IconWhatsApp,
  IconX,
} from "@/components/icons";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { OrderCompanionPanel } from "@/components/order-companion-panel";
import { AliclikDuplicatePanel } from "@/components/aliclik-duplicate-panel";
import { CopyButton } from "@/components/copy-button";
import { AliclikCoverageProbe } from "@/components/aliclik-coverage-probe";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { ManualRouteOutputModal } from "@/components/manual-route-output-modal";
import { OrderClosureDesk } from "@/components/order-closure-desk";
import { OrderRouteDesk } from "@/components/order-route-desk";
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
  setOlvaTracking,
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
import { VoiceAgentPanel } from "@/components/voice-agent-panel";
import { UrpiAttemptsSection } from "@/components/urpi-attempts-section";
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
  shipmentIsReturning,
  shipmentStateLabel,
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
import { aliclikDoorBan, ROUTES_STILL_ALLOWED_LABEL } from "@/lib/door-rejection";
import { outputDisplayCode } from "@/lib/shipment-output";
import { formatOlvaTracking, OLVA_TRACKING_URL } from "@/lib/olva/tracking";
import { gfDeliverySentence, gfDeliverySummary, type GfDelivery } from "@/lib/gf-delivery";
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

export type DrawerSectionId =
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

/**
 * Lo que dice el índice bajo las pestañas por cada sección. Corto a propósito:
 * el título largo ya está en la tarjeta. Una sección sin entrada aquí no sale
 * en el índice.
 */
const INDEX_LABEL: Record<string, string> = {
  resumen: "Situación",
  confirmacion: "Confirmación",
  rutas: "Mesa de ruta",
  pagos: "Cobro",
  aliclik: "Aliclik",
  guias: "Salidas y guías",
  cierre: "Cierre",
  acciones: "Gestión manual",
  cliente: "Pedido y cliente",
  ubicacion: "Ubicación",
  productos: "Productos",
  historial: "Actividad",
};

/** Las mismas de arriba, para validar la sección que llega por la URL. */
export const DRAWER_SECTION_IDS: readonly DrawerSectionId[] = [
  "resumen",
  "confirmacion",
  "ubicacion",
  "productos",
  "pagos",
  "rutas",
  "aliclik",
  "guias",
  "cierre",
  "acciones",
  "historial",
];

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

// El paso actual del recorrido lleva el tono de su macroetapa (MOM §25), con el
// mismo par de la chapa para que el número se lea: el anillo es el tono.
const DRAWER_STAGE_STEP: Record<string, string> = {
  por_confirmar: "bg-amber-100 text-amber-800 ring-2 ring-amber-500",
  preparacion: "bg-sky-100 text-sky-800 ring-2 ring-sky-500",
  por_despachar: "bg-indigo-100 text-indigo-800 ring-2 ring-indigo-500",
  en_curso: "bg-cyan-100 text-cyan-800 ring-2 ring-cyan-500",
  por_cerrar: "bg-orange-100 text-orange-800 ring-2 ring-orange-500",
  finalizado: "bg-emerald-100 text-emerald-800 ring-2 ring-emerald-500",
};

function workspaceForSection(section: DrawerSectionId): DrawerWorkspaceView {
  if (section === "ubicacion" || section === "productos") return "informacion";
  if (section === "historial") return "actividad";
  return "operar";
}

/** La chapa de la próxima acción: azul por defecto, ámbar cuando algo la frena. */
const NEXT_ACTION_BADGE: Record<DrawerNextAction["tone"], BadgeTone> = {
  indigo: "brand",
  amber: "warn",
  emerald: "brand",
  slate: "neutral",
};

/**
 * La acción dominante del drawer sigue el MOM, no el orden accidental de los
 * formularios. Debe responder una sola pregunta: «¿qué hago ahora con este
 * pedido?». Las herramientas secundarias quedan más abajo como evidencia o
 * corrección.
 */
function drawerNextAction(row: OrderMasterRow, showPayments: boolean, gfSentence: string | null = null): DrawerNextAction {
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
    // Pedido acompañante (MOM §32): su caja es la de otro pedido. No hay nada
    // que preparar aquí; mandar a «Revisar rutas» empujaba a crearle una guía.
    if (substage === "en_caja_de_otro_pedido") {
      return {
        eyebrow: "Preparación · pedido acompañante",
        title: "Viaja en la caja de otro pedido",
        description:
          "Sus productos van en la caja y la guía de su pedido principal: no necesita rótulo ni guía propia. Sigue a esa caja hasta la entrega y la liquidación.",
        cta: "Ver la caja",
        target: "guias",
        tone: "indigo",
      };
    }
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
    // Grupo GF (MOM §29.13): la tarjeta dice quién tiene el paquete y en qué
    // quedó la parada, en vez de prometer un «último estado» que no se veía.
    // Desde v1.14 la etapa ya sigue lo que reporta el motorizado.
    return {
      eyebrow: "Seguimiento",
      title: "Revisar la salida activa",
      description: gfSentence
        ? `${gfSentence}. La etapa sigue lo que reporte el motorizado; la ruta se liquida al cerrarla.`
        : "Confirma el último estado del courier y atiende cualquier intento o retorno pendiente.",
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
          <li key={stage.key} className="relative min-w-0">
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 right-1/2 top-2.5 h-px",
                  isDone || isCurrent ? "bg-ink-500" : "bg-line-strong",
                )}
              />
            )}
            {index < DRAWER_STAGE_ORDER.length - 1 && (
              <span
                aria-hidden="true"
                className={cn("absolute left-1/2 right-0 top-2.5 h-px", isDone ? "bg-ink-500" : "bg-line-strong")}
              />
            )}
            <div className="relative flex min-w-0 flex-col items-center px-0.5 text-center" aria-current={isCurrent ? "step" : undefined}>
              <span
                className={cn(
                  "relative z-[1] grid size-5 place-items-center rounded-full text-xs font-semibold tabular-nums",
                  isCurrent
                    ? (DRAWER_STAGE_STEP[stage.key] ?? "bg-line text-ink-700 ring-2 ring-ink-500")
                    : isDone
                      ? "bg-ink-900 text-white"
                      : "bg-white text-ink-500 ring-1 ring-inset ring-line-strong",
                )}
              >
                {isDone ? <IconCheck aria-hidden className="size-3" strokeWidth={2.6} /> : index + 1}
              </span>
              <span
                className={cn(
                  "mt-1.5 max-w-[6.5rem] text-xs leading-4",
                  isCurrent ? "font-semibold text-ink-900" : isDone ? "text-ink-600" : "text-ink-500",
                )}
              >
                {stage.label}
                {isDone && <span className="sr-only"> (hecho)</span>}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * La próxima acción: un título que dice qué hacer, por qué, y un solo botón.
 * La chapa dice de qué parte del recorrido sale la acción («Confirmación ·
 * último intento»); en ámbar cuando algo la frena.
 */
function DrawerNextActionCard({
  action,
  onJump,
  children,
}: {
  action: DrawerNextAction;
  onJump: (target: DrawerSectionId) => void;
  /** Lo que acompaña a la acción (el motorizado de Grupo GF), en una zona debajo. */
  children?: ReactNode;
}) {
  const cta = action.href ? (
    <Link href={action.href} className={opsButtonClass("primary", "md", "shrink-0 pointer-coarse:h-11")}>
      {action.cta}
      <IconChevronRight aria-hidden />
    </Link>
  ) : action.target ? (
    <OpsButton variant="primary" onClick={() => onJump(action.target!)} className="shrink-0 pointer-coarse:h-11">
      {action.cta}
      <IconChevronDown aria-hidden />
    </OpsButton>
  ) : null;

  return (
    // La única tarjeta con el anillo azul de 2 px: entre todas las de la ficha,
    // es la que dice qué toca ahora. Si algo la frena, pasa al ámbar de aviso.
    <section
      aria-label="Próxima acción"
      className={cn(
        "rounded-lg p-4 shadow-control sm:p-5",
        action.tone === "amber" ? "bg-warn-wash ring-1 ring-warn-bg" : "bg-white ring-2 ring-brand-600",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 className="text-base font-semibold leading-6 text-ink-900">
              <span className="sr-only">Próxima acción: </span>
              {action.title}
            </h3>
            <Badge tone={NEXT_ACTION_BADGE[action.tone]}>{action.eyebrow}</Badge>
          </div>
          <p className="mt-1 max-w-[62ch] text-sm leading-5 text-ink-600">{action.description}</p>
        </div>
        {cta}
      </div>
      {children && <div className={cn(CARD_ZONE, "mt-4 sm:mt-5")}>{children}</div>}
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
  focusSection,
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
  /** Sección a la que saltar en cuanto el pedido cargue (llega por la URL). */
  focusSection?: DrawerSectionId;
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
  const headerRef = useRef<HTMLElement>(null);
  const indexRef = useRef<HTMLDivElement>(null);
  const [indexItems, setIndexItems] = useState<{ id: string; label: string }[]>([]);
  const [currentSection, setCurrentSection] = useState<string | null>(null);

  // La altura de la cabecera fija, para que un salto deje la sección justo
  // debajo de ella. No es fija: crece con los avisos y con el índice.
  useEffect(() => {
    const header = headerRef.current;
    const sheet = scrollRef.current;
    if (!header || !sheet) return;
    const sync = () => sheet.style.setProperty("--ficha-head", `${header.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // El índice: las secciones de la pestaña abierta que están en pantalla, en el
  // orden en que SE VEN. El DOM no sirve de orden: el cobro sube o baja con
  // `order-*` según si el pago es requisito. Corre en cada render porque qué
  // secciones existen depende del pedido, del permiso y de la etapa; solo
  // escribe cuando la lista cambia.
  useLayoutEffect(() => {
    const panel = scrollRef.current?.querySelector<HTMLElement>(`#pedido-panel-${workspace}`);
    const seen = new Set<string>();
    const next = panel
      ? Array.from(panel.querySelectorAll<HTMLElement>("[data-drawer-section]"))
          .filter((el) => {
            const id = el.dataset.drawerSection ?? "";
            if (!INDEX_LABEL[id] || seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map((el) => ({ id: el.dataset.drawerSection!, label: INDEX_LABEL[el.dataset.drawerSection!]! }))
      : [];
    setIndexItems((prev) =>
      prev.length === next.length && prev.every((item, i) => item.id === next[i]!.id) ? prev : next,
    );
  });

  // Cuál se está leyendo: la última cuya tarjeta ya pasó bajo la cabecera.
  useEffect(() => {
    const sheet = scrollRef.current;
    if (!sheet || indexItems.length === 0) {
      setCurrentSection(null);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = (headerRef.current?.getBoundingClientRect().bottom ?? 0) + 32;
      let current = indexItems[0]!.id;
      for (const item of indexItems) {
        const el = sheet.querySelector<HTMLElement>(
          `#pedido-panel-${workspace} [data-drawer-section="${item.id}"]`,
        );
        if (el && el.getBoundingClientRect().top <= line) current = item.id;
      }
      // Al fondo, la última: si es corta nunca llega a pasar bajo la cabecera.
      if (sheet.scrollTop > 0 && sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 2) {
        current = indexItems[indexItems.length - 1]!.id;
      }
      setCurrentSection(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    sheet.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sheet.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [indexItems, workspace]);

  // ¿Queda índice a la derecha? Sin una señal, «Gestión manual» se escondía tras
  // el borde del teléfono y nada decía que la fila se desplaza.
  const [indexMore, setIndexMore] = useState(false);
  useEffect(() => {
    const row = indexRef.current;
    if (!row) return;
    const sync = () => setIndexMore(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    sync();
    row.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [indexItems]);

  // En el teléfono el índice se desplaza de lado: la sección actual no se sale.
  useEffect(() => {
    const row = indexRef.current;
    const item = currentSection ? row?.querySelector<HTMLElement>(`[data-index-item="${currentSection}"]`) : null;
    if (!row || !item) return;
    const left = item.offsetLeft - 8;
    const right = item.offsetLeft + item.offsetWidth + 8;
    if (left < row.scrollLeft) row.scrollTo({ left });
    else if (right > row.scrollLeft + row.clientWidth) row.scrollTo({ left: right - row.clientWidth });
  }, [currentSection]);

  /** Del índice a la sección: la lleva bajo la cabecera y le pasa el foco. */
  const goToSection = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `#pedido-panel-${workspace} [data-drawer-section="${id}"]`,
    );
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    // El foco va con la vista: con el teclado, el siguiente Tab sigue en la
    // sección elegida y no vuelve a la cabecera.
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.style.outline = "none";
    el.focus({ preventScroll: true });
    setCurrentSection(id);
  };

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

  // Cuando se llegó desde fuera pidiendo una sección —la cola de cobranza pide
  // «pagos»—, se salta a ella en cuanto el pedido carga. UNA sola vez: después
  // manda quien esté usando el drawer, no la URL con la que entró.
  const salté = useRef<string | null>(null);
  useEffect(() => {
    if (!focusSection || !detail) return;
    if (salté.current === orderId) return;
    salté.current = orderId;
    jumpTo(focusSection);
    // `jumpTo` se redefine en cada render y meterlo en las dependencias
    // relanzaría el salto contra el dedo de quien ya está mirando otra cosa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSection, detail, orderId]);

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
  // Y no a un pedido acompañante (MOM §32): ya viaja en la guía de otro, y una
  // propia sería un segundo paquete para la misma clienta.
  const aliclikOffered = Boolean(
    !detail?.companion.travelsIn &&
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
  }, [orderId, wantsBrief, detail]);
  const paymentPanel = detail
    ? orderPaymentPanelPresentation({
        operation: detail.routePlan.operation,
        currentCourier: detail.row.current_courier,
        shippingMode: detail.row.shipping_mode,
        macroSubstage: detail.row.macro_substage,
        macroReasons: detail.row.macro_reasons,
        riskRequirement: brief?.risk.requirement === "pago_completo" ? "pago_completo"
          : brief?.duplicateHold?.conflicts.length && brief.duplicateHold.resolution?.decision !== "exception"
            ? "exigir_adelanto" : brief?.risk.requirement ?? null,
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
  // La salida GF activa (o la última) para la tarjeta de acción.
  const gfActive = detail?.gfDeliveries.length ? detail.gfDeliveries[detail.gfDeliveries.length - 1]! : null;
  const nextAction = detail ? drawerNextAction(detail.row, showPaymentPanel, gfDeliverySentence(gfActive)) : null;

  // Diálogo modal: el foco entra a la hoja al abrir (sin saltar el scroll) y
  // vuelve a donde estaba al cerrar, p. ej. al pedido de la tabla del Master.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    scrollRef.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // `aria-modal` no basta: Tab se escapaba a la tabla del Master que queda
  // detrás. El foco da la vuelta dentro de la hoja. Los modales de guía viven
  // fuera de ella y llevan su propio foco.
  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !scrollRef.current) return;
    const items = Array.from(
      scrollRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getClientRects().length > 0);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === scrollRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const tabs: { id: DrawerWorkspaceView; label: string; count?: number }[] = [
    { id: "operar", label: "Operar" },
    { id: "informacion", label: "Información" },
    { id: "actividad", label: "Actividad", count: detail?.timeline.length },
  ];
  // Pestañas con flechas, Inicio y Fin (patrón ARIA): el foco se mueve y la
  // pestaña se abre en el mismo gesto.
  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex((tab) => tab.id === workspace);
    const target =
      event.key === "ArrowRight"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[tabs.length - 1]
              : null;
    if (!target) return;
    event.preventDefault();
    openWorkspace(target.id);
    document.getElementById(`pedido-tab-${target.id}`)?.focus();
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-ink-900/20" onClick={onClose}>
      <aside
        ref={scrollRef}
        tabIndex={-1}
        // La hoja recibe el foco solo para que Tab y el lector empiecen dentro;
        // no es un control, así que sin anillo.
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
        role="dialog"
        aria-modal="true"
        aria-label={`Pedido ${row?.order_name ?? ""}`}
        className="h-full w-full max-w-[880px] overflow-y-auto overscroll-contain bg-slate-50 shadow-pop"
      >
        {/* La cabecera lleva lo que hay que tener SIEMPRE a la vista (MOM §25):
            qué pedido es, en qué estado está, cuánto vale, de quién es y cómo
            llamarle. Antes había que subir hasta arriba para recordar el
            estado, y el monto quedaba enterrado entre los datos del cliente. */}
        <header ref={headerRef} className="sticky top-0 z-10 bg-white shadow-[inset_0_-1px_0_var(--color-line)]">
          <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-lg font-semibold leading-7 tabular-nums text-ink-900">
                  {row?.order_name ?? "Pedido"}
                </h2>
                {shopifyUrl && (
                  <a
                    href={shopifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir en Shopify"
                    aria-label={`Abrir ${row?.order_name ?? "pedido"} en Shopify (nueva pestaña)`}
                    className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
                  >
                    <IconArrowUpRight aria-hidden className="size-4" />
                  </a>
                )}
                {detail && (
                  <StatusBadge status={detail.row.general_status} locked={detail.row.status_locked} />
                )}
                {detail && (
                  <span className="text-sm font-semibold tabular-nums text-ink-900">
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
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-ink-500 sm:flex-nowrap">
                  <span className="shrink-0">{storeName(row.store_id)}</span>
                  {/* En el teléfono la fecha espera en Información: cada línea de
                      más en la cabecera fija es pantalla que no se usa. */}
                  <span className="hidden shrink-0 sm:inline">
                    · creado el <span className="tabular-nums">{fmtDate(row.order_created_at)}</span>
                  </span>
                  {/* En el teléfono el cliente va en su propia línea, arriba y
                      entero: detrás de la tienda se partía a media palabra. En
                      escritorio es lo que se recorta si no cabe, nunca el
                      teléfono. */}
                  {detail?.row.customer_name ? (
                    <span className="min-w-0 max-sm:order-first max-sm:basis-full sm:truncate">
                      <span aria-hidden="true" className="max-sm:hidden">· </span>
                      <span className="text-ink-700">{detail.row.customer_name}</span>
                    </span>
                  ) : null}
                  {/* El «·», el número y «Copiar» parten juntos: sueltos, el
                      número bajaba solo y el punto quedaba colgando. */}
                  {detail?.row.customer_phone && (
                    <span className="inline-flex shrink-0 items-center gap-x-1.5 whitespace-nowrap">
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums text-ink-700">{detail.row.customer_phone}</span>
                      <CopyButton
                        value={detail.row.customer_phone}
                        label="el teléfono"
                        className="justify-center pointer-coarse:size-11"
                      />
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {detail?.row.customer_phone && (
                <>
                  <a
                    href={`tel:${detail.row.customer_phone}`}
                    title="Llamar al cliente"
                    aria-label="Llamar al cliente"
                    className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:min-w-11")}
                  >
                    <IconPhone aria-hidden className="text-ink-500" />
                    <span className="hidden sm:inline">Llamar</span>
                  </a>
                  <a
                    href={`https://wa.me/${detail.row.customer_phone.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Abrir WhatsApp"
                    aria-label="Abrir WhatsApp con el cliente"
                    className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:min-w-11")}
                  >
                    <IconWhatsApp aria-hidden className="text-ink-500" />
                    <span className="hidden sm:inline">WhatsApp</span>
                  </a>
                </>
              )}
              {masterHref && (
                <a
                  href={masterHref}
                  title="Abrir en Master de Pedidos"
                  aria-label={`Abrir ${row?.order_name ?? "el pedido"} en Master de Pedidos`}
                  className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:min-w-11")}
                >
                  <IconList aria-hidden className="text-ink-500" />
                  <span className="hidden sm:inline">Master de Pedidos</span>
                </a>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar"
                className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
              >
                <IconX aria-hidden className="size-4" />
              </button>
            </div>
          </div>

          {/* Los avisos van DENTRO de la cabecera fija: un error que se pierde
              al scrollear es un error que nadie lee, y estas acciones mueven
              dinero y estados. Se quitan con su «x». */}
          {(error || notice) && detail && (
            <div className="space-y-2 px-4 pt-3 sm:px-6">
              {error && (
                <Banner tone="crit" role="alert" className="items-start">
                  <div className="flex items-start justify-between gap-3">
                    <p>{error}</p>
                    <DismissButton label="Quitar el error" onClick={() => setError(null)} />
                  </div>
                </Banner>
              )}
              {notice && (
                <Banner tone="ok" role="status">
                  <div className="flex items-start justify-between gap-3">
                    <p>{notice}</p>
                    <DismissButton label="Quitar el aviso" onClick={() => setNotice(null)} />
                  </div>
                </Banner>
              )}
            </div>
          )}

          {/* Tres espacios estables, como en Shopify: hacer el trabajo, consultar
              el pedido y auditar lo ocurrido. El equipo deja de navegar una
              lista accidental de formularios. */}
          {detail ? (
            <div className="mt-2 flex gap-6 px-4 sm:px-6" role="tablist" aria-label="Espacios del pedido">
              {tabs.map((tab) => {
                const active = workspace === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={`pedido-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`pedido-panel-${tab.id}`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => openWorkspace(tab.id)}
                    onKeyDown={onTabKey}
                    className={cn(
                      "flex min-h-12 items-center gap-2 border-b-2 text-sm font-semibold transition-colors",
                      active
                        ? "border-brand-600 text-brand-700"
                        : "border-transparent text-ink-500 hover:text-ink-900",
                    )}
                  >
                    {tab.label}
                    {tab.count != null && (
                      <Badge tone={active ? "brand" : "neutral"} className="tabular-nums">
                        {tab.count.toLocaleString("es-PE")}
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="h-3" />
          )}
          {/* EL ÍNDICE DE LA PESTAÑA. Operar llega a medir 4.000 px: sin él no
              se sabe qué secciones hay debajo ni en cuál se está. Una sola
              sección no necesita índice. */}
          {detail && indexItems.length > 1 && (
            <nav aria-label="Secciones de la pestaña" className="border-t border-line">
              <div
                ref={indexRef}
                className={cn(
                  "relative flex gap-1 overflow-x-auto px-1.5 py-2 [scrollbar-width:none] sm:px-3.5 [&::-webkit-scrollbar]:hidden",
                  indexMore && "[mask-image:linear-gradient(to_right,#000_calc(100%_-_3rem),transparent)]",
                )}
              >
                {indexItems.map((item) => {
                  const current = item.id === currentSection;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-index-item={item.id}
                      aria-current={current ? "location" : undefined}
                      onClick={() => goToSection(item.id)}
                      className={cn(
                        "h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-11",
                        current ? "bg-brand-50 text-brand-700" : "text-ink-600 hover:bg-wash hover:text-ink-900",
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </nav>
          )}
        </header>

        {!detail && error ? (
          // La carga falló: ya no queda nada que esperar. El esqueleto latiendo
          // bajo el error decía justo lo contrario —«sigo trayéndolo»— y dejaba
          // al equipo mirando una pantalla que no iba a llegar nunca. Aquí el
          // pedido no se pudo traer y lo único útil es volver a intentarlo.
          <div className="space-y-4 px-4 py-6 sm:px-6">
            <Banner tone="crit" role="alert" title="El detalle de este pedido no se pudo cargar">
              <p>{error}</p>
              <p className="mt-1">El pedido sigue en su sitio: esto es un fallo al leerlo, no un pedido perdido.</p>
            </Banner>
            <OpsButton onClick={() => void reload()} className="pointer-coarse:h-11">
              Reintentar
            </OpsButton>
          </div>
        ) : !detail ? (
          // Un "Cargando…" suelto no dice nada; un esqueleto con la forma del
          // contenido evita que la pantalla salte cuando llega.
          <div className="space-y-6 px-4 py-6 sm:px-6" aria-busy="true" aria-label="Cargando el pedido">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <div className="px-4 pb-10 pt-4 sm:px-6 sm:pt-6">
            <div
              id="pedido-panel-operar"
              role="tabpanel"
              aria-labelledby="pedido-tab-operar"
              hidden={workspace !== "operar"}
              className="flex flex-col gap-4 sm:gap-6"
            >
              <section
                data-drawer-section="resumen"
                className={cn("order-1 space-y-5", SECTION)}
              >
                {/* La macroetapa y la subetapa van EN la cabecera de la tarjeta:
                    son la respuesta a «¿dónde está?», y debajo solo queda el
                    recorrido que la ubica entre las seis. */}
                <SectionHead
                  title="Situación"
                  badge={
                    <>
                      <MacroStageBadge stage={detail.row.macro_stage} />
                      <span className="text-sm font-medium text-ink-900">
                        {macroSubstageLabel(detail.row.macro_substage)}
                      </span>
                      {/* Un motivo dice qué falta, la subetapa dice en qué punto va la
                          gestión: el pedido se ve entero sin abrir nada. En Por cerrar
                          los motivos son el trabajo mismo y los lista la mesa de cierre,
                          así que no se repiten aquí. */}
                      {detail.row.macro_stage !== "por_cerrar" &&
                        (detail.row.macro_reasons ?? []).map((reason) => (
                          <Badge key={reason} tone="warn">
                            {macroSubstageLabel(reason)}
                          </Badge>
                        ))}
                    </>
                  }
                  help={
                    <>
                      <span className="tabular-nums">{fmtAge(detail.row.macro_since ?? detail.row.status_since)}</span> en esta
                      macroetapa · fuente: {detail.row.status_source ?? "—"}
                    </>
                  }
                />

                <DrawerJourneyRail current={detail.row.macro_stage} />
              </section>
              {nextAction && workspace === "operar" && (
                <div className="order-2">
                  {/* Grupo GF: quién tiene el paquete y en qué quedó, arriba y en
                      cualquier etapa (también Por cerrar), sin bajar hasta
                      «Salidas y guías». Va DENTRO de la tarjeta de la acción, en
                      su zona: suelto debajo era una tarjeta sin título. */}
                  <DrawerNextActionCard action={nextAction} onJump={jumpTo}>
                    {gfActive && (
                      <>
                        <p className="text-[13px] font-medium text-ink-700">Motorizado Grupo GF</p>
                        <GfDeliveryLine delivery={gfActive} />
                      </>
                    )}
                  </DrawerNextActionCard>
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
                  data-drawer-section="confirmacion"
                  className={cn("order-3", SECTION)}
                >
                  <ConfirmationDesk
                    brief={brief}
                    onDuplicateChanged={() => { void reload(); onSaved(); }}
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
                    <>
                      {/* MOM §11.8: el agente de voz llama a estos pedidos. */}
                      <VoiceAgentPanel orderId={orderId} pending={pending} run={run} />
                      <DescartarRecuperacion
                        pending={pending}
                        onDiscard={(motivo) => run(() => descartarRecuperacion(orderId, motivo))}
                      />
                    </>
                  )}
                </div>
              )}
              <div
                data-drawer-section="rutas"
                className={cn("order-4", SECTION)}
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
                data-drawer-section="guias"
                className={cn("order-6 space-y-4", SECTION)}
              >
                <SectionHead
                  title="Salidas y guías"
                  badge={<Badge className="tabular-nums">{detail.guides.length}</Badge>}
                  help="Cada salida conserva su courier, rótulo, QR y resultado independiente."
                />
                {detail.guides.length === 0 ? (
                  detail.companion.travelsIn ? null : (
                    <p className="text-sm text-ink-500">
                      Sin gestión logística registrada todavía.
                    </p>
                  )
                ) : (
                  // Filas de borde a borde, con la hairline de la tarjeta: un marco
                  // dentro de la tarjeta sería una tarjeta dentro de otra.
                  <ul className="-mx-4 divide-y divide-line sm:-mx-5 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0">
                    {detail.guides.map((g) => {
                      const estado = {
                        deliveryStatus: g.delivery_status,
                        custodyState: g.custody_state,
                        pickupState: g.pickup_state,
                        courier: g.courier,
                        swaypState: g.swayp_state ?? null,
                        reportedStatus: g.reported_status ?? null,
                      };
                      const gf = detail.gfDeliveries.find((d) => d.shipmentId === g.id);
                      return (
                      <li key={g.id} className="space-y-2.5 px-4 py-3 sm:px-5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                          <span className="text-sm font-semibold capitalize text-ink-900">{g.courier}</span>
                          <span className="font-mono text-xs text-ink-600">
                            {outputDisplayCode(g.output_code, g.courier) || g.guide_code}
                          </span>
                          {/* El número con el que el COURIER conoce el envío.
                              Estaba escondido: en cuanto la salida tenía código
                              interno, `outputDisplayCode` ganaba y el `guide_code`
                              no se pintaba nunca. Es justo el dato que hay que
                              teclear en el panel del courier para buscarla, y el
                              que el rótulo de Shalom titula «N° de Orden». */}
                          {g.guide_code && outputDisplayCode(g.output_code, g.courier) && (
                            <span className="select-all font-mono text-xs font-semibold text-ink-900">
                              N° {g.guide_code}
                            </span>
                          )}
                          {/* Shalom muestra en su panel el nº de orden Y un código
                              corto. Sin el corto hay que abrir cada envío allá para
                              saber cuál es cuál. */}
                          {g.shalom_codigo && (
                            <span className="rounded bg-wash px-1.5 py-0.5 font-mono text-xs font-medium text-ink-700 ring-1 ring-inset ring-line">
                              {g.shalom_codigo}
                            </span>
                          )}
                          <Badge tone={shipmentIsReturning(estado) ? "warn" : "neutral"}>
                            {shipmentStateLabel(estado)}
                          </Badge>
                          {(g.aliclik_attempts ?? g.reroute_attempts) > 0 && (
                            <span className="text-[13px] font-medium tabular-nums text-warn-fg">
                              {g.aliclik_attempts ?? g.reroute_attempts} intento(s)
                            </span>
                          )}
                          {g.guide_code === detail.row.guide_code && (
                            <span className="ml-auto text-[13px] text-ink-500">Guía actual</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
                              className={DOC_LINK}
                            >
                              Rótulo
                              <IconArrowUpRight aria-hidden className="size-3.5" />
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
                              className={DOC_LINK}
                            >
                              Guía combinada
                              <IconArrowUpRight aria-hidden className="size-3.5" />
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
                              <a href={`/api/shalom/rotulo/${g.id}`} target="_blank" rel="noreferrer" className={DOC_LINK}>
                                Rótulo
                                <IconArrowUpRight aria-hidden className="size-3.5" />
                              </a>
                              {/* El suelto se conserva a un clic de distancia: si la
                                  composición falla, el mostrador de Shalom sigue
                                  necesitando su papel. */}
                              <a href={`/api/shalom/label/${g.id}`} target="_blank" rel="noreferrer" className={DOC_LINK_QUIET}>
                                Solo Shalom
                              </a>
                              {/* El «Ticket Shalom», el recibo de tira del
                                  mostrador. No es el rótulo: es el otro papel, el
                                  que hasta ahora había que bajar a mano de
                                  pro.shalom.pe envío por envío. */}
                              <a href={`/api/shalom/ticket/${g.id}`} target="_blank" rel="noreferrer" className={DOC_LINK_QUIET}>
                                Ticket
                              </a>
                            </>
                          )}
                          {g.qr_token && (
                            <a href={`/api/pedidos/rotulos?ids=${g.id}`} target="_blank" rel="noreferrer" className={DOC_LINK}>
                              Rótulo interno
                              <IconArrowUpRight aria-hidden className="size-3.5" />
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
                          {/* El número con el que Olva conoce el envío, y con el
                              que Kapta le pregunta el estado cada media hora (§12).
                              Llega por correo después de crear la salida, así que
                              se registra —o se corrige— desde aquí. */}
                          {canEdit && g.courier.trim().toLowerCase() === "olva" && (
                            <OlvaTrackingField
                              shipmentId={g.id}
                              current={
                                g.olva_tracking && g.olva_emision
                                  ? formatOlvaTracking({ tracking: g.olva_tracking, emision: g.olva_emision })
                                  : null
                              }
                              rawStatus={g.olva_status ?? null}
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
                        </div>
                        {/* Grupo GF: quién tiene el paquete y en qué quedó la parada. */}
                        {gf ? <GfDeliveryLine delivery={gf} /> : null}
                      </li>
                      );
                    })}
                  </ul>
                )}
                {/* Pedido acompañante (MOM §32): en qué caja viaja este pedido, o
                    qué lleva en las suyas y cuánto debe cobrar la guía. */}
                <OrderCompanionPanel
                  orderId={orderId}
                  orderName={detail.row.order_name}
                  orderTotal={detail.row.order_total}
                  companion={detail.companion}
                  canEdit={canEdit}
                  // Solo donde el pedido todavía espera salir: un pedido ya en
                  // curso o entregado salió en su propia caja, y ofrecérselo en
                  // todos sería ruido. El servidor vuelve a comprobar la regla.
                  canBeCompanion={
                    (detail.row.macro_stage === "por_confirmar" || detail.row.macro_stage === "preparacion") &&
                    !detail.guides.some(
                      (g) => (g.delivery_status === "pendiente" || g.delivery_status === "en_ruta") && !g.returned_at,
                    )
                  }
                  pending={pending}
                  run={run}
                />
                {/* El cobro del courier lo confirma una PERSONA en Validar
                    pagos: el lector de imágenes prepara la ficha, pero valida una
                    imagen, no un depósito. Desde acá se llega de un clic en vez
                    de buscar el pedido en la otra pantalla. */}
                {detail.row.payment_check_state && (
                  <p className="text-[13px] leading-5 text-ink-500">
                    Cobro del courier:{" "}
                    <strong className="font-semibold text-ink-900">
                      {PAYMENT_CHECK_OPTIONS.find((o) => o.value === detail.row.payment_check_state)
                        ?.label ?? detail.row.payment_check_state}
                    </strong>
                    .{" "}
                    <a href="/dashboard/pagos" target="_blank" rel="noreferrer" className={DOC_LINK}>
                      Confirmarlo en Validar pagos
                      <IconArrowUpRight aria-hidden className="size-3.5" />
                    </a>
                  </p>
                )}
                {detail.guides.some((guide) => guide.courier === "shalom") && (
                  <ShalomPickupKeyPanel orderId={orderId} onChanged={onSaved} />
                )}
              </section>
              {["por_cerrar", "finalizado"].includes(detail.row.macro_stage ?? "") && (
                <div
                  data-drawer-section="cierre"
                  className={cn("order-7", SECTION)}
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
              {/* Agencia o una regla de riesgo ponen el pago antes que la ruta.
                  Provincia COD puede salir contra entrega, así que conserva la
                  Mesa de ruta primero y deja el pago anticipado como herramienta
                  opcional debajo. Sigue disponible antes de crear Shalom para no
                  reconstruir el antiguo callejón circular guía ↔ adelanto. */}
              {showPaymentPanel && paymentPanel && (
                <div
                  data-drawer-section="pagos"
                  className={cn(SECTION, paymentPanel.mode === "required" ? "order-3" : "order-5")}
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
                  data-drawer-section="aliclik"
                  className={cn("order-5", SECTION)}
                >
                  <AliclikGuidePanel
                    orderId={orderId}
                    hasCoordinate={detail.row.latitude != null && detail.row.longitude != null}
                    health={detail.aliclikHealth}
                    riskRequirement={brief?.risk.requirement ?? "ninguno"}
                    paymentState={detail.row.payment_state}
                    riskReasons={brief?.risk.reasons ?? []}
                    duplicateHold={brief?.duplicateHold}
                    onDuplicateChanged={() => { void reload(); onSaved(); }}
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
                  data-drawer-section="aliclik"
                  className={cn("order-5 space-y-4", SECTION)}
                >
                  <SectionHead
                    title="Aliclik"
                    help="Aliclik no atiende pedidos de Agencia; este va con Shalom u Olva. Si la dirección está mal clasificada, corrígela y la cobertura se recalcula sola. Y si la dirección está bien pero crees que Aliclik sí llega, pregúntaselo: cotizar no crea nada."
                  />
                  <OpsButton size="sm" onClick={() => jumpTo("ubicacion")} className="pointer-coarse:h-11">
                    Revisar ubicación y cobertura
                    <IconChevronDown aria-hidden className="text-ink-500" />
                  </OpsButton>
                  <AliclikCoverageProbe
                    orderId={detail.row.order_id}
                    district={detail.row.district}
                    canMark={canCreateGuide}
                  />
                </div>
              )}
              {canEdit ? (
                <div data-drawer-section="acciones" className={cn("order-8", SECTION)}>
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
                <div className={cn("order-8", SECTION)}>
                  <div className="flex items-start gap-3">
                    <IconLock aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-500" />
                    <div>
                      <p className="text-sm font-semibold text-ink-900">Solo lectura</p>
                      <p className="mt-0.5 text-[13px] leading-5 text-ink-600">
                        Tu rol permite consultar el pedido, sus comentarios y su historial, pero no modificarlo.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div
              id="pedido-panel-informacion"
              role="tabpanel"
              aria-labelledby="pedido-tab-informacion"
              hidden={workspace !== "informacion"}
              className="flex flex-col gap-4 sm:gap-6"
            >
              <section
                data-drawer-section="cliente"
                className={cn("order-1 space-y-4", SECTION)}
              >
                {/* La cobertura vive en la cabecera fija. Repetirla aquí, a dos
                    dedos y en la misma pantalla, sugería que eran dos datos
                    distintos. La de «Ubicación y cobertura» sí se queda: ahí es
                    el sujeto de la sección y lo que se corrige. */}
                <SectionHead
                  title="Pedido y cliente"
                  help="Datos comerciales sincronizados desde Shopify y contexto operativo de Kapta."
                />
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                  <Field label="Cliente" value={detail.row.customer_name} />
                  <Field label="Teléfono" value={detail.row.customer_phone} numeric />
                  <Field
                    label="Modalidad"
                    value={
                      detail.row.shipping_mode
                        ? (MODE_LABEL[detail.row.shipping_mode] ?? detail.row.shipping_mode)
                        : null
                    }
                  />
                  <Field label="Monto" value={fmtMoney(detail.row.order_total)} numeric />
                  <Field label="Tienda" value={storeName(detail.row.store_id)} />
                  <Field label="Creado" value={fmtDateTime(detail.row.order_created_at)} numeric />
                  <Field label="Courier actual" value={detail.row.current_courier} capitalize />
                  <Field label="Guía actual" value={detail.row.guide_code} mono />
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
                      <div className="min-w-0">
                        <dt className={FIELD_LABEL}>Días en agencia</dt>
                        <dd className={FIELD_VALUE}>
                          <AgencyDays
                            arrivedAt={detail.row.agency_arrived_at}
                            expiresAt={detail.row.agency_expires_at}
                          />
                        </dd>
                      </div>
                    </>
                  )}
                  <div className="min-w-0">
                    <dt className={FIELD_LABEL}>Pago / clave</dt>
                    <dd className={FIELD_VALUE}>
                      <PaymentIndicator
                        paymentState={detail.row.payment_state}
                        keyState={detail.row.key_state}
                      />
                    </dd>
                  </div>
                  <Field label="Costo logístico" value={fmtMoney(detail.row.logistics_cost)} numeric />
                </dl>

                {/* LA NOTA DEL PEDIDO, tal como se escribió en Shopify.
                    Va FUERA de la rejilla y a ancho completo porque es texto libre
                    y de largo imprevisible: como un campo más de cuatro columnas se
                    cortaría justo donde está el dato. `whitespace-pre-wrap` respeta
                    los saltos de línea que puso quien la escribió.
                    Solo aparece si hay nota: un bloque vacío enseñaría un hueco
                    permanente en todos los pedidos que no la usan. */}
                {detail.shopifyNote && (
                  <Banner tone="warn" title="Nota del pedido">
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-900">{detail.shopifyNote}</p>
                  </Banner>
                )}
              </section>
              <div data-drawer-section="ubicacion" className={cn("order-2", SECTION)}>
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
                  data-drawer-section="productos"
                  className={cn("order-3 space-y-4", SECTION)}
                >
                  <SectionHead
                    title="Productos"
                    badge={
                      <Badge className="tabular-nums">
                        {detail.lineItems.length} {detail.lineItems.length === 1 ? "producto" : "productos"}
                      </Badge>
                    }
                  />
                  <OrderLineItems items={detail.lineItems} totals={detail.totals} />
                </section>
              )}
            </div>
            <div
              id="pedido-panel-actividad"
              role="tabpanel"
              aria-labelledby="pedido-tab-actividad"
              hidden={workspace !== "actividad"}
              className="flex flex-col gap-4 sm:gap-6"
            >
              <UrpiAttemptsSection orderId={orderId} className={cn("order-1", SECTION)} />
              <section
                data-drawer-section="historial"
                className={cn("order-1 space-y-5", SECTION)}
              >
                <SectionHead
                  title="Actividad y auditoría"
                  badge={<Badge>Solo lectura</Badge>}
                  help={`${detail.timeline.length} movimiento${detail.timeline.length === 1 ? "" : "s"} · se conserva indefinidamente`}
                />
                {detail.timeline.length === 0 ? (
                  <p className="text-sm text-ink-500">Sin movimientos registrados.</p>
                ) : (
                  <ol className="relative space-y-5 pl-6 before:absolute before:bottom-1 before:left-[5px] before:top-1.5 before:w-px before:bg-line-strong">
                    {detail.timeline.map((t) => (
                      <li key={t.id} className="relative">
                        {/* El punto dice de qué parte del recorrido es el hecho
                            (los tonos de macroetapa del MOM); el texto lo dice
                            igual, así que el color nunca es la única señal. */}
                        <span
                          aria-hidden
                          className={cn(
                            "absolute -left-6 top-1.5 size-[11px] rounded-full ring-[3px] ring-white",
                            t.origin === "leads"
                              ? "bg-ink-700"
                              : /payment|liquidation|entregado/.test(t.kind)
                                ? "bg-emerald-500"
                              : /return|refund|merma|anulado/.test(t.kind)
                                ? "bg-orange-500"
                                : /guide|dispatch|route|custody/.test(t.kind)
                                  ? "bg-indigo-500"
                                  : "bg-ink-300",
                          )}
                        />
                        <p className="text-sm font-medium leading-5 text-ink-900">
                          {TIMELINE_LABEL[t.kind] ?? t.kind}
                          {/* El resultado va pegado al título, no en la línea de
                              la nota: la nota es opcional y sin esto dos
                              resultados distintos se leían idénticos. */}
                          {t.confirmation?.result && (
                            <span className="font-normal text-ink-600">
                              {" "}· {confirmationResultLabel(t.confirmation.result)}
                            </span>
                          )}
                          {(t.statusLabel ?? (t.newStatus ? generalLabel(t.newStatus) : null)) && (
                            <span className="font-normal text-ink-600">
                              {" "}→ {t.statusLabel ?? generalLabel(t.newStatus!)}
                            </span>
                          )}
                        </p>
                        {(t.note || t.reason) && (
                          <p className="mt-0.5 max-w-[68ch] text-sm leading-5 text-ink-700">{t.note ?? t.reason}</p>
                        )}
                        <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
                          <span className="tabular-nums">{fmtDateTime(t.occurredAt)}</span>
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
              </section>
            </div>
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

// ---------------------------------------------------------------------------
// Piezas de la ficha (mundo de operación, DESIGN.md)
// ---------------------------------------------------------------------------

/**
 * Cada sección de la ficha es una tarjeta sobre el lienzo (`SECTION_CARD`). Un
 * salto a ella deja su borde de arriba justo bajo la cabecera fija, mida lo que
 * mida (crece con los avisos y con el índice): `--ficha-head` lo pone la hoja.
 */
const SECTION = cn(SECTION_CARD, "scroll-mt-[calc(var(--ficha-head,9rem)_+_1rem)]");
const FIELD_LABEL = "text-[13px] leading-5 text-ink-500";
const FIELD_VALUE = "mt-0.5 break-words text-sm leading-5 text-ink-900";
/** Etiqueta de un campo de formulario. */
const LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";
const TEXTAREA = cn(FIELD, "h-auto py-2 leading-5");
/** Enlace a un papel o a otra pantalla (abre en otra pestaña). */
const DOC_LINK =
  "inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11";
const DOC_LINK_QUIET =
  "inline-flex items-center text-[13px] text-ink-600 underline-offset-2 hover:text-ink-900 hover:underline pointer-coarse:min-h-11";

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="-my-1 -mr-1 grid size-6 shrink-0 place-items-center rounded text-ink-500 transition-colors hover:bg-white/70 hover:text-ink-900 pointer-coarse:size-11"
    >
      <IconX aria-hidden className="size-3.5" />
    </button>
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
    <section className="space-y-4">
      <SectionHead
        title="Ubicación y cobertura"
        badge={
          <>
            <CoverageBadge coverage={row.coverage} />
            {row.geo_source && <Badge>{GEO_SOURCE_LABEL[row.geo_source] ?? row.geo_source}</Badge>}
          </>
        }
        aside={
          <>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className={DOC_LINK}>
                <IconMapPin aria-hidden className="size-3.5" />
                Ver mapa
              </a>
            )}
            {canEdit && !editing && (
              <OpsButton size="sm" onClick={open} className="pointer-coarse:h-11">
                {hasOverride ? "Editar corrección" : "Corregir ubicación"}
              </OpsButton>
            )}
          </>
        }
      />

      {message && (
        <p role="status" className="rounded-lg bg-wash px-4 py-2.5 text-sm text-ink-700">
          {message}
        </p>
      )}

      {(row.coverage ?? "por_revisar") === "por_revisar" && !editing && (
        <Banner tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Completa la región y el distrito para asignar el flujo correcto.</p>
            {canEdit && (
              <OpsButton size="sm" onClick={open} className="pointer-coarse:h-11">
                Completar
              </OpsButton>
            )}
          </div>
        </Banner>
      )}

      {!editing ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <Field label="Región" value={row.region} />
          <Field label="Provincia" value={row.province} />
          <Field label="Distrito" value={row.district} />
          <Field label="Dirección" value={row.address} />
          <Field label="Referencia" value={row.reference} />
          <Field
            label="Coordenadas"
            numeric
            value={
              row.latitude != null && row.longitude != null
                ? `${row.latitude}, ${row.longitude}`
                : null
            }
          />
        </dl>
      ) : (
        <form
          className={cn(CARD_ZONE, "space-y-4")}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <p className="max-w-[68ch] text-[13px] leading-5 text-ink-500">
            Deja en blanco lo que no quieras cambiar. Esta corrección gana sobre Shopify, sobre los
            reportes de los couriers y sobre el ubigeo, y no se pierde al sincronizar.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
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
          <div className="grid gap-3 sm:grid-cols-2">
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
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledInput
              label="Latitud"
              value={form.latitude}
              placeholder="-12.0464"
              inputMode="decimal"
              onChange={(latitude) => set({ latitude })}
            />
            <LabeledInput
              label="Longitud"
              value={form.longitude}
              placeholder="-77.0428"
              inputMode="decimal"
              onChange={(longitude) => set({ longitude })}
            />
          </div>
          <LabeledInput
            label="Motivo / nota"
            value={form.note}
            onChange={(note) => set({ note })}
          />
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-ink-700 pointer-coarse:min-h-11">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className={CHECKBOX}
            />
            Recordar esta provincia para los próximos pedidos del mismo distrito
          </label>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <OpsButton type="submit" variant="primary" disabled={pending} className="pointer-coarse:h-11">
              {pending ? "Guardando…" : "Guardar ubicación"}
            </OpsButton>
            <OpsButton disabled={pending} onClick={() => setEditing(false)} className="pointer-coarse:h-11">
              Cancelar
            </OpsButton>
            {hasOverride && (
              <OpsButton variant="ghost" size="sm" disabled={pending} onClick={clear} className="ml-auto pointer-coarse:h-11">
                Quitar corrección y volver al origen
              </OpsButton>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  inputMode,
  onChange,
}: {
  label: string;
  value: string | number | null | undefined;
  placeholder?: string;
  inputMode?: "decimal";
  onChange: (next: string) => void;
}) {
  return (
    <label className={LABEL}>
      {label}
      <input
        value={value ?? ""}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD, "font-normal pointer-coarse:h-11", inputMode && "tabular-nums")}
      />
    </label>
  );
}

function Field({
  label,
  value,
  numeric,
  capitalize,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  numeric?: boolean;
  capitalize?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className={FIELD_LABEL}>{label}</dt>
      <dd
        className={cn(
          FIELD_VALUE,
          numeric && "tabular-nums",
          capitalize && "capitalize",
          mono && "font-mono text-[13px]",
          !value && "text-ink-500",
        )}
      >
        {value || "—"}
      </dd>
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
const REQUIREMENT_TONE: Record<PaymentRequirement, "neutral" | "warn" | "crit"> = {
  ninguno: "neutral",
  sugerir_adelanto: "warn",
  exigir_adelanto: "warn",
  pago_completo: "crit",
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
    <li className="px-4 py-2.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs font-semibold text-ink-900">
          {row.order_name ?? row.order_id}
        </span>
        <span className="text-xs tabular-nums text-ink-500">
          {fmtDate(row.order_created_at)} · {fmtAge(row.order_created_at)}
        </span>
        {/* El pedido abierto que se mira puede ser el MÁS VIEJO del teléfono: sin
            esta marca, un re-pedido posterior se lee como antecedente previo. */}
        {later && <Badge tone="info">posterior a este</Badge>}
        {/* Dicho en una chapa y no solo en color: en el teléfono la línea de
            productos se recorta y el aviso se perdía. */}
        {repeats && <Badge tone="warn">lo mismo que este pedido</Badge>}
        <Badge
          className="ml-auto"
          tone={outcome === "entregado" ? "ok" : outcome === "anulado" || outcome === "devuelto" ? "crit" : "neutral"}
        >
          {row.operational_status ? operationalLabel(row.operational_status) : PRIOR_OUTCOME_LABEL[outcome]}
        </Badge>
      </div>

      {row.products && (
        <p
          className={cn(
            "mt-1 truncate text-[13px] leading-5",
            repeats ? "font-semibold text-warn-fg" : "text-ink-700",
          )}
          title={row.products}
        >
          {row.products}
        </p>
      )}

      {/* Nueve de cada diez anulados nunca llegaron a despacharse. Decirlo evita
          exigir pago completo por antecedentes que no costaron un solo flete. */}
      <p className="mt-0.5 text-xs leading-4 text-ink-500">
        {dispatch === "nunca_despachado" ? (
          <span className="font-medium text-ink-700">{DISPATCH_STATE_LABEL.nunca_despachado}</span>
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

function ConfirmationBrief({ brief, orderId, onDuplicateChanged }: {
  brief: OrderConfirmationBrief; orderId: string; onDuplicateChanged: () => void;
}) {
  const { counts, risk, duplicates, codCouriers, priors, orderCreatedAt, products, doorRejections } =
    brief;
  const doorBan = doorRejections === null ? null : aliclikDoorBan(doorRejections);
  const known = priors.length;
  const later = countLaterOrders(priors, orderCreatedAt);
  const outcomes = (Object.keys(PRIOR_OUTCOME_LABEL) as PriorOutcome[]).filter(
    (key) => counts[key] > 0,
  );

  return (
    <div className={cn(CARD_ZONE, "space-y-3")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-ink-900">Antes de llamar</h4>
        <span className="text-[13px] text-ink-500">
          {known === 0
            ? "Sin otros pedidos con este teléfono"
            : `${known} pedido${known === 1 ? "" : "s"} más con este teléfono` +
              (later > 0 ? ` · ${later} posterior${later === 1 ? "" : "es"} a este` : "")}
        </span>
      </div>

      {/* EL RECHAZO EN LA PUERTA VA PRIMERO, ARRIBA DE TODO.
          Es la única regla de esta ficha que no se puede exceptuar, así que se
          lee antes que el desglose y antes que la escalera de adelanto: quien
          llama tiene que saber que esta guía no va a salir por Aliclik ANTES de
          prometerle al cliente una fecha. Ver lib/door-rejection.ts. */}
      {doorBan?.banned && (
        <Banner
          tone="crit"
          role="alert"
          title={`Aliclik cerrado para este cliente · ${doorBan.rejections} rechazos en la puerta`}
        >
          Ya tuvo el producto en la mano y lo devolvió {doorBan.rejections} veces. No se puede
          exceptuar. Despáchalo por {ROUTES_STILL_ALLOWED_LABEL}.
        </Banner>
      )}
      {doorRejections === null && (
        <p className="rounded-lg bg-wash px-4 py-2.5 text-[13px] leading-5 text-ink-700">
          No se pudo verificar si este cliente tiene rechazos en la puerta. Vuelve a abrir el
          pedido antes de crear una guía Aliclik.
        </p>
      )}

      {/* El desglose por desenlace, que es lo que la columna «Métricas» resume a
          mano. Los entregados van primero y bien visibles: son el argumento de
          quien decida saltarse la regla del §8 con justificación. */}
      {outcomes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {outcomes.map((key) => (
            <Badge
              key={key}
              className="tabular-nums"
              tone={key === "entregado" ? "ok" : key === "anulado" || key === "devuelto" ? "crit" : "neutral"}
            >
              {PRIOR_OUTCOME_LABEL[key]}: {counts[key]}
            </Badge>
          ))}
        </div>
      )}

      <AliclikDuplicatePanel key={orderId} orderId={orderId} initialHold={brief.duplicateHold} onChanged={onDuplicateChanged} />

      {(risk.requirement !== "ninguno" || (brief.duplicateHold?.allowed && !brief.duplicateHold.conflicts.length)) && (
        <RequirementNote tone={REQUIREMENT_TONE[risk.requirement]}>
          <p className="font-semibold text-ink-900">
            {PAYMENT_REQUIREMENT_LABEL[risk.requirement]}
            {risk.antecedents > 0 && (
              <span className="font-normal text-ink-700">
                {" "}
                · {risk.antecedents} antecedente{risk.antecedents === 1 ? "" : "s"} de rechazo o
                devolución
              </span>
            )}
          </p>
          {risk.reasons.length > 0 && <p className="mt-0.5">{risk.reasons.join(" ")}</p>}
        </RequirementNote>
      )}

      {/* Un duplicado no visto termina en dos paquetes al mismo destino, y el
          flete de uno se pierde. Se listan con nombre y fecha: la decisión es
          humana, la herramienta solo se asegura de que los vea. */}
      {duplicates.length > 0 && !brief.duplicateHold?.conflicts.length && (
        <Banner
          tone="warn"
          title={`${duplicates.length} pedido${duplicates.length === 1 ? "" : "s"} abierto${duplicates.length === 1 ? "" : "s"} del mismo teléfono`}
        >
          <ul className="mt-1 space-y-0.5">
            {duplicates.slice(0, 5).map((row) => (
              <li key={row.order_id} className="tabular-nums">
                <span className="font-mono font-semibold text-ink-900">{row.order_name ?? row.order_id}</span>
                {row.order_created_at ? ` · ${fmtDate(row.order_created_at)}` : ""}
                {row.order_total != null ? ` · ${fmtMoney(row.order_total)}` : ""}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/* El historial pedido a pedido. El desglose de arriba dice CUÁNTOS; esto
          dice cuáles, cuándo y si alguno llegó a salir — que es de donde sale la
          decisión real, y lo que antes había que ir a buscar a Shopify y a
          Aliclik por separado. */}
      {priors.length > 0 && (
        <details className="group" open={priors.length <= 4}>
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-700 hover:text-ink-900 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <IconChevronRight aria-hidden className="size-4 text-ink-500 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
            Historial del cliente
            <span className="font-normal text-ink-500 group-open:hidden">(ver los {priors.length})</span>
          </summary>
          <ul className="-mx-4 mt-2 divide-y divide-line border-y border-line sm:-mx-5">
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
            <p className="mt-1.5 text-xs text-ink-500">
              y {priors.length - 10} más, no mostrados
            </p>
          )}
        </details>
      )}

      {/* La pregunta de la llamada es «¿sale por Aliclik o va a agencia?». Sale
          de la misma matriz de tarifas que ya clasifica la cobertura, así que no
          puede contradecir lo que dice la cabecera del pedido. */}
      <p className="text-[13px] leading-5 text-ink-500">
        Cobertura COD:{" "}
        {codCouriers.length > 0 ? (
          <span className="font-medium text-ink-900">{codCouriers.join(" · ")}</span>
        ) : (
          <span>sin courier COD con tarifa para este destino; va por agencia</span>
        )}
      </p>
    </div>
  );
}

/** La escalera de adelanto del §8: en neutro, ámbar o crítico según lo que exige. */
function RequirementNote({ tone, children }: { tone: "neutral" | "warn" | "crit"; children: ReactNode }) {
  if (tone === "neutral") {
    return <div className="rounded-lg bg-wash px-4 py-3 text-[13px] leading-5 text-ink-700">{children}</div>;
  }
  return (
    <Banner tone={tone} className="text-[13px] leading-5">
      {children}
    </Banner>
  );
}

function ConfirmationDesk({
  brief,
  onDuplicateChanged,
  row,
  tasks,
  shopifyUrl,
  timeline,
  pending,
  onAttempt,
}: {
  brief: OrderConfirmationBrief | null;
  onDuplicateChanged: () => void;
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
    <section className="space-y-4">
      <SectionHead
        title="Gestión de confirmación"
        badge={
          <Badge tone={lastAttempt ? "warn" : "neutral"} className="tabular-nums">
            Día {used} de {CONFIRMATION_MAX_DAYS}
          </Badge>
        }
        help="Un registro por intento. Llamada, WhatsApp y mensaje del mismo día cuentan como un solo día de gestión."
      />

      {used > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Días con gestión">
          {days.map((day) => (
            <Badge key={day} className="tabular-nums">
              {day.slice(5).split("-").reverse().join("/")}
            </Badge>
          ))}
        </div>
      )}

      {lastAttempt && (
        <Banner tone="warn" title="Último intento completado">
          <p>
            Se agotaron los {CONFIRMATION_MAX_DAYS} días de gestión. Kapta no anula automáticamente.
          </p>
          {cancellationTask && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span>
                Tarea asignada a {cancellationTask.assignedName ?? "la última persona que gestionó"}.
              </span>
              {shopifyUrl && (
                <a
                  href={shopifyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}
                >
                  Revisar en Shopify
                  <IconArrowUpRight aria-hidden className="text-ink-500" />
                </a>
              )}
            </div>
          )}
        </Banner>
      )}

      {row.macro_substage === "historico_sin_gestion" && (
        <p className="rounded-lg bg-wash px-4 py-2.5 text-[13px] leading-5 text-ink-700">
          Pedido anterior al corte operativo del 01/06/2026. Se conserva en el historial y no
          cuenta como trabajo nuevo de Sin llamar.
        </p>
      )}

      {row.confirmation_next_contact_on && (
        <Banner
          tone={followupBucket === "vencido" ? "crit" : followupBucket === "hoy" ? "warn" : "info"}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="font-semibold text-ink-900">
              {followupBucket === "vencido"
                ? "Contacto vencido"
                : followupBucket === "hoy"
                  ? "Contactar hoy"
                  : "Próximo contacto"}
            </strong>
            <span className="tabular-nums">{fmtDate(`${row.confirmation_next_contact_on}T12:00:00.000Z`)}</span>
          </div>
        </Banner>
      )}

      {/* El ciclo automático: sin fecha pactada el pedido igual vuelve a la cola.
          Se anuncia aquí para que quien abra el pedido sepa que lo trajo el
          ciclo y no un compromiso con el cliente. */}
      {!row.confirmation_next_contact_on && row.confirmation_cycle_due_on && !lastAttempt && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-wash px-4 py-2.5 text-[13px] text-ink-700">
          <strong className="font-semibold text-ink-900">
            {row.confirmation_cycle_due_on <= today
              ? "Toca hoy por ciclo automático"
              : "Vuelve a la cola por ciclo automático"}
          </strong>
          <span className="tabular-nums">
            {row.confirmation_cycle_due_on <= today
              ? "Sin fecha pactada"
              : fmtDate(`${row.confirmation_cycle_due_on}T12:00:00.000Z`)}
          </span>
        </div>
      )}

      {reminderTask?.dueAt && !lastAttempt && (
        <p className="text-[13px] text-ink-500">
          Recordatorio de confirmación: <span className="tabular-nums">{fmtDateTime(reminderTask.dueAt)}</span>.
        </p>
      )}

      {brief && <ConfirmationBrief brief={brief} orderId={row.order_id} onDuplicateChanged={onDuplicateChanged} />}

      {/* Sin <form> a propósito: un Enter suelto en la fecha no debe gastar un
          día de gestión. El intento se registra solo con el botón. */}
      <div className={cn(CARD_ZONE, "space-y-4")}>
        <h4 className="text-sm font-semibold text-ink-900">Registrar intento</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={LABEL}>
            Canal
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className={cn(FIELD, "font-normal pointer-coarse:h-11")}
            >
              {CONFIRMATION_CHANNELS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Resultado
            <select
              value={result}
              onChange={(e) => setResult(e.target.value)}
              className={cn(FIELD, "font-normal pointer-coarse:h-11")}
            >
              {CONFIRMATION_RESULTS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {selected && <p className="-mt-1 text-[13px] leading-5 text-ink-500">{selected.hint}</p>}

        {needsDate && (
          <label className={cn(LABEL, "sm:w-56")}>
            Próximo contacto
            <input
              type="date"
              value={nextContactOn}
              min={today}
              onChange={(e) => setNextContactOn(e.target.value)}
              className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
            />
          </label>
        )}

        <label className={LABEL}>
          Qué dijo el cliente
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Opcional"
            className={cn(TEXTAREA, "font-normal")}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <OpsButton
            variant="primary"
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
            className="pointer-coarse:h-11"
          >
            Registrar intento
          </OpsButton>
          <span className="text-[13px] text-ink-500">
            {opensNewDay
              ? `Abre el día ${projected} de ${CONFIRMATION_MAX_DAYS}.`
              : "Ya hay gestión de hoy: no consume otro día."}
          </span>
        </div>
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
    <section className="space-y-5">
      <SectionHead
        title="Gestión manual"
        help="Registra el resultado operativo o deja una nota. Las correcciones excepcionales están separadas al final."
      />
      <div className={cn(CARD_ZONE, "space-y-3")}>
        <h4 className="text-sm font-semibold text-ink-900">Registrar estado</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={LABEL}>
            Estado
            <select
              value={general}
              onChange={(e) => setGeneral(e.target.value as GeneralStatus)}
              className={cn(FIELD, "font-normal pointer-coarse:h-11")}
            >
              {GENERAL_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Detalle
            <select
              value={operational}
              onChange={(e) => setOperational(e.target.value)}
              className={cn(FIELD, "font-normal pointer-coarse:h-11")}
            >
              {options.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {changingClosed && (
          <Banner tone="warn">
            Este pedido ya está {generalLabel(row.general_status).toLowerCase()}. Cambiarlo exige un
            motivo y queda registrado en el historial
            {!canOverride && "; tu rol no lo permite"}.
          </Banner>
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
          <Banner tone="warn" title="¿Por qué agencia se envió?">
            <p>
              Este pedido no tiene ninguna salida registrada. Queda como salida con tu firma, y sin
              ella el pedido no aparece en los indicadores de envío ni en el aviso de vencimiento en
              agencia.
            </p>
            <select
              value={agencyCourier}
              onChange={(e) => setAgencyCourier(e.target.value)}
              aria-label="Agencia por la que se envió"
              className={cn(FIELD_BOX, "mt-2 h-9 w-auto px-3 pointer-coarse:h-11")}
            >
              <option value="">Elige la agencia…</option>
              {AGENCY_COURIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Banner>
        )}
        <label className={LABEL}>
          {changingClosed ? "Motivo (obligatorio)" : "Motivo u observación"}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={changingClosed ? "Por qué se corrige un pedido cerrado" : "Opcional"}
            className={cn(FIELD, "font-normal pointer-coarse:h-11")}
          />
        </label>
        <div className="pt-1">
          <OpsButton
            variant="primary"
            disabled={
              pending ||
              (changingClosed && (!canOverride || !reason.trim())) ||
              (needsAgencyCourier && !agencyCourier)
            }
            onClick={() => onStatus(general, operational, reason, agencyCourier || undefined)}
            className="pointer-coarse:h-11"
          >
            Guardar estado
          </OpsButton>
        </div>
      </div>

      <div className={cn(CARD_ZONE, "space-y-3")}>
        <h4 className="text-sm font-semibold text-ink-900">Comentario</h4>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          aria-label="Comentario"
          placeholder="Cliente no responde, dirección incorrecta, pendiente de reasignación…"
          className={TEXTAREA}
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={commentType}
            onChange={(e) => setCommentType(e.target.value)}
            aria-label="Tipo de comentario"
            placeholder="Tipo (opcional)"
            className={cn(FIELD_BOX, "h-9 w-44 px-3 pointer-coarse:h-11")}
          />
          <OpsButton
            disabled={pending || !comment.trim()}
            onClick={() => {
              onComment(comment, commentType);
              setComment("");
              setCommentType("");
            }}
            className="pointer-coarse:h-11"
          >
            Añadir comentario
          </OpsButton>
        </div>
      </div>

      {/* La última franja de la tarjeta, de borde a borde y hasta el pie: es lo
          excepcional, así que espera plegado bajo lo de todos los días. */}
      <details className="group -mx-4 -mb-4 border-t border-line sm:-mx-5 sm:-mb-5">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-b-lg px-4 text-sm font-semibold text-ink-900 transition-colors hover:bg-wash group-open:rounded-none sm:px-5 [&::-webkit-details-marker]:hidden">
          Devoluciones y correcciones avanzadas
          <IconChevronDown aria-hidden className="size-4 text-ink-500 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="space-y-5 border-t border-line px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-ink-900">Registrar devolución</h4>
            <p className="text-[13px] leading-5 text-ink-500">
              Solo se marca como devuelto si consta el despacho y la guía; si no, queda como retorno en
              curso.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                value={returnGuide}
                onChange={(e) => setReturnGuide(e.target.value)}
                aria-label="Guía de la devolución"
                placeholder="Guía"
                className={cn(FIELD_BOX, "h-9 w-40 px-3 font-mono text-[13px] pointer-coarse:h-11")}
              />
              <input
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                aria-label="Motivo de la devolución"
                placeholder="Motivo de la devolución"
                className={cn(FIELD_BOX, "h-9 min-w-44 flex-1 px-3 pointer-coarse:h-11")}
              />
              <OpsButton
                variant="danger"
                disabled={pending || !returnReason.trim()}
                onClick={() => onReturn(returnReason, returnGuide)}
                className="pointer-coarse:h-11"
              >
                Registrar
              </OpsButton>
            </div>
          </div>

          <div className="space-y-2 border-t border-line pt-5">
            <h4 className="text-sm font-semibold text-ink-900">Corregir vínculo de guía</h4>
            {/* Qué hace, dicho antes de pulsar. Es la única vía para mover una
                guía que se enganchó al pedido equivocado —pasa cuando un cliente
                tiene dos pedidos y el emparejador solo tuvo el teléfono— y sin
                decirlo se lee como «vincular una guía suelta», que es lo que ya
                hace la tarjeta de Aliclik de arriba. */}
            <p className="text-[13px] leading-5 text-ink-500">
              <strong className="font-semibold text-ink-700">Mueve</strong> la guía a este pedido, aunque
              esté en otro: se la quita al anterior, renumera la salida y deja constancia en los dos
              historiales. Es la corrección para una guía enganchada al pedido equivocado.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={relinkCode}
                onChange={(e) => setRelinkCode(e.target.value)}
                aria-label="Código de guía a vincular a este pedido"
                placeholder="Código de guía a vincular a este pedido"
                className={cn(FIELD, "flex-1 font-mono text-[13px] pointer-coarse:h-11")}
              />
              <OpsButton
                disabled={pending || !relinkCode.trim()}
                onClick={() => {
                  onRelink(relinkCode);
                  setRelinkCode("");
                }}
                className="pointer-coarse:h-11"
              >
                Vincular
              </OpsButton>
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
      <div className="mt-3 flex justify-end">
        <OpsButton variant="ghost" size="sm" onClick={() => setAbierto(true)} className="pointer-coarse:h-11">
          No hay reenvío posible · descartar la recuperación
        </OpsButton>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-3 rounded-lg bg-crit-wash p-4">
      <div>
        <p className="text-sm font-semibold text-crit-fg">Descartar la recuperación</p>
        <p className="mt-0.5 text-[13px] leading-5 text-ink-700">
          El pedido pasa a cierre con este motivo escrito. No se toca la guía de Aliclik ni el inventario.
        </p>
      </div>
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        aria-label="Motivo del descarte"
        placeholder="Motivo (obligatorio): p. ej. la clienta ya no quiere el producto"
        className={cn(FIELD, "pointer-coarse:h-11")}
      />
      <div className="flex gap-2">
        <OpsButton
          variant="danger"
          size="sm"
          disabled={pending || motivo.trim().length < 8}
          onClick={() => onDiscard(motivo)}
          className="pointer-coarse:h-11"
        >
          Descartar
        </OpsButton>
        <OpsButton
          variant="ghost"
          size="sm"
          onClick={() => {
            setAbierto(false);
            setMotivo("");
          }}
          className="pointer-coarse:h-11"
        >
          Cancelar
        </OpsButton>
      </div>
    </div>
  );
}

const GF_TONE: Record<string, BadgeTone> = {
  slate: "neutral",
  sky: "info",
  emerald: "ok",
  amber: "warn",
  red: "crit",
};

/**
 * Una línea bajo la salida de Grupo GF (MOM §29.13): «Lo lleva Roy · desde
 * 22/09 10:32 · caja del 22/09 · parada pendiente», y al reportar la parada
 * «Entregado por Roy · 14:32 · Yape S/ 89» con la foto y el comprobante. Lo que
 * antes solo se leía en «Actividad», como texto, o no se leía.
 */
function GfDeliveryLine({ delivery }: { delivery: GfDelivery }) {
  const s = gfDeliverySummary(delivery);
  if (!s) return null;
  const photo = delivery.stop?.photoPath;
  const voucher = delivery.stop?.voucherPath;
  const proof = "grid size-7 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11";
  return (
    <div className="mt-1.5 flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">
      <Badge tone={GF_TONE[s.tone] ?? "neutral"}>{s.label}</Badge>
      {s.detail && <span className="tabular-nums text-ink-700">{s.detail}</span>}
      {/* Cada respaldo abre en grande en otra pestaña (GET /api/reparto/foto). */}
      {photo && (
        <a href={`/api/reparto/foto?path=${encodeURIComponent(photo)}`} target="_blank" rel="noreferrer" title="Ver la foto de la entrega" aria-label="Ver la foto de la entrega" className={proof}>
          <IconCamera aria-hidden className="size-4" />
        </a>
      )}
      {voucher && (
        <a href={`/api/reparto/foto?path=${encodeURIComponent(voucher)}`} target="_blank" rel="noreferrer" title="Ver el comprobante de pago" aria-label="Ver el comprobante de pago" className={proof}>
          <IconReceipt aria-hidden className="size-4" />
        </a>
      )}
    </div>
  );
}

/**
 * El tracking de Olva de una salida: se enseña con enlace al seguimiento
 * público, y se registra o corrige en línea. Sin él el cron no tiene qué
 * preguntar, y por eso el hueco se pinta como una invitación y no como un
 * silencio: «Registrar tracking».
 */
function OlvaTrackingField({
  shipmentId,
  current,
  rawStatus,
  onDone,
}: {
  shipmentId: string;
  current: string | null;
  rawStatus: string | null;
  onDone: (notice: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (busy) return <span className="text-[13px] text-ink-500">Guardando tracking…</span>;

  if (!editing) {
    return (
      <>
        {current ? (
          <a
            href={OLVA_TRACKING_URL}
            target="_blank"
            rel="noreferrer"
            title="Abre el seguimiento de Olva; pega ahí el número"
            className="inline-flex items-center gap-1 rounded bg-wash px-1.5 py-0.5 font-mono text-xs font-semibold text-ink-900 ring-1 ring-inset ring-line transition-colors hover:ring-line-strong"
          >
            Olva {current}
            <IconArrowUpRight aria-hidden className="size-3 text-ink-500" />
          </a>
        ) : null}
        {current && rawStatus && (
          <span className="text-[13px] text-ink-500" title="Último estado que dijo Olva">
            {rawStatus.toLowerCase()}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setError(null);
            setValue(current ?? "");
            setEditing(true);
          }}
          className="inline-flex items-center text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          {current ? "Corregir tracking" : "Registrar tracking Olva"}
        </button>
        {error && <span role="alert" className="w-full text-[13px] text-crit-fg">{error}</span>}
      </>
    );
  }

  return (
    <form
      className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-wash p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const res = await setOlvaTracking(shipmentId, { tracking: value });
        setBusy(false);
        if (res.error) {
          setError(res.error);
          return;
        }
        setEditing(false);
        setError(null);
        onDone(res.notice ?? "Tracking registrado.");
      }}
    >
      <input
        type="text"
        inputMode="numeric"
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Tracking de Olva"
        placeholder="2552504-26"
        className={cn(FIELD_BOX, "h-8 w-40 px-3 font-mono text-[13px] tabular-nums pointer-coarse:h-11")}
      />
      <OpsButton type="submit" variant="primary" size="sm" disabled={!value.trim()} className="pointer-coarse:h-11">
        Guardar
      </OpsButton>
      <OpsButton
        variant="ghost"
        size="sm"
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
        className="pointer-coarse:h-11"
      >
        Cancelar
      </OpsButton>
      <span className="w-full text-xs text-ink-500">
        Como lo trae el correo de Olva («26-2552504») o su página («2552504 - 26»).
      </span>
      {error && <span role="alert" className="w-full text-[13px] text-crit-fg">{error}</span>}
    </form>
  );
}
