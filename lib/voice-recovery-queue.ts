// A quién llama el agente de voz — MOM §11.8, «Quién entra a la cola del
// agente». Función pura: recibe los hechos ya cargados y dice sí, o no y por
// qué. Cada condición tiene su motivo, para poder contar cuántos pedidos quedan
// fuera por cada una (la condición 8 se mide así).
//
// Ninguna condición se calcula aparte: cada una lee la MISMA función que ya la
// decide en otra pantalla.

import { motivoDelCourier } from "@/lib/aliclik-status";
import { evaluateDirectFenixStock, type DirectStockItem, type FenixStockRow } from "@/lib/fenix";
import {
  confirmationRisk,
  summarizeOutcomes,
  type PriorOrderSnapshot,
} from "@/lib/order-confirmation-brief";
import { CONFIRMATION_MAX_DAYS, confirmationDayCount } from "@/lib/order-confirmation";
import {
  recoveryOutcome,
  recoveryWindow,
  type RecoveryEventLike,
  type RecoveryGuideLike,
} from "@/lib/reproprovincia";
import { deriveFenixCoverageCity } from "@/lib/shipments";
import { zadarmaLocalPeru } from "@/lib/zadarma";

export type VoiceExclusion =
  | "recuperacion_no_activa" // 1
  | "cerrada_hace_mucho" // 2
  | "sin_stock_swayp" // 3
  | "rechazo_en_puerta" // 4
  | "telefono_invalido" // 5
  | "antecedentes" // 6
  | "gestion_hoy" // 7
  | "fecha_pactada_futura" // 7
  | "sin_cupo_de_gestion" // 8
  | "pidio_no_llamar" // 9
  | "agente_ya_llamo_hoy"
  | "agente_agoto_intentos";

export interface VoiceCandidateInput {
  now: Date;
  /** Día de hoy en Lima, YYYY-MM-DD. */
  today: string;
  guides: readonly (RecoveryGuideLike & { reported_status?: string | null })[];
  events: readonly RecoveryEventLike[];
  recoveryWindowDays: number;
  maxAgeDays: number;
  /** Destino del pedido, como lo guarda `order_master`. */
  district: string | null;
  region: string | null;
  lineItems: readonly DirectStockItem[];
  stock: readonly FenixStockRow[];
  phone: string | null;
  /** Los otros pedidos del mismo teléfono en la tienda (§8.1). */
  priors: readonly PriorOrderSnapshot[];
  /** `order_master.confirmation_next_contact_on`. */
  nextContactOn: string | null;
  /** Llamadas REALES del agente a este pedido (no las de prueba). */
  agentCalls: readonly { queued_at: string }[];
  maxAgentAttempts: number;
  /** El teléfono pidió al agente que no lo llamen, en esta tienda. */
  doNotCall: boolean;
}

export type VoiceEligibility =
  | { eligible: true; closedAt: string; dueByPact: boolean }
  | { eligible: false; reason: VoiceExclusion };

const CONTACT_KINDS = new Set(["confirmation_contact", "contact_attempt", "call"]);

/** Perú es UTC-5 fijo. */
function limaKey(iso: string): string {
  return new Date(new Date(iso).getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

export function voiceRecoveryEligible(input: VoiceCandidateInput): VoiceEligibility {
  const nowIso = input.now.toISOString();

  // 1. La misma función que pone la segunda mitad del badge.
  if (recoveryOutcome(input.guides, input.events, nowIso, input.recoveryWindowDays) !== "activa") {
    return { eligible: false, reason: "recuperacion_no_activa" };
  }
  const window = recoveryWindow(input.guides, input.events, nowIso, input.recoveryWindowDays);
  if (!window) return { eligible: false, reason: "recuperacion_no_activa" };

  // 2. La parte caliente: el paquete sigue cerca de la clienta.
  const ageMs = input.now.getTime() - new Date(window.closedAt).getTime();
  if (ageMs > input.maxAgeDays * 86_400_000) return { eligible: false, reason: "cerrada_hace_mucho" };

  // 4. Quien lo rechazó teniéndolo delante no se llama. Sin motivo, sí (§11.7).
  const guide = window.guide as RecoveryGuideLike & { reported_status?: string | null };
  if (motivoDelCourier(guide.reported_status).vioElProducto) {
    return { eligible: false, reason: "rechazo_en_puerta" };
  }

  // 3. Lo único que ofrece el agente es el reenvío local: sin stock, nada.
  const city = deriveFenixCoverageCity(input.district, input.region);
  if (!evaluateDirectFenixStock(city, [...input.stock], [...input.lineItems]).ok) {
    return { eligible: false, reason: "sin_stock_swayp" };
  }

  // 5. Solo móviles peruanos: un fijo o un BSUID no se llaman.
  if (!zadarmaLocalPeru(input.phone)?.startsWith("9")) {
    return { eligible: false, reason: "telefono_invalido" };
  }

  // 6. Con dos antecedentes o más la conversación exige adelanto (§8), y eso
  //    lo negocia una persona.
  const risk = confirmationRisk(summarizeOutcomes(input.priors), input.priors);
  if (risk.antecedents >= 2) return { eligible: false, reason: "antecedentes" };

  // 9. Pidió al agente que no la llamen.
  if (input.doNotCall) return { eligible: false, reason: "pidio_no_llamar" };

  // 7. Nadie la gestionó hoy, ni persona ni agente; y si hay fecha pactada
  //    futura, manda la fecha (§6.1).
  if (input.events.some((e) => CONTACT_KINDS.has(e.kind) && limaKey(e.occurred_at) === input.today)) {
    return { eligible: false, reason: "gestion_hoy" };
  }
  if (input.nextContactOn && input.nextContactOn > input.today) {
    return { eligible: false, reason: "fecha_pactada_futura" };
  }

  // Topes propios del agente.
  if (input.agentCalls.some((c) => limaKey(c.queued_at) === input.today)) {
    return { eligible: false, reason: "agente_ya_llamo_hoy" };
  }
  if (input.agentCalls.length >= input.maxAgentAttempts) {
    return { eligible: false, reason: "agente_agoto_intentos" };
  }

  // 8. El tope de siete días es de todos (§6.1).
  if (confirmationDayCount(input.events) >= CONFIRMATION_MAX_DAYS) {
    return { eligible: false, reason: "sin_cupo_de_gestion" };
  }

  return {
    eligible: true,
    closedAt: window.closedAt,
    dueByPact: Boolean(input.nextContactOn && input.nextContactOn <= input.today),
  };
}

/** Orden de la cola: fecha pactada vencida o de hoy primero; luego lo más reciente. */
export function compareVoiceCandidates(
  a: { dueByPact: boolean; closedAt: string },
  b: { dueByPact: boolean; closedAt: string },
): number {
  if (a.dueByPact !== b.dueByPact) return a.dueByPact ? -1 : 1;
  return b.closedAt.localeCompare(a.closedAt);
}

/** ¿Estamos dentro del horario del agente, en hora de Lima? */
export function withinVoiceHours(now: Date, startHour: number, endHour: number): boolean {
  const limaHour = new Date(now.getTime() - 5 * 3_600_000).getUTCHours();
  return limaHour >= startHour && limaHour < endHour;
}

/** Domingo no se llama: tampoco se ofrece entrega ese día. */
export function isLimaSunday(now: Date): boolean {
  return new Date(now.getTime() - 5 * 3_600_000).getUTCDay() === 0;
}

/** Por qué un pedido no entra a la cola del agente, dicho para el drawer. */
export const VOICE_EXCLUSION_LABEL: Record<VoiceExclusion, string> = {
  recuperacion_no_activa: "La recuperación no está activa (vencida, descartada o con guía nueva).",
  cerrada_hace_mucho: "La guía se cerró hace más días de los que llama el agente.",
  sin_stock_swayp: "No hay stock Swayp del producto en su ciudad: no hay reenvío que ofrecer.",
  rechazo_en_puerta: "El courier reporta que lo rechazó en la puerta.",
  telefono_invalido: "No tiene un celular peruano válido.",
  antecedentes: "Tiene dos antecedentes o más: la conversación exige adelanto y la lleva una persona.",
  gestion_hoy: "Ya se gestionó hoy.",
  fecha_pactada_futura: "Tiene una fecha pactada futura: manda la fecha.",
  sin_cupo_de_gestion: "Agotó sus siete días de gestión.",
  pidio_no_llamar: "Pidió al agente que no la llamen.",
  agente_ya_llamo_hoy: "El agente ya la llamó hoy.",
  agente_agoto_intentos: "El agente agotó sus intentos con este pedido.",
};
