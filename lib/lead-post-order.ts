// Después de «Generar pedido» en Leads: cómo sale y cómo se cobra (MOM §25.2,
// owner 07-11-2026).
//
// EL PEDIDO DEL OWNER: «en el drawer de Leads, luego de generar el pedido me da
// la opción para crear guía en Aliclik pero no me da para subir si manda un
// adelanto de pago, tampoco para elegir agencia Shalom, y me gustaría tener el
// de "Swayp lo puede llevar hoy"».
//
// QUÉ ES ESTE ARCHIVO. La decisión PURA de qué tres opciones se ofrecen para el
// pedido recién creado y por qué no, si alguna no: «Guía Aliclik», «Swayp hoy»
// y «Agencia Shalom + adelanto». No trae reglas propias: cada opción pregunta lo
// mismo que la ficha del pedido —
//   - Aliclik: `aliclikGuideOffered` (el plan de rutas, sin acompañantes) y
//     `aliclik.create_guide`;
//   - Swayp: `swaypDesdeConfirmacionOffer` (MOM §11.11) y `master.edit`, como la
//     mesa de confirmación que la enseña;
//   - Cobro por agencia: `orderPaymentPanelFor`, la tarjeta de Cobro de la ficha
//     (`PickupKeyPanel`), con su modo y el bloque «DNI y agencia Shalom».
// Lo único que añade es la línea del porqué cuando no se ofrece, y el resumen de
// en qué quedó cada una (guía creada, Swayp programado, adelanto por validar,
// agencia guardada). Sin nada del servidor: lo importa el cajón.

import { aliclikGuideOffered, type RouteCandidate } from "@/lib/order-route-plan";
import type { OperationKind } from "@/lib/order-macro-stage";
import {
  orderPaymentPanelFor,
  type OrderPaymentPanelMode,
  type OrderPaymentPanelSource,
} from "@/lib/order-payment-panel";
import { PAYMENT_STATE_LABEL, type PaymentState } from "@/lib/pickup-key";
import { swaypLiveGuides, type SwaypGuideRow } from "@/lib/swayp-address";
import {
  swaypDesdeConfirmacionOffer,
  type SwaypAvailabilityValue,
  type SwaypDesdeConfirmacionRow,
} from "@/lib/swayp-desde-confirmacion-offer";

export type LeadPostOrderChoiceKey = "aliclik" | "swayp" | "agencia";

export interface LeadPostOrderInput {
  orderId: string;
  orderName: string | null;
  row: OrderPaymentPanelSource["row"] &
    SwaypDesdeConfirmacionRow & {
      guide_code: string | null;
    };
  routePlan: {
    operation: OperationKind;
    operationLabel: string;
    candidates: readonly Pick<RouteCandidate, "key" | "action" | "availability" | "reason">[];
  };
  /** El pedido viaja en la guía de otro (MOM §32). */
  travelsInCompanion: boolean;
  /** Las salidas del pedido, para saber si ya hay una guía Swayp viva. */
  guides: readonly SwaypGuideRow[];
  /**
   * `swayp_availability` evaluada en este momento con la misma regla
   * (`swaypAvailabilityFor`) cuando la columna todavía está vacía: el pedido
   * acaba de nacer y la pasada horaria aún no lo vio. Null si no se evaluó.
   */
  swaypAvailabilityNow?: SwaypAvailabilityValue | null;
  brief: OrderPaymentPanelSource["brief"];
  /** Lo guardado en «DNI y agencia Shalom» (`shalom_order_drafts`), o null. */
  shalomDraft: { document: string | null; terminalName: string | null } | null;
  perms: {
    /** `!readOnly`, el `canEdit` de la ficha (las guías Swayp piden `master.edit`). */
    canEdit: boolean;
    canCreateGuide: boolean;
    canCreateShalomGuide: boolean;
  };
}

export interface LeadPostOrderChoices {
  orderId: string;
  orderName: string | null;
  aliclik: {
    offered: boolean;
    reason: string | null;
    /** La guía de Aliclik ya creada para este pedido. */
    guide: string | null;
  };
  swayp: {
    offered: boolean;
    reason: string | null;
    /** Guías Swayp vivas: ya está programado. */
    guides: string[];
  };
  agencia: {
    offered: boolean;
    reason: string | null;
    mode: OrderPaymentPanelMode;
    gatewayNote: string | null;
    shalomDestination: boolean;
    /** En qué quedó el cobro, en palabras («Adelanto cargado · por validar»), o null sin cobro. */
    payment: string | null;
    /** La agencia o el documento guardados, o null. */
    shalom: string | null;
  };
}

/** Los motivos, para que la pantalla y las pruebas digan lo mismo. */
export const LEAD_POST_ORDER_REASON = {
  aliclikPermission: "Tu rol no permite crear guías de Aliclik.",
  aliclikCompanion: "Viaja en la guía de otro pedido (acompañante): no lleva guía propia.",
  aliclikNotInPlan: (operation: string) => `El plan de rutas no ofrece Aliclik en ${operation}.`,
  aliclikOtherCourier: (courier: string) => `El pedido ya tiene una guía de ${courier}.`,
  swaypPermission: "Tu rol no permite gestionar envíos.",
  agencyPermission: "Tu rol no crea guías Shalom: el cobro por agencia no se ofrece aquí.",
  agencyNotNeeded: (operation: string) =>
    `No aplica en ${operation}: el pedido no va por agencia, su plan de rutas no ofrece Shalom ni Olva y ninguna regla pide adelanto.`,
} as const;

const COURIER_NAME: Record<string, string> = { fenix: "Swayp", aliclik: "Aliclik", shalom: "Shalom", olva: "Olva" };

/** El cobro en palabras. «Cargado» es subido y sin validar: se dice. */
export function paymentSummary(state: string | null | undefined): string | null {
  if (!state || state === "sin_pago") return null;
  const label = PAYMENT_STATE_LABEL[state as PaymentState] ?? state;
  return /_cargad[oa]$/.test(state) ? `${label} · por validar` : label;
}

export function leadPostOrderChoices(input: LeadPostOrderInput): LeadPostOrderChoices {
  const { row, routePlan, perms } = input;
  const courier = (row.current_courier ?? "").toLowerCase();

  // ── Aliclik ────────────────────────────────────────────────────────────
  const aliclikGuide = courier === "aliclik" && row.guide_code ? row.guide_code : null;
  let aliclikReason: string | null = null;
  if (!aliclikGuide) {
    const blocked = routePlan.candidates.find((c) => c.action === "aliclik" && c.availability === "blocked");
    if (!perms.canCreateGuide) aliclikReason = LEAD_POST_ORDER_REASON.aliclikPermission;
    else if (input.travelsInCompanion) aliclikReason = LEAD_POST_ORDER_REASON.aliclikCompanion;
    else if (!aliclikGuideOffered({ travelsInCompanion: false, candidates: routePlan.candidates })) {
      aliclikReason =
        courier && row.guide_code && courier !== "aliclik"
          ? LEAD_POST_ORDER_REASON.aliclikOtherCourier(COURIER_NAME[courier] ?? courier)
          : blocked?.reason || LEAD_POST_ORDER_REASON.aliclikNotInPlan(routePlan.operationLabel);
    }
  }

  // ── Swayp hoy (§11.11) ─────────────────────────────────────────────────
  const swaypGuides = swaypLiveGuides(input.guides);
  let swaypReason: string | null = null;
  if (!swaypGuides.length) {
    if (!perms.canEdit) swaypReason = LEAD_POST_ORDER_REASON.swaypPermission;
    else {
      const offer = swaypDesdeConfirmacionOffer({
        ...row,
        swayp_availability: row.swayp_availability ?? input.swaypAvailabilityNow ?? null,
      });
      if (!offer.offered) swaypReason = offer.reason;
    }
  }

  // ── Agencia Shalom + adelanto: la tarjeta de Cobro de la ficha ─────────
  const payment = orderPaymentPanelFor({
    row,
    routePlan,
    brief: input.brief,
    canCreateShalomGuide: perms.canCreateShalomGuide,
  });
  const agencyOffered = payment.presentation.show;
  const agencyReason = agencyOffered
    ? null
    : !perms.canCreateShalomGuide && routePlan.candidates.some((c) => c.key === "shalom" || c.key === "olva")
      ? LEAD_POST_ORDER_REASON.agencyPermission
      : LEAD_POST_ORDER_REASON.agencyNotNeeded(routePlan.operationLabel);
  const draft = input.shalomDraft;
  const shalom = draft?.terminalName
    ? `Agencia ${draft.terminalName}${draft.document ? ` · doc. ${draft.document}` : ""}`
    : draft?.document
      ? `Doc. ${draft.document} · falta la agencia`
      : null;

  return {
    orderId: input.orderId,
    orderName: input.orderName,
    aliclik: { offered: !aliclikGuide && !aliclikReason, reason: aliclikReason, guide: aliclikGuide },
    swayp: { offered: !swaypGuides.length && !swaypReason, reason: swaypReason, guides: swaypGuides },
    agencia: {
      offered: agencyOffered,
      reason: agencyReason,
      mode: payment.presentation.mode,
      gatewayNote: payment.gatewayNote,
      shalomDestination: payment.shalomDestination,
      payment: paymentSummary(row.payment_state),
      shalom,
    },
  };
}

/**
 * La opción que se abre sola: la que ya tiene algo hecho (una guía Swayp, la de
 * Aliclik, un cobro o una agencia guardada) y, si no, Aliclik cuando se ofrece —
 * es lo que el cajón enseñaba antes, abierto, después de «Generar pedido». Si no
 * hay ninguna, ninguna: la asesora elige.
 */
export function defaultLeadPostOrderChoice(choices: LeadPostOrderChoices): LeadPostOrderChoiceKey | null {
  if (choices.swayp.guides.length) return "swayp";
  if (choices.aliclik.guide) return "aliclik";
  if (choices.agencia.offered && (choices.agencia.payment || choices.agencia.shalom)) return "agencia";
  if (choices.aliclik.offered) return "aliclik";
  return null;
}
