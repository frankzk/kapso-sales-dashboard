// Respuestas automáticas a los botones del aviso de guía en tránsito (MOM §12).
//
// La plantilla `guias_shalom` termina con tres botones: «Pagar con Yape»,
// «Transferencia Depósito» y «Link de pago». Un botón pulsado llega como un
// mensaje entrante de tipo `button` (o `interactive`) por el webhook de Kapso, y
// abre la ventana de 24 h — así que se contesta con texto libre, sin plantilla.
//
// POR QUÉ CONTESTA KAPTA Y NO EL BOT. Las cuentas viven en Ajustes de la tienda
// (`store_payment_methods`, 0166): un solo sitio donde cambiarlas. Hasta ahora
// el número de cuenta lo decía el bot de Kapso, escrito a mano en su función, y
// el día que cambie se cambiará en uno de los dos sitios. La regla de este
// módulo es que el dato tiene UN dueño; el bot puede leerlo de aquí, no
// duplicarlo.
//
// LO QUE NO HACE: interpretar texto libre. Solo reacciona a un BOTÓN con uno de
// los tres rótulos. Un cliente que escribe «yape» a mano sigue con el bot y la
// asesora, como siempre — meterse ahí es justo el choque de dos voces que
// docs/kapso-functions/README.md advierte.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { noteAnomaly } from "@/lib/ingest-anomalies";
import { parseInboundMessage, sendWhatsappText, type InboundMessage } from "@/lib/kapso";
import {
  formatTransferAccounts,
  loadStorePaymentMethods,
  yapeNumberParam,
  yapeQuickReply,
  type PaymentMethod,
} from "@/lib/payment-methods";
import { moneyLabel, pendingBalance, sendTransitTicket } from "@/lib/shalom/transit-notify";
import type { sendWhatsappDocument } from "@/lib/kapso";

export type PaymentButton = "yape" | "transferencia" | "link_pago";

/** Sin acentos, minúsculas y sin signos: «Transferencia Depósito» y
 *  «transferencia deposito» son el mismo botón. */
function key(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Qué botón es, o `null`. Se compara el rótulo (o el payload, que en las
 * quick replies de Meta es el mismo texto). Solo rótulos EXACTOS: un mensaje
 * que contenga «yape» en medio de una frase no es un botón. Pura.
 */
export function matchPaymentButton(
  buttonText: string | null | undefined,
  buttonPayload?: string | null,
): PaymentButton | null {
  for (const raw of [buttonText, buttonPayload]) {
    const k = key(String(raw ?? ""));
    if (!k) continue;
    if (k === "pagar con yape" || k === "yape") return "yape";
    if (
      k === "transferencia deposito" ||
      k === "transferencia o deposito" ||
      k === "transferencia" ||
      k === "deposito"
    ) {
      return "transferencia";
    }
    if (k === "link de pago" || k === "link pago" || k === "enlace de pago") return "link_pago";
  }
  return null;
}

/** Lo que el link de pago puede interpolar. `saldo` ya viene con «S/»: acá no
 *  hay plantilla que lo escriba, es texto libre nuestro. */
export interface LinkContext {
  saldo: string | null;
  pedido: string | null;
}

/**
 * El texto que se contesta a cada botón. Pura: recibe las cuentas y la config.
 *
 * - Yape: una línea, para copiar de un vistazo.
 * - Transferencia: todas las cuentas activas.
 * - Link de pago: el texto configurado en la tienda con {saldo}, {pedido} y
 *   {yape} sustituidos. Sin configurar, cae al aviso de Yape — nunca al
 *   silencio: un botón que no contesta nada parece un chat roto.
 *
 * `null` cuando no hay ninguna cuenta configurada: ahí no hay nada verdadero
 * que decir, y se registra como anomalía en vez de inventarse una cuenta.
 */
export function buildButtonReply(
  button: PaymentButton,
  methods: readonly PaymentMethod[],
  cfg: { paymentLinkTemplate: string | null | undefined },
  link: LinkContext = { saldo: null, pedido: null },
): string | null {
  const yape = yapeQuickReply(methods);
  switch (button) {
    case "yape":
      return yape;
    case "transferencia":
      return formatTransferAccounts(methods);
    case "link_pago": {
      const tpl = String(cfg.paymentLinkTemplate ?? "").trim();
      if (!tpl) return yape;
      return tpl
        .replace(/\{saldo\}/gi, link.saldo ?? "")
        .replace(/\{pedido\}/gi, link.pedido ?? "")
        .replace(/\{yape\}/gi, yapeNumberParam(methods) ?? "")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    }
  }
}

export interface InboundResult {
  reason: string;
}

/**
 * Atiende un mensaje entrante del webhook. Nunca lanza: el webhook tiene que
 * contestar 200 a Kapso pase lo que pase, y lo que no se entienda se registra
 * como anomalía para que se vea al día siguiente.
 */
export async function handleInboundMessage(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  body: unknown,
  opts: {
    sendText?: typeof sendWhatsappText;
    sendDocument?: typeof sendWhatsappDocument;
    nowIso?: string;
  } = {},
): Promise<InboundResult> {
  const msg = parseInboundMessage(body);
  if (!msg) {
    await noteAnomaly(admin, {
      storeId,
      source: "inbound_message",
      reason: "sin_id_o_remitente",
      sample: sampleOf(body),
    });
    return { reason: "unparsed" };
  }

  const button = matchPaymentButton(msg.buttonText, msg.buttonPayload);
  if (!button) return { reason: "not_a_payment_button" };

  return replyToButton(admin, storeId, creds, msg, button, opts);
}

async function replyToButton(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  msg: InboundMessage,
  button: PaymentButton,
  opts: {
    sendText?: typeof sendWhatsappText;
    sendDocument?: typeof sendWhatsappDocument;
    nowIso?: string;
  },
): Promise<InboundResult> {
  const send = opts.sendText ?? sendWhatsappText;

  // Reservar el mensaje ANTES de contestar. Kapso reintenta los webhooks, y dos
  // entregas del mismo `wamid` en paralelo contestarían dos veces; con la
  // unique, la segunda inserción falla y se va sin hablar.
  const { error: claimError } = await admin.from("wa_auto_replies").insert({
    store_id: storeId,
    inbound_message_id: msg.id,
    phone: msg.from,
    phone_number_id: msg.phoneNumberId,
    trigger: button,
  });
  if (claimError) {
    if (claimError.code === "23505") return { reason: "duplicate_inbound" };
    return { reason: `claim_failed:${claimError.message}` };
  }

  const finish = async (patch: Record<string, unknown>): Promise<void> => {
    await admin
      .from("wa_auto_replies")
      .update(patch)
      .eq("store_id", storeId)
      .eq("inbound_message_id", msg.id);
  };

  const phoneNumberId = msg.phoneNumberId ?? creds.whatsapp_phone_number_id;
  if (!creds.kapso_api_key || !phoneNumberId) {
    await finish({ error: "la tienda no tiene API key de Kapso o número de WhatsApp" });
    return { reason: "store_not_configured" };
  }

  const methods = await loadStorePaymentMethods(admin, storeId);
  const link = await latestTransitContext(admin, storeId, msg.from);
  const text = buildButtonReply(button, methods, { paymentLinkTemplate: creds.shalom_transit_payment_link }, link.ctx);
  if (!text) {
    await finish({ order_id: link.orderId, error: "la tienda no tiene cuentas de cobro configuradas" });
    await noteAnomaly(admin, {
      storeId,
      source: "inbound_message",
      reason: "sin_cuentas_de_cobro",
      sample: { button, phone: msg.from },
    });
    return { reason: "no_payment_methods" };
  }

  let ok = false;
  let error: string | null = null;
  let providerId: string | null = null;
  try {
    const res = await send({ apiKey: creds.kapso_api_key }, { phoneNumberId, to: msg.from, body: text });
    ok = res.ok;
    if (res.ok) providerId = res.id;
    else error = res.error ?? "envío rechazado";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await finish({ order_id: link.orderId, body: text, ok, error, provider_message_id: providerId });
  if (!ok) return { reason: `reply_failed:${error}` };

  // Y el ticket de Shalom detrás, una sola vez por guía. Va DESPUÉS del texto y
  // sin poder tumbarlo: lo que la clienta necesita para pagar son las cuentas;
  // el ticket es el respaldo. Si falla —guía sin OSE ID, Shalom caído— queda el
  // motivo en la fila del aviso y el mensaje útil ya salió.
  let ticket = "";
  if (link.notificationId && link.shipmentId && !link.ticketAlreadySent) {
    const res = await sendTransitTicket(
      admin,
      {
        notificationId: link.notificationId,
        shipmentId: link.shipmentId,
        storeId,
        phone: msg.from,
        phoneNumberId,
        apiKey: creds.kapso_api_key,
      },
      { sendDocument: opts.sendDocument, nowIso: opts.nowIso },
    );
    ticket = res.sent ? ";ticket:enviado" : `;ticket:${res.reason}`;
  }

  return { reason: `replied:${button}${ticket}` };
}

/** Lo que hace falta del último aviso: de qué pedido habla, qué saldo debe hoy,
 *  y si a esa guía ya se le mandó su ticket. */
interface TransitContext {
  ctx: LinkContext;
  orderId: string | null;
  notificationId: string | null;
  shipmentId: string | null;
  ticketAlreadySent: boolean;
}

const SIN_AVISO: TransitContext = {
  ctx: { saldo: null, pedido: null },
  orderId: null,
  notificationId: null,
  shipmentId: null,
  ticketAlreadySent: false,
};

/**
 * El último aviso enviado a este celular, para que «Link de pago» sepa de qué
 * pedido y qué saldo habla, y para saber a qué guía mandarle el ticket. Sin
 * aviso previo se contesta igual, sin cifras y sin ticket — el botón pudo venir
 * de otra conversación.
 */
async function latestTransitContext(
  admin: SupabaseClient,
  storeId: string,
  phone: string,
): Promise<TransitContext> {
  const { data } = await admin
    .from("shalom_transit_notifications")
    .select("id,order_id,shipment_id,ticket_sent_at")
    .eq("store_id", storeId)
    .eq("phone", phone)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = (data ?? null) as {
    id: string;
    order_id: string | null;
    shipment_id: string;
    ticket_sent_at: string | null;
  } | null;
  if (!row) return SIN_AVISO;
  const base = {
    orderId: row.order_id,
    notificationId: row.id,
    shipmentId: row.shipment_id,
    ticketAlreadySent: Boolean(row.ticket_sent_at),
  };
  if (!row.order_id) return { ...base, ctx: { saldo: null, pedido: null } };

  // El saldo se RECALCULA, no se lee del aviso. Entre el aviso y el botón puede
  // haber pagado y alguien haberlo validado, y lo que la clienta quiere pagar
  // ahora es lo que debe ahora. (Antes se sacaba del parámetro con forma de
  // importe; con los importes ya sin «S/» —los escribe la plantilla— ese truco
  // dejó de funcionar, y recalcular es además la respuesta correcta.)
  const [master, payments] = await Promise.all([
    admin.from("order_master").select("order_name,order_total").eq("order_id", row.order_id).maybeSingle(),
    admin.from("order_payments").select("amount,validation_status").eq("order_id", row.order_id),
  ]);
  const m = (master.data ?? null) as { order_name: string | null; order_total: number | null } | null;
  const validated = ((payments.data ?? []) as { amount: number | null; validation_status: string }[])
    .filter((p) => p.validation_status === "validado")
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);

  return {
    ...base,
    ctx: {
      saldo: moneyLabel(pendingBalance(m?.order_total ?? null, validated)),
      pedido: m?.order_name ?? null,
    },
  };
}

function sampleOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(body).slice(0, 2000)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
