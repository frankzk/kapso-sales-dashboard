// Verificar con Flow una constancia de pago subida a mano (MOM §12, 14-10-2026).
//
// EL CASO. La clienta paga con tarjeta por Flow —con un link que NO salió de
// Kapta— y manda la captura «¡Tu pago se ha concretado exitosamente!»: monto,
// «Nº de orden», fecha, medio y «Estado: Pago exitoso». No dice «Pagado a» ni
// trae un nº de operación de banco, así que el lector de comprobantes no
// encontraba nada seguro y la daba por «no parece un Yape completo»
// (#KP141432, orden de Flow 184932654).
//
// QUÉ SE HACE. No se le cree a la foto: se le pregunta a Flow. El «Nº de orden»
// es el `flowOrder`, y `payment/getStatusByFlowOrder` con las credenciales de la
// tienda dice si esa orden existe EN NUESTRA CUENTA, si está pagada, cuánto
// entró y cuándo. Es el mismo criterio que ya rige para los links de Kapta
// (lib/flow/confirm.ts): lo que la pasarela confirma entra validado, porque no
// es una pantalla que alguien pueda editar sino el dinero en la cuenta.
//
// LO QUE NO SE DA POR BUENO. Una orden que Flow no conoce en nuestra cuenta, o
// que no está pagada, o un monto registrado mayor que lo que entró, o el nº que
// la persona escribió distinto del de la imagen: nada de eso entra validado.
// Una constancia que dice «pago exitoso» y Flow la tiene sin pagar es justo la
// foto editada que la revisión existe para cazar: va a revisión administrativa.
//
// SERVER-ONLY: descifra las credenciales de Flow de la tienda.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOrNull } from "@/lib/crypto";
import { env } from "@/lib/env";
import { FlowClient } from "./client";
import { FlowApiError, isFlowPaid, type FlowPaymentStatus } from "./types";
import { paidAmountOf } from "./confirm";

export type FlowReceiptCheck =
  | {
      state: "pagado";
      flowOrder: string;
      /** Lo que de verdad entró (paymentData.amount), no lo que se pidió. */
      amount: number | null;
      /** Fecha del pago según Flow, ya en ISO. */
      paidAt: string | null;
      media: string | null;
      payer: string | null;
      commerceOrder: string | null;
    }
  | { state: "no_pagado"; flowOrder: string; status: number | null }
  | { state: "no_encontrado"; flowOrder: string; message: string }
  /** La tienda no tiene credenciales de Flow: no hay a quién preguntar. */
  | { state: "sin_flow"; flowOrder: string }
  | { state: "error"; flowOrder: string; message: string };

/**
 * Flow devuelve las fechas como «2026-10-14 14:18:43», sin zona. La cuenta es
 * peruana y la constancia muestra esa misma hora como local, así que se lee en
 * hora de Lima (UTC−5, sin horario de verano). Pura.
 */
export function flowDateToIso(date: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(date ?? "").trim());
  if (!m) return null;
  const stamp = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}-05:00`);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/** Traduce la respuesta de Flow. Pura. */
export function flowReceiptFromStatus(flowOrder: string, status: FlowPaymentStatus): FlowReceiptCheck {
  if (!isFlowPaid(status.status)) {
    return { state: "no_pagado", flowOrder, status: typeof status.status === "number" ? status.status : null };
  }
  return {
    state: "pagado",
    flowOrder,
    amount: paidAmountOf(status),
    paidAt: flowDateToIso(status.paymentData?.date ?? null),
    media: status.paymentData?.media?.trim() || null,
    payer: status.payer?.trim() || null,
    commerceOrder: status.commerceOrder?.trim() || null,
  };
}

/** Le pregunta a Flow por una orden. Nunca lanza. */
export async function checkFlowReceipt(
  client: Pick<FlowClient, "getStatusByFlowOrder">,
  flowOrder: string,
): Promise<FlowReceiptCheck> {
  try {
    return flowReceiptFromStatus(flowOrder, await client.getStatusByFlowOrder(flowOrder));
  } catch (e) {
    // Flow contesta con un error de negocio cuando la orden no existe en la
    // cuenta de estas credenciales: es otra cuenta, o el número está mal leído.
    if (e instanceof FlowApiError && e.status >= 400 && e.status < 500 && !e.isUnknownApiKey) {
      return { state: "no_encontrado", flowOrder, message: e.message };
    }
    return { state: "error", flowOrder, message: e instanceof Error ? e.message : String(e) };
  }
}

/** El cliente de Flow de la tienda, o null si no tiene credenciales. */
export async function storeFlowClient(admin: SupabaseClient, storeId: string): Promise<FlowClient | null> {
  const { data } = await admin
    .from("stores")
    .select("flowcl_api_key_enc, flowcl_secret_key_enc")
    .eq("id", storeId)
    .maybeSingle();
  const row = data as { flowcl_api_key_enc?: string | null; flowcl_secret_key_enc?: string | null } | null;
  const apiKey = decryptOrNull(row?.flowcl_api_key_enc ?? null);
  const secretKey = decryptOrNull(row?.flowcl_secret_key_enc ?? null);
  if (!apiKey || !secretKey) return null;
  return new FlowClient({ apiKey, secretKey, baseUrl: env.flowclApiBase() });
}

/** Verifica una orden de Flow con las credenciales de la tienda. Nunca lanza. */
export async function verifyFlowReceipt(
  admin: SupabaseClient,
  storeId: string,
  flowOrder: string,
  client?: Pick<FlowClient, "getStatusByFlowOrder"> | null,
): Promise<FlowReceiptCheck> {
  try {
    const c = client ?? (await storeFlowClient(admin, storeId));
    if (!c) return { state: "sin_flow", flowOrder };
    return await checkFlowReceipt(c, flowOrder);
  } catch (e) {
    return { state: "error", flowOrder, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * ¿Con qué estado entra el comprobante? `null` = el de siempre (lo decide el
 * registro normal). Pura.
 *
 * Entra VALIDADO solo si Flow lo confirmó pagado, el nº de operación que se
 * registra es esa misma orden, el monto no supera lo que entró y no hay otra
 * alarma (nº escrito distinto del leído, pago anterior al pedido). Una
 * constancia que Flow tiene sin pagar va a revisión administrativa.
 */
export function flowRegistrationStatus(
  check: FlowReceiptCheck | null | undefined,
  opts: { operation: string | null; amount: number | null; identityDiscrepancy: boolean; tooEarly: boolean },
): "validado" | "revision_admin" | null {
  if (!check) return null;
  if (check.state === "no_pagado") return "revision_admin";
  if (check.state !== "pagado") return null;
  if (opts.identityDiscrepancy || opts.tooEarly) return null;
  if (opts.operation !== check.flowOrder) return null;
  if (opts.amount === null || check.amount === null) return null;
  if (opts.amount > check.amount + 0.009) return null;
  return "validado";
}

const money = (n: number | null) => (n === null ? "monto sin dato" : `S/ ${n.toFixed(2)}`);

function limaLabel(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Lima",
  }).format(new Date(iso));
}

/** Lo que se le dice a quien registra el pago. Pura. */
export function describeFlowReceipt(check: FlowReceiptCheck): string {
  switch (check.state) {
    case "pagado": {
      const cuando = limaLabel(check.paidAt);
      return (
        `Pago verificado con Flow (orden ${check.flowOrder}): ${money(check.amount)}` +
        (check.media ? ` con ${check.media}` : "") +
        (cuando ? ` el ${cuando}` : "") +
        ". Al registrarlo entra validado por la pasarela."
      );
    }
    case "no_pagado":
      return `Flow tiene la orden ${check.flowOrder} SIN PAGAR (estado ${check.status ?? "?"}): la constancia no corresponde a un pago. Queda en revisión administrativa.`;
    case "no_encontrado":
      return `Flow no reconoce la orden ${check.flowOrder} en la cuenta de esta tienda: puede ser de otra cuenta o estar mal leída. Revísala a mano.`;
    case "sin_flow":
      return `Es una constancia de Flow (orden ${check.flowOrder}), pero la tienda no tiene configurada su cuenta de Flow para verificarla. Revísala a mano.`;
    case "error":
      return `Es una constancia de Flow (orden ${check.flowOrder}), pero ahora no se pudo consultar a Flow. Queda para revisión.`;
  }
}
