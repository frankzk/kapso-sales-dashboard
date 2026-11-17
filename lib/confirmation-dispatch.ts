// «Confirmado · programar salida» (MOM §6.2, owner 17-11-2026).
//
// POR QUÉ. En Provincia COD, «Confirmó el pedido» con «Sale el» vacío dejaba el
// pedido en Preparación · Por generar rótulo sin guía ni fecha: nadie lo
// esperaba y el automático no lo tomaba, porque solo crea la guía en un día
// programado (#AUR900908: confirmado el 15-11, programado recién el 16-11 por
// otra persona; #KP205536, cinco días así). Y era una contradicción: si sale
// hoy, lo que toca no es «confirmar» sino crear la guía. Medido en 30 días de
// guías Aliclik de Provincia COD: 1.140 de 2.654 se crearon sin «Confirmó»
// antes; la confirmación de verdad ya era crear la guía.
//
// LA REGLA.
//   * Confirmar en Provincia COD es programar la salida: fecha desde mañana y
//     GPS, los dos obligatorios. Ese día Kapta crea sola la guía Aliclik.
//   * Si sale hoy no se confirma en la gestión: se crea la guía Aliclik, y
//     crearla a mano deja la confirmación registrada (el hecho `confirmed`, con
//     quien la creó). Igual registrar el adelanto o el pago total.
//   * Swayp desde Por confirmar NO confirma: sale sin confirmar a propósito y,
//     si no entrega, vuelve a Por confirmar (§11.11).
//
// Pura.

import type { ConfirmationResultDef } from "@/lib/order-confirmation";
import { DISPATCH_NEEDS_COORDINATE_ERROR, dispatchDateError } from "@/lib/dispatch-date";

/** Cómo se llama «Confirmó el pedido» en Provincia COD. */
export const PROGRAM_CONFIRM_LABEL = "Confirmado · programar salida";

export const PROGRAM_CONFIRM_HINT =
  "Producto, monto y dirección validados, con el día de salida y el GPS. Ese día Kapta crea sola la guía Aliclik.";

/** Lo que se le dice a quien quiere confirmar un pedido que sale hoy. */
export const SALE_HOY_HINT =
  "¿Sale hoy? No se confirma aquí: crea la guía Aliclik, que deja el pedido confirmado.";

/** ¿Confirmar este pedido es programar su salida? Solo en Provincia COD. */
export function confirmationProgramsDispatch(operation: string | null | undefined): boolean {
  return operation === "provincia_cod";
}

/** El catálogo de resultados tal como se ofrece para la operación del pedido. */
export function confirmationResultsFor(
  results: readonly ConfirmationResultDef[],
  operation: string | null | undefined,
): ConfirmationResultDef[] {
  if (!confirmationProgramsDispatch(operation)) return [...results];
  return results.map((result) =>
    result.confirms ? { ...result, label: PROGRAM_CONFIRM_LABEL, hint: PROGRAM_CONFIRM_HINT } : result,
  );
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** El primer día que se puede programar al confirmar: mañana. */
export function firstProgrammableDay(todayLima: string): string {
  return addDays(todayLima, 1);
}

/**
 * Por qué no se puede confirmar así un pedido de Provincia COD, o null. La
 * fecha va primero: sin ella no hay nada que programar.
 */
export function programmedConfirmationError(input: {
  dispatchOn: string | null | undefined;
  todayLima: string;
  coordinateMissing: boolean;
  coordinate: string | null | undefined;
}): string | null {
  const date = (input.dispatchOn ?? "").trim();
  if (!date) return `Elige el día de salida (desde mañana). ${SALE_HOY_HINT}`;
  // Una fecha ilegible primero (comparar texto suelto con hoy no dice nada);
  // después hoy o antes, que tiene su propio mensaje; y lo demás (más de 45
  // días) con el de siempre.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) {
    return "Día de salida: elige una fecha válida.";
  }
  if (date <= input.todayLima) return `El día de salida es desde mañana. ${SALE_HOY_HINT}`;
  const dateError = dispatchDateError(date, input.todayLima);
  if (dateError) return `Día de salida: ${dateError}`;
  if (input.coordinateMissing && !(input.coordinate ?? "").trim()) return DISPATCH_NEEDS_COORDINATE_ERROR;
  return null;
}

/**
 * A dónde lleva «Programar salida» cuando la guía Aliclik no se puede crear
 * hoy: a la gestión de confirmación si el pedido todavía se está confirmando, a
 * «Programar envío» (la tarjeta de arriba) si ya está en Por generar rótulo.
 * Solo en Provincia COD; en otro sitio, nada.
 */
export function scheduleInsteadSection(
  row: { macro_stage?: string | null; macro_substage?: string | null },
  operation: string | null | undefined,
): "confirmacion" | "resumen" | null {
  if (!confirmationProgramsDispatch(operation)) return null;
  if (row.macro_stage === "por_confirmar" || row.macro_substage === "gestion_reproprovincia") return "confirmacion";
  if (row.macro_stage === "preparacion" && row.macro_substage === "por_generar_rotulo") return "resumen";
  return null;
}

/** El callback de un destino, o nada si no hay destino. */
export function withSection<S extends string>(section: S | null, go: (section: S) => void): (() => void) | undefined {
  return section ? () => go(section) : undefined;
}

/** Por qué una acción logística deja el pedido confirmado. */
export type ImplicitConfirmationVia = "guia_aliclik" | "adelanto" | "pago_total";

export const IMPLICIT_CONFIRMATION_NOTE: Record<ImplicitConfirmationVia, string> = {
  guia_aliclik: "Confirmado al crear la guía Aliclik: sale hoy.",
  adelanto: "Confirmado al registrar el adelanto.",
  pago_total: "Confirmado al registrar el pago total.",
};

/**
 * ¿Esta acción deja escrita la confirmación? Solo una persona (el automático no
 * confirma por nadie), solo en Provincia COD y solo si el pedido no tiene ya
 * una: la confirmación se escribe una vez.
 */
export function writesImplicitConfirmation(input: {
  operation: string | null | undefined;
  actor: string | null | undefined;
  automatic: boolean;
  alreadyConfirmed: boolean;
}): boolean {
  return (
    confirmationProgramsDispatch(input.operation) && Boolean(input.actor) && !input.automatic && !input.alreadyConfirmed
  );
}

/** El hecho `confirmed` de una confirmación implícita. Sin canal: nadie lo dijo. */
export function implicitConfirmationEvent(input: {
  storeId: string;
  orderId: string;
  actor: string;
  via: ImplicitConfirmationVia;
  occurredAt: string;
  courier?: string | null;
  guideCode?: string | null;
}) {
  return {
    store_id: input.storeId,
    order_id: input.orderId,
    kind: "confirmed",
    occurred_at: input.occurredAt,
    actor: input.actor,
    source: "manual",
    ...(input.courier ? { courier: input.courier } : {}),
    ...(input.guideCode ? { guide_code: input.guideCode } : {}),
    note: IMPLICIT_CONFIRMATION_NOTE[input.via],
    payload: { channel: null, via: input.via },
  };
}
