// Qué hacer cuando Flow avisa de un pago.
//
// EL AVISO NO SE CREE. Flow manda a `urlConfirmation` un POST con un único
// parámetro, `token`, y nada más: ni monto, ni estado, ni firma. Lo único que
// ese aviso significa es «mira otra vez». La verdad se pide con
// `payment/getStatus` y es lo único que se escribe. Es el mismo criterio que
// ya aplica el webhook de Aliclik, y acá pesa más: al otro lado hay dinero, y
// creerle a un cuerpo sin firmar sería dar por cobrado lo que diga cualquiera.
//
// DÓNDE APARECE EL DINERO. El link vive en `flowcl_payment_links` desde que se
// genera; el comprobante en `order_payments` solo cuando Flow confirma que
// está pagado. Un link es una intención, un `order_payment` es plata.
//
// QUÉ PASA SI EL COMPROBANTE NO SE PUEDE REGISTRAR. Existe un índice único
// —`order_payments_kind_uniq`— que permite un solo adelanto vivo por pedido.
// Si ya hay uno (un Yape que alguien subió mientras tanto), el insert falla. El
// dinero NO se pierde ni se inventa: el link queda en `pagado` con
// `register_error` relleno, y eso es una fila que alguien tiene que mirar. Lo
// que no se hace es tragarse el error y devolver «ok», que es como se pierde un
// cobro sin que nadie se entere.

import type { SupabaseClient } from "@supabase/supabase-js";
import { FLOW_STATUS, isFlowPaid, type FlowPaymentStatus } from "./types";
import type { FlowClient } from "./client";

/** Columnas que el webhook necesita del link. */
const LINK_COLS =
  "id, store_id, order_id, commerce_order, kind, amount, currency, status, payment_id";

interface LinkRow {
  id: string;
  store_id: string;
  order_id: string;
  commerce_order: string;
  kind: string;
  amount: number | string;
  currency: string | null;
  status: string;
  payment_id: string | null;
}

export type ConfirmOutcome =
  /** Comprobante creado y link marcado como pagado. */
  | "registrado"
  /** Ya estaba registrado: una re-entrega del mismo aviso. */
  | "duplicado"
  /** El token no corresponde a ningún link nuestro. */
  | "desconocido"
  /** Flow dice que todavía no está pagada (o fue rechazada/anulada). */
  | "sin_pagar"
  /** Flow confirmó el pago pero el comprobante no se pudo crear. */
  | "sin_registrar";

export interface ConfirmResult {
  outcome: ConfirmOutcome;
  message: string;
  paymentId?: string;
  linkId?: string;
}

/** El `status` de Flow traducido al nuestro. */
function linkStatusFor(flowStatus: number | undefined): string {
  switch (flowStatus) {
    case FLOW_STATUS.pagada:
      return "pagado";
    case FLOW_STATUS.rechazada:
      return "rechazado";
    case FLOW_STATUS.anulada:
      return "anulado";
    default:
      return "creado";
  }
}

/**
 * Lo que de verdad se pagó, no lo que pedimos.
 *
 * Flow devuelve el monto de la ORDEN en `amount` y el efectivamente pagado en
 * `paymentData.amount`. Se prefiere el segundo: si por conversión de moneda o
 * por lo que sea entró otra cifra, lo que consta en el pedido tiene que ser la
 * que entró. Dar por cobrado lo que pedimos es la forma elegante de no
 * enterarse de una diferencia.
 */
export function paidAmountOf(status: FlowPaymentStatus): number | null {
  const pagado = status.paymentData?.amount;
  if (typeof pagado === "number" && Number.isFinite(pagado)) return pagado;
  if (typeof status.amount === "number" && Number.isFinite(status.amount)) return status.amount;
  return null;
}

/** Texto para el drawer: de dónde salió este comprobante y qué dijo Flow. */
export function describeFlowPayment(status: FlowPaymentStatus): string {
  const medio = status.paymentData?.media?.trim();
  const partes = [
    `Cobrado por Flow (orden ${status.flowOrder})`,
    medio ? `medio: ${medio}` : null,
    status.payer ? `pagador: ${status.payer}` : null,
  ].filter(Boolean);
  return partes.join(" · ");
}

export interface ConfirmDeps {
  admin: SupabaseClient;
  client: FlowClient;
}

/**
 * Procesa un aviso de Flow. Idempotente: la misma entrega dos veces no crea
 * dos comprobantes.
 */
export async function confirmFlowPayment(
  token: string,
  { admin, client }: ConfirmDeps,
): Promise<ConfirmResult> {
  if (!token) return { outcome: "desconocido", message: "El aviso llegó sin token." };

  const { data: link } = await admin
    .from("flowcl_payment_links")
    .select(LINK_COLS)
    .eq("flow_token", token)
    .maybeSingle();

  if (!link) {
    // No es un 500: Flow reintentaría para siempre un aviso que nunca vamos a
    // poder procesar. Un token que no es nuestro es una respuesta, no un fallo.
    return { outcome: "desconocido", message: "El token no corresponde a ningún cobro nuestro." };
  }
  const row = link as LinkRow;

  if (row.payment_id) {
    return {
      outcome: "duplicado",
      message: "Este cobro ya tenía comprobante registrado.",
      paymentId: row.payment_id,
      linkId: row.id,
    };
  }

  // LA VERDAD. Todo lo que se escriba de aquí en adelante sale de esto.
  const status = await client.getStatus(token);

  const patchBase = {
    flow_status: status.status ?? null,
    last_status: status as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };

  if (!isFlowPaid(status.status)) {
    await admin
      .from("flowcl_payment_links")
      .update({ ...patchBase, status: linkStatusFor(status.status) })
      .eq("id", row.id);
    return {
      outcome: "sin_pagar",
      message: `Flow reporta la orden en estado ${status.status}.`,
      linkId: row.id,
    };
  }

  const amount = paidAmountOf(status);
  const paidAt = status.paymentData?.date ?? null;

  const { data: pago, error: insErr } = await admin
    .from("order_payments")
    .insert({
      store_id: row.store_id,
      order_id: row.order_id,
      kind: row.kind,
      amount,
      paid_at: paidAt,
      // Se deja `validation_status` en su valor por omisión
      // (`pendiente_revision`): un cobro por pasarela entra a la cola como
      // cualquier comprobante, que es como se decidió empezar. No hay imagen
      // que mirar, así que el drawer enseña estos datos en su lugar.
      notes: describeFlowPayment(status),
    })
    .select("id")
    .single();

  if (insErr || !pago) {
    // El dinero ENTRÓ. Que no quepa como comprobante no lo desaparece: queda
    // acá, marcado, para que alguien lo vea. Devolver «ok» sería perderlo.
    const detalle = insErr?.message ?? "el insert no devolvió fila";
    await admin
      .from("flowcl_payment_links")
      .update({
        ...patchBase,
        status: "pagado",
        paid_at: paidAt,
        register_error: detalle,
      })
      .eq("id", row.id);
    return {
      outcome: "sin_registrar",
      message: `Flow confirmó el pago pero no se pudo registrar el comprobante: ${detalle}`,
      linkId: row.id,
    };
  }

  await admin
    .from("flowcl_payment_links")
    .update({
      ...patchBase,
      status: "pagado",
      paid_at: paidAt,
      payment_id: (pago as { id: string }).id,
      register_error: null,
    })
    .eq("id", row.id);

  return {
    outcome: "registrado",
    message: "Comprobante registrado, pendiente de revisión.",
    paymentId: (pago as { id: string }).id,
    linkId: row.id,
  };
}
