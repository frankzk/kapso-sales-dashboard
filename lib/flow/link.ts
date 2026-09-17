// Crear (o reutilizar) un link de cobro de Flow.cl para un pedido.
//
// Esto es la mitad que faltaba de la integración: `lib/flow/client.ts` sabe
// hablar con Flow y `lib/flow/confirm.ts` sabe qué hacer cuando Flow avisa de
// un pago, pero hasta hoy nadie CREABA la orden. Aquí se crea, y la fila de
// `flowcl_payment_links` (0160) es el registro de esa intención.
//
// TRES REGLAS QUE SON DE DINERO, NO DE ESTILO.
//
//  1. NUNCA DOS LINKS VIVOS POR EL MISMO CONCEPTO. La clienta pulsa el botón
//     dos veces —o pulsa los tres botones— y no puede acabar con dos órdenes
//     cobrables por el mismo saldo. Si ya hay un link vivo por el MISMO
//     importe, se reenvía ese mismo. Solo un importe distinto justifica otro.
//
//  2. LA FILA SE ESCRIBE ANTES DE LLAMAR A FLOW. Si se llamara primero y el
//     insert fallara después, quedaría una orden cobrable de la que no
//     tenemos ni el token: la clienta paga y el webhook no sabe de qué pedido
//     habla. Escribiendo antes, lo peor que queda es una fila sin token, que
//     no cobra nada.
//
//  3. `payment/create` NO SE REINTENTA. Lo dice el cliente y se repite acá
//     porque es donde se nota: un reintento a ciegas deja dos links vivos.
//     Un fallo se anota y se contesta que no hay link, que es una respuesta.

import type { SupabaseClient } from "@supabase/supabase-js";
import { FLOW_MEDIO_YAPE_ONE_SHOT } from "./types";
import type { FlowClient } from "./client";

/** Qué comprobante sería este cobro. Los mismos valores que `order_payments`. */
export type FlowLinkKind = "adelanto" | "diferencia" | "total";

/**
 * El importe tal como viaja a Flow: SIEMPRE con dos decimales.
 *
 * Lo que se firma es `String(valor)`, y JavaScript escribe 59.10 como «59.1».
 * Firmar «59.1» y que Flow lea otra cosa es la clase de desajuste que se
 * manifiesta como un 401 sin explicación. Pura.
 */
export function amountForFlow(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

/**
 * El `commerceOrder`: la llave de idempotencia que viaja a Flow y vuelve.
 *
 * Lleva el nombre del pedido para que sea legible en el panel de Flow —quien
 * concilia mira ahí—, y un sufijo aleatorio porque un pedido puede tener más
 * de un cobro a lo largo de su vida (un adelanto y una diferencia, o un link
 * caducado y otro nuevo). Sin el sufijo, el segundo choca con el `unique` y no
 * se puede cobrar. Pura.
 */
export function commerceOrderFor(
  orderName: string | null | undefined,
  kind: FlowLinkKind,
  suffix: string,
): string {
  const base = String(orderName ?? "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 20);
  return `${base || "PEDIDO"}-${kind.slice(0, 3)}-${suffix}`;
}

/** Un link ya creado que sigue sirviendo. */
export interface LiveLinkRow {
  id: string;
  amount: number | string;
  link: string | null;
  expires_at: string | null;
}

/**
 * Cuál de los links vivos del pedido vale para este importe, si alguno.
 *
 * Se compara EN CÉNTIMOS: 59.1 y 59.10 son el mismo saldo, y comparar números
 * en coma flotante con `===` diría que no. Un link sin `link` todavía (la fila
 * se escribe antes de llamar a Flow) no sirve para mandar. Pura.
 */
export function reusableLink(
  rows: readonly LiveLinkRow[],
  amount: number,
  nowIso: string,
): LiveLinkRow | null {
  const cents = Math.round(amount * 100);
  const now = Date.parse(nowIso);
  for (const r of rows) {
    if (!r.link) continue;
    if (Math.round(Number(r.amount) * 100) !== cents) continue;
    if (r.expires_at && Date.parse(r.expires_at) <= now) continue;
    return r;
  }
  return null;
}

export interface EnsureLinkInput {
  storeId: string;
  orderId: string;
  orderName: string | null;
  kind: FlowLinkKind;
  /** El saldo de HOY. Cero o menos no es un cobro. */
  amount: number;
  /** El del cliente si el pedido lo trae; si no, el de la tienda. */
  email: string;
  ttlHours: number;
  yapeOnly: boolean;
  /** Lo que la clienta ve como concepto en el checkout. */
  subject?: string;
  currency?: string;
}

export interface EnsureLinkDeps {
  client: FlowClient;
  /** Base absoluta del sitio, para las URLs de vuelta y de confirmación. */
  siteUrl: string;
  /** El secreto del webhook de ESTA tienda: viaja en `urlConfirmation`. */
  webhookSecret: string;
  nowIso?: string;
  /** Inyectable para que las pruebas no dependan del azar. */
  suffix?: () => string;
}

export type EnsureLinkResult =
  | { ok: true; link: string; reused: boolean; id: string; expiresAt: string | null }
  | { ok: false; reason: string };

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 8);
}

/**
 * Devuelve un link de cobro por `amount` para este pedido: el que ya había si
 * sirve, o uno nuevo. Nunca lanza — quien lo llama está contestando un
 * WhatsApp y un fallo de la pasarela no puede dejar a la clienta sin
 * respuesta.
 */
export async function ensureFlowPaymentLink(
  admin: SupabaseClient,
  input: EnsureLinkInput,
  deps: EnsureLinkDeps,
): Promise<EnsureLinkResult> {
  const nowIso = deps.nowIso ?? new Date().toISOString();
  if (!(input.amount > 0)) return { ok: false, reason: "sin_saldo" };
  if (!input.email) return { ok: false, reason: "sin_email" };
  if (!deps.webhookSecret) return { ok: false, reason: "sin_secreto_de_webhook" };

  try {
    // 1. ¿Hay ya un link vivo que sirva? Reenviarlo es la respuesta correcta:
    //    es el mismo cobro, no uno nuevo.
    const { data: vivos } = await admin
      .from("flowcl_payment_links")
      .select("id,amount,link,expires_at")
      .eq("order_id", input.orderId)
      .eq("kind", input.kind)
      .eq("status", "creado")
      .order("created_at", { ascending: false })
      .limit(10);
    const rows = (vivos ?? []) as LiveLinkRow[];
    const reusar = reusableLink(rows, input.amount, nowIso);
    if (reusar) {
      return {
        ok: true,
        link: reusar.link!,
        reused: true,
        id: reusar.id,
        expiresAt: reusar.expires_at,
      };
    }

    // 2. Los vivos que quedan son por OTRO importe: ya no los vamos a ofrecer.
    //    Se marcan anulados para que el panel no enseñe dos cobros vivos por
    //    el mismo pedido. Si alguno se paga igual, el webhook lo encuentra por
    //    el token y el dinero se registra: esto cierra la oferta, no la caja.
    const viejos = rows.map((r) => r.id);
    if (viejos.length) {
      await admin
        .from("flowcl_payment_links")
        .update({ status: "anulado", updated_at: nowIso })
        .in("id", viejos);
    }

    const ttlSeconds = Math.max(1, Math.round(input.ttlHours * 3600));
    const expiresAt = new Date(Date.parse(nowIso) + ttlSeconds * 1000).toISOString();
    const commerceOrder = commerceOrderFor(
      input.orderName,
      input.kind,
      (deps.suffix ?? randomSuffix)(),
    );
    const currency = input.currency ?? "PEN";
    const amount = amountForFlow(input.amount);

    // 3. La fila ANTES que Flow (ver cabecera).
    const { data: fila, error: insErr } = await admin
      .from("flowcl_payment_links")
      .insert({
        store_id: input.storeId,
        order_id: input.orderId,
        commerce_order: commerceOrder,
        kind: input.kind,
        amount,
        currency,
        payment_method: input.yapeOnly ? FLOW_MEDIO_YAPE_ONE_SHOT : null,
        expires_at: expiresAt,
        status: "creado",
      })
      .select("id")
      .single();
    if (insErr || !fila) {
      return { ok: false, reason: `no_se_pudo_registrar:${insErr?.message ?? "sin fila"}` };
    }
    const linkId = (fila as { id: string }).id;

    // 4. Flow. Sin reintento.
    try {
      const pago = await deps.client.createPayment({
        commerceOrder,
        subject: input.subject ?? `Saldo del pedido ${input.orderName ?? ""}`.trim(),
        amount,
        email: input.email,
        currency,
        urlConfirmation: confirmationUrl(deps.siteUrl, input.storeId, deps.webhookSecret),
        urlReturn: `${deps.siteUrl.replace(/\/$/, "")}/pago/gracias`,
        timeout: ttlSeconds,
        ...(input.yapeOnly ? { paymentMethod: FLOW_MEDIO_YAPE_ONE_SHOT } : {}),
      });
      await admin
        .from("flowcl_payment_links")
        .update({
          flow_token: pago.token,
          flow_order: pago.flowOrder || null,
          link: pago.link,
          updated_at: nowIso,
        })
        .eq("id", linkId);
      return { ok: true, link: pago.link, reused: false, id: linkId, expiresAt };
    } catch (e) {
      // La orden no llegó a existir del otro lado, o no sabemos si existe. Sin
      // token no la podemos cobrar ni conciliar: se cierra la fila con el
      // motivo, que es lo que alguien va a leer mañana.
      const message = e instanceof Error ? e.message : String(e);
      await admin
        .from("flowcl_payment_links")
        .update({
          status: "anulado",
          last_status: { create_error: message },
          updated_at: nowIso,
        })
        .eq("id", linkId);
      return { ok: false, reason: `flow_rechazo:${message}` };
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Dónde avisa Flow del pago. El secreto viaja en la URL porque el webhook de
 * Flow no admite cabeceras propias (ver `app/api/webhooks/flowcl`).
 */
export function confirmationUrl(siteUrl: string, storeId: string, secret: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return `${base}/api/webhooks/flowcl/${storeId}?secret=${encodeURIComponent(secret)}`;
}
