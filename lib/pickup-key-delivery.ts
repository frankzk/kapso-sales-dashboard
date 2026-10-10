// La clave de recojo por WhatsApp (0173), desde cualquier puerta que la suelte.
//
// EL CASO. #KP139240 (10-10-2026): la diferencia de S/ 159 la validó el estado
// de cuenta de Yape a las 12:17 —pago completo, paquete en la agencia— y la
// clave nunca salió. La clienta escribió a las 14:09: «Por segunda vez les
// remite el comprobante de pago. No hay seriedad en esta empresa». El envío
// vivía DENTRO del botón «Validar» (app/dashboard/pedidos/payment-actions.ts),
// y la validación automática por el estado de cuenta (lib/yape-statement,
// desde el 04-10) va por el mismo camino de validar pero nunca llegaba a él.
// Medido ese día: 59 pedidos de agencia con un pago validado así; 38 quedaron
// con el pago completo y 23 de ellos sin ningún envío de la clave registrado.
//
// LA REGLA. Una sola función manda la clave, con las mismas rejas en las tres
// puertas: el botón «Validar», el estado de cuenta de Yape y «Enviar clave por
// WhatsApp» en la ficha. Vuelve a comprobar `canRevealPickupKey` con los datos
// frescos, respeta la ventana de 24 h de WhatsApp y, salvo cuando lo pide una
// persona desde la ficha, el interruptor de envío automático de la tienda.
//
// NUNCA LANZA: el pago ya está validado cuando esto corre y eso no se deshace.
// Devuelve qué decir, para que nadie dé por entregada una clave que no salió.
//
// SERVER-ONLY: descifra la clave y escribe con la clave de servicio.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOrNull } from "@/lib/crypto";
import { getStoreCreds } from "@/lib/ingest";
import { sendWhatsappText } from "@/lib/kapso";
import {
  canRevealPickupKey,
  describeBlockers,
  packageAtAgency,
  paymentState,
  type PaymentSnapshot,
} from "@/lib/pickup-key";
import { keySendWindowOpen, pickupKeyMessage, type PickupKeyMessageFacts } from "@/lib/pickup-key-message";
import type { PaymentGateway } from "@/lib/payment-gateway";

/** Quién soltó la clave. Decide el texto del registro y si rige el interruptor. */
export type PickupKeyTrigger = "validar" | "estado_yape" | "ficha";

const TRIGGER_TEXT: Record<PickupKeyTrigger, { view: string; share: string; event: string; source: string }> = {
  validar: {
    view: "Enviada al cliente por WhatsApp al validar el pago.",
    share: "Enviada al validar el pago.",
    event: "al validar el pago",
    source: "system",
  },
  estado_yape: {
    view: "Enviada al cliente por WhatsApp al validar el pago con el estado de cuenta de Yape.",
    share: "Enviada al validar el pago con el estado de cuenta de Yape.",
    event: "al validar el pago con el estado de cuenta de Yape",
    source: "estado_yape",
  },
  ficha: {
    view: "Enviada al cliente por WhatsApp desde la ficha del pedido.",
    share: "Enviada desde la ficha del pedido.",
    event: "desde la ficha del pedido",
    source: "manual",
  },
};

export interface PickupKeyDeliveryInput {
  storeId: string;
  orderId: string;
  /** Quien lo causó; null cuando lo causa el estado de cuenta de Yape. */
  actor: string | null;
  trigger: PickupKeyTrigger;
  /** Un entrante que aún no dejó rastro en las dos tablas (el propio Yape). */
  extraInboundAt?: string | null;
  /** De dónde vino la petición, para el registro de consulta (0049). */
  request?: { ip: string | null; userAgent: string | null };
}

export interface PickupKeyDeliveryResult {
  sent: boolean;
  note: string;
  /** El pedido no tiene clave de recojo: no es de agencia o aún no se registró. */
  noKey?: boolean;
}

export interface KeyDeliveryContext {
  facts: PickupKeyMessageFacts;
  phone: string | null;
  /** Lo último que sabemos que escribió ella. Decide la ventana de 24 h. */
  lastInboundAt: string | null;
}

/**
 * Todo lo que el mensaje de la clave necesita saber del pedido, y desde cuándo
 * se le puede escribir. Ninguna lectura lanza: lo que falte sale como hueco y
 * el mensaje se escribe sin ello.
 */
export async function keyDeliveryContext(
  admin: SupabaseClient,
  storeId: string,
  orderId: string,
  /** Dónde está el paquete: el mensaje dice «ve ahora» o «cuando llegue». */
  pickupState: string | null,
): Promise<KeyDeliveryContext> {
  const [order, master, draft, shipment] = await Promise.all([
    admin.from("orders").select("name,customer_phone").eq("id", orderId).maybeSingle(),
    admin
      .from("order_master")
      .select("order_name,customer_name,customer_phone")
      .eq("order_id", orderId)
      .maybeSingle(),
    admin
      .from("shalom_order_drafts")
      .select("destiny_terminal_name")
      .eq("order_id", orderId)
      .maybeSingle(),
    admin
      .from("shipments")
      .select("guide_code,agency_branch,province,district,created_at")
      .eq("order_id", orderId)
      .eq("courier", "shalom")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const o = (order.data ?? null) as { name: string | null; customer_phone: string | null } | null;
  const m = (master.data ?? null) as {
    order_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
  } | null;
  const d = (draft.data ?? null) as { destiny_terminal_name: string | null } | null;
  const s = (shipment.data ?? null) as {
    guide_code: string | null;
    agency_branch: string | null;
    province: string | null;
    district: string | null;
  } | null;

  const phone = m?.customer_phone ?? o?.customer_phone ?? null;

  // CUÁNDO ESCRIBIÓ ELLA. No hay tabla de mensajes entrantes, pero sí dos
  // rastros que solo existen porque escribió: la respuesta automática que se le
  // mandó y la alerta que levantó su comprobante. Se toma el más reciente. Si
  // no consta ninguno, la ventana se da por cerrada y no se manda nada.
  const [replies, alerts] = phone
    ? await Promise.all([
        admin
          .from("wa_auto_replies")
          .select("created_at")
          .eq("store_id", storeId)
          .eq("phone", phone)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from("collection_alerts")
          .select("created_at")
          .eq("store_id", storeId)
          .eq("phone", phone)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
    : [{ data: null }, { data: null }];
  const marcas = [
    (replies.data as { created_at: string } | null)?.created_at ?? null,
    (alerts.data as { created_at: string } | null)?.created_at ?? null,
  ].filter((t): t is string => Boolean(t));

  return {
    facts: {
      customerName: m?.customer_name ?? null,
      orderName: m?.order_name ?? o?.name ?? null,
      agencyName:
        d?.destiny_terminal_name?.trim() ||
        s?.agency_branch?.trim() ||
        [s?.province, s?.district].filter(Boolean).join(" / ") ||
        null,
      guideCode: s?.guide_code ?? null,
      atAgency: packageAtAgency(pickupState),
    },
    phone,
    lastInboundAt: marcas.length
      ? marcas.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
      : null,
  };
}

/**
 * Manda la clave de recojo por WhatsApp y registra la entrega: la consulta
 * (`pickup_key_views`), el envío (`pickup_key_shares`) y el evento del pedido.
 */
export async function deliverPickupKey(
  admin: SupabaseClient,
  input: PickupKeyDeliveryInput,
): Promise<PickupKeyDeliveryResult> {
  const text = TRIGGER_TEXT[input.trigger];
  try {
    // Sin clave no hay nada que mandar, y esto es lo que distingue a casi todos
    // los pedidos que valida el estado de cuenta (no son de agencia): se mira
    // primero, antes de leer las credenciales de la tienda.
    const { data: keyRow } = await admin
      .from("shalom_pickup_keys")
      .select("key_enc")
      .eq("order_id", input.orderId)
      .maybeSingle();
    if (!keyRow) return { sent: false, noKey: true, note: "El pedido no tiene clave de recojo registrada." };

    const creds = await getStoreCreds(input.storeId, admin);
    // El interruptor es del envío AUTOMÁTICO: una persona que lo pide desde la
    // ficha decide ella, como cuando registra que la entregó a mano.
    if (input.trigger !== "ficha" && !creds?.shalom_pickup_key_autosend_enabled) {
      return { sent: false, note: "El envío automático de la clave está apagado en esta tienda." };
    }
    const phoneNumberId = creds?.shalom_transit_phone_number_id ?? creds?.whatsapp_phone_number_id;
    if (!creds?.kapso_api_key || !phoneNumberId) {
      return { sent: false, note: "La tienda no tiene WhatsApp configurado para enviarla." };
    }

    const [{ data: master }, { data: paymentRows }] = await Promise.all([
      admin
        .from("order_master")
        .select("general_status,pickup_state,order_total,financial_status,total_refunded,payment_state,payment_gateway")
        .eq("order_id", input.orderId)
        .maybeSingle(),
      admin
        .from("order_payments")
        .select("kind,validation_status,order_id,amount")
        .eq("order_id", input.orderId),
    ]);
    const row = master as {
      general_status: string;
      pickup_state: string | null;
      order_total: number | string | null;
      financial_status: string | null;
      total_refunded: number | string | null;
      payment_state: string | null;
      payment_gateway: PaymentGateway | null;
    } | null;
    if (!row) return { sent: false, note: "No se pudo releer el pedido para enviar la clave." };
    const orderTotal = row.order_total == null ? null : Number(row.order_total);
    const payments = (paymentRows ?? []) as PaymentSnapshot[];
    const verdict = canRevealPickupKey({
      orderId: input.orderId,
      generalStatus: row.general_status,
      pickupState: row.pickup_state,
      payments,
      orderTotal,
      hasKey: true,
      paymentFacts: {
        financialStatus: row.financial_status,
        totalRefunded: row.total_refunded == null ? null : Number(row.total_refunded),
        paymentState: row.payment_state,
        paymentGateway: row.payment_gateway,
      },
    });
    if (!verdict.allowed) {
      return { sent: false, note: `La clave no se envió: ${describeBlockers(verdict)}` };
    }

    const delivery = await keyDeliveryContext(admin, input.storeId, input.orderId, row.pickup_state);
    if (!delivery.phone) {
      return { sent: false, note: "La clave no se envió: el pedido no tiene celular." };
    }
    const nowIso = new Date().toISOString();
    const ultimo =
      [delivery.lastInboundAt, input.extraInboundAt ?? null]
        .filter((t): t is string => Boolean(t))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    if (!keySendWindowOpen(ultimo, nowIso)) {
      return {
        sent: false,
        note:
          "La clave NO se envió: la clienta no escribe hace más de 24 h y WhatsApp no deja " +
          "mandarle texto libre fuera de esa ventana. Entrégasela tú y regístralo.",
      };
    }

    const key = decryptOrNull((keyRow as { key_enc: string } | null)?.key_enc ?? null);
    if (!key) return { sent: false, note: "La clave no se pudo descifrar. Vuelve a registrarla." };

    const res = await sendWhatsappText(
      { apiKey: creds.kapso_api_key },
      { phoneNumberId, to: delivery.phone, body: pickupKeyMessage(delivery.facts, key) },
    );
    if (!res.ok) {
      return { sent: false, note: `La clave NO se envió (${res.error ?? "WhatsApp la rechazó"}).` };
    }

    // La consulta se anota igual que cuando la mira una persona: la clave se
    // descifró, y el marco de 0049 dice que eso queda registrado SIEMPRE, con
    // quién lo causó (nadie, cuando fue el estado de cuenta).
    await admin.from("pickup_key_views").insert({
      store_id: input.storeId,
      order_id: input.orderId,
      user_id: input.actor,
      ip: input.request?.ip ?? null,
      user_agent: input.request?.userAgent ?? null,
      reason: text.view,
      override: false,
      payment_state: {
        state: paymentState(payments, orderTotal),
        orderTotal,
        paidTotal: payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
        payments: payments.map((p) => ({
          kind: p.kind,
          status: p.validation_status,
          amount: p.amount,
        })),
        blockers: verdict.blockers,
      },
    });
    // Y EL ENVÍO ES EL REGISTRO: esta fila es la que se pedía con un segundo
    // clic que nadie daba —3 de 786 pedidos pagados la tenían—.
    await admin.from("pickup_key_shares").insert({
      store_id: input.storeId,
      order_id: input.orderId,
      shared_by: input.actor,
      channel: "whatsapp",
      confirmed: true,
      note: `${text.share}${res.id ? ` Mensaje ${res.id}.` : ""}`,
    });
    await admin.from("order_events").insert({
      store_id: input.storeId,
      order_id: input.orderId,
      kind: "key_shared",
      actor: input.actor,
      source: text.source,
      note: `Clave de recojo enviada por WhatsApp a ${delivery.phone} ${text.event}.`,
    });
    return { sent: true, note: `Clave de recojo enviada por WhatsApp a ${delivery.phone}.` };
  } catch (e) {
    return {
      sent: false,
      note: `La clave NO se envió (${e instanceof Error ? e.message : "fallo inesperado"}).`,
    };
  }
}
