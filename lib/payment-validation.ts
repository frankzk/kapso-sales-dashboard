// Lo que pasa cuando un pago queda validado. UNA sola definición.
//
// Valida una persona desde «Validar pagos» (`validatePayment`) y, desde el
// 04-10-2026, también el cruce con el estado de cuenta de Yape
// (lib/yape-statement). Las comprobaciones de antes —permiso, nº de operación,
// cuatro ojos, cuenta receptora— son de cada camino; lo que viene DESPUÉS de
// decidir tiene que ser idéntico, o los dos caminos acabarían dejando pedidos
// distintos según quién validó: uno con el cierre de liquidación y otro sin él,
// que es exactamente el fallo que `overridePaymentValidation` ya cometió.
//
// SERVER-ONLY: escribe con la clave de servicio.

import type { SupabaseClient } from "@supabase/supabase-js";
import { closeAlertsResolvedBy } from "@/lib/collection-alerts-access";
import { registrarConfirmacionExpresaDeAgencia } from "@/lib/confirmacion-agencia-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { applyHumanRulingToGuide, COURIER_COLLECTION_KIND } from "@/lib/tanders/collection-payment";

/** Quién valida y por qué vía. `actor` nulo: no fue una persona. */
export interface ValidationActor {
  storeId: string;
  actor: string | null;
  /** `manual` desde la bandeja; `estado_yape` desde el cruce con el reporte. */
  source: string;
}

/**
 * Validar el cobro del courier CIERRA LA LIQUIDACIÓN del pedido.
 *
 * POR QUÉ. Un pedido contraentrega entregado se queda en «Por cerrar ·
 * Pendiente de liquidación» hasta que exista un evento `liquidation_closed`
 * (lib/order-macro-stage.ts). La regla es correcta —no declarar un cierre
 * financiero que nadie respalda— pero el 12-09-2026 no había NI UN evento así
 * en toda la historia de la base: 4.204 pedidos esperando una firma que nadie
 * daba. El propio código lo admitía: «el repositorio auditado todavía no
 * contiene la fuente de liquidaciones».
 *
 * Ahora sí la hay, y por pedido en vez de en bloque: alguien miró el
 * comprobante del motorizado al lado de lo que leyó el modelo y dijo que el
 * dinero llegó —o el estado de cuenta de Yape lo muestra entrando—. Eso es
 * exactamente lo que una liquidación pretende demostrar. Se emite el MISMO
 * evento que emitiría a mano desde el cierre del drawer, así que la macroetapa
 * no necesita saber nada nuevo.
 *
 * Y se puede deshacer: rechazar u observar después un cobro ya validado emite
 * `liquidation_observed`, que reabre el cierre. Un pedido no puede quedarse
 * finalizado por una firma que luego se retiró.
 */
export async function adjustCourierLiquidation(
  admin: SupabaseClient,
  who: ValidationActor,
  payment: { order_id: string; kind: string; vision?: unknown },
  cerrada: boolean,
  note: string,
): Promise<void> {
  if (payment.kind !== COURIER_COLLECTION_KIND) return;
  await admin.from("order_events").insert({
    store_id: who.storeId,
    order_id: payment.order_id,
    kind: cerrada ? "liquidation_closed" : "liquidation_observed",
    actor: who.actor,
    source: who.source,
    note,
  });
  // Y la GUÍA sigue a la firma. Antes solo se emitía el cierre, y la guía se
  // quedaba donde la hubiera dejado el MODELO: el 24-09-2026 había 49 pedidos
  // que una persona había validado y que seguían «En tránsito», porque el
  // lector los había rechazado y para el Master nunca se entregaron. El cierre
  // de liquidación existía, pero el pedido no podía llegar a usarlo. Ver
  // `guidePatchForHumanRuling`.
  await applyHumanRulingToGuide(admin, payment, cerrada ? "validado" : "retirado");
}

export interface ApplyValidationInput {
  payment: {
    id: string;
    order_id: string;
    kind: string;
    validation_status: string;
    vision?: unknown;
  };
  who: ValidationActor;
  /** Nota del evento `payment`. */
  note: string;
  /** Datos del evento `payment` (p. ej. el movimiento del estado de cuenta). */
  payload?: Record<string, unknown>;
  /** Eventos que van justo después del de `payment` (la excepción de cuenta). */
  extraEvents?: Record<string, unknown>[];
  /** Nota del cierre de liquidación del cobro de courier. */
  liquidationNote: string;
  /**
   * Validar SOLO si el pago sigue en este estado. El cruce lo exige: entre que
   * leyó la cola y que escribe, una persona pudo haberlo observado o
   * rechazado, y su decisión manda.
   */
  onlyIfStatus?: string;
}

export type ApplyValidationResult =
  | { ok: true; confirmado: boolean }
  | { ok: false; error: string; stale?: boolean };

/** Marca el pago como validado y deja escrito todo lo que eso implica. */
export async function applyPaymentValidation(
  admin: SupabaseClient,
  input: ApplyValidationInput,
): Promise<ApplyValidationResult> {
  const { payment, who } = input;
  let update = admin
    .from("order_payments")
    .update({
      validation_status: "validado",
      validated_by: who.actor,
      validated_at: new Date().toISOString(),
    })
    .eq("id", payment.id);
  if (input.onlyIfStatus) update = update.eq("validation_status", input.onlyIfStatus);
  const { data, error } = await update.select("id");
  if (error) return { ok: false, error: error.message };
  if (!(data as { id: string }[] | null)?.length) {
    return { ok: false, error: "El pago cambió de estado antes de validarlo.", stale: true };
  }

  await admin.from("order_events").insert({
    store_id: who.storeId,
    order_id: payment.order_id,
    kind: "payment",
    actor: who.actor,
    source: who.source,
    previous_status: payment.validation_status,
    new_status: "validado",
    note: input.note,
    ...(input.payload ? { payload: input.payload } : {}),
  });
  for (const extra of input.extraEvents ?? []) {
    await admin.from("order_events").insert({
      store_id: who.storeId,
      order_id: payment.order_id,
      actor: who.actor,
      source: who.source,
      ...extra,
    });
  }
  await adjustCourierLiquidation(admin, who, payment, true, input.liquidationNote);
  // El pago suele ser la ÚLTIMA de las tres piezas: el DNI y la agencia ya
  // estaban apuntados desde que se registró el cobro. Se pregunta antes de
  // recalcular para que la macroetapa se resuelva ya con el hecho escrito y el
  // pedido no pase por un estado intermedio que nadie llegue a ver.
  const confirmado = await registrarConfirmacionExpresaDeAgencia(
    admin,
    payment.order_id,
    who.storeId,
    who.actor,
  );
  // La alerta de cobranza que pedía justo esto se cierra sola: el hecho ya
  // ocurrió y pedir además un clic de confirmación es el clic que se deja de
  // dar (lib/collection-alerts-access.ts).
  await closeAlertsResolvedBy(
    admin,
    { storeId: who.storeId, orderId: payment.order_id, paymentId: payment.id },
    who.source === "manual" ? "el pago se revisó en Kapta" : "el pago se concilió con el estado de cuenta",
  );
  await recomputeOrderMasterSafe(admin, [payment.order_id]);
  return { ok: true, confirmado };
}
