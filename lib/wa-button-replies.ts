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
//
// LA ÚNICA EXCEPCIÓN: un «ok» pelado. No es texto libre que interpretar, es un
// acuse de recibo — no pregunta nada, no aporta dato nuevo, y el bot de ventas
// no tiene nada que hacer con él. Se vio en producción: una clienta contestó
// «Ok» al aviso y recibió «ya le paso tu consulta a una asesora», una
// derivación por nada; otra contestó «ok» y no recibió nada. Ahí se le repite
// el saldo y el Yape, una sola vez y dentro de las 48 h del aviso. La lista de
// acuses es CERRADA (`ACKS`), igual que los rótulos de los botones: cualquier
// frase fuera de ella sigue su camino hacia la asesora.

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
import { FlowClient } from "@/lib/flow/client";
import { ensureFlowPaymentLink } from "@/lib/flow/link";
import { env } from "@/lib/env";
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

/** Lo que sabemos del pedido al contestar. `saldo` ya viene con «S/»: acá no
 *  hay plantilla que lo escriba, es texto libre nuestro. `saldoValue` es el
 *  mismo número sin formato, porque cero hay que poder distinguirlo.
 *  `payLink` es el cobro de Flow.cl por ese saldo, cuando la tienda lo tiene
 *  encendido y la pasarela lo creó. */
export interface LinkContext {
  saldo: string | null;
  saldoValue: number | null;
  pedido: string | null;
  payLink?: string | null;
  /** Horas hasta que caduca el cobro, para decírselo en el mensaje. */
  payLinkHours?: number | null;
}

/**
 * El mensaje con el link de cobro, cuando no hay texto configurado en Ajustes.
 *
 * Dice cuándo caduca porque un link vencido sin aviso previo parece un error
 * nuestro, y porque es lo que empuja a pagar hoy. Pura.
 */
export function defaultPayLinkBody(link: string, hours: number | null | undefined): string {
  const vence =
    hours && hours > 0
      ? `\n\n⏱️ El link vence en ${hours === 1 ? "1 hora" : `${hours} horas`}.`
      : "";
  return `Puedes pagar aquí, con Yape o tarjeta:\n${link}${vence}`;
}

/**
 * La primera línea de la respuesta: cuánto debe.
 *
 * POR QUÉ SE REPITE. El importe ya iba en el aviso, pero la clienta pulsa el
 * botón minutos u horas después, con el mensaje largo ya fuera de pantalla. La
 * cifra tiene que estar pegada a la cuenta a la que va a pagar, no quince
 * líneas más arriba.
 *
 * Y SE RECALCULA: si pagó entre medias y alguien lo validó, aquí ya no debe
 * nada — y entonces enseñarle una cuenta es invitarla a pagar dos veces. Ese
 * caso se contesta con la buena noticia y sin números de cuenta.
 */
export function balanceHeader(link: LinkContext): { paid: boolean; line: string | null } {
  if (link.saldoValue == null || !link.saldo) return { paid: false, line: null };
  if (link.saldoValue <= 0) return { paid: true, line: null };
  return { paid: false, line: `💵 Saldo pendiente: ${link.saldo}` };
}

/** Lo que se contesta a quien ya no debe nada. Sin cuentas: dárselas sería
 *  invitarla a pagar de nuevo algo que ya pagó. */
export const ALREADY_PAID_REPLY =
  "✅ Tu pedido ya está pagado por completo, no tienes saldo pendiente. " +
  "Cuando llegue a la agencia solo tienes que acercarte a recogerlo.";

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
  link: LinkContext = { saldo: null, saldoValue: null, pedido: null },
): string | null {
  const yape = yapeQuickReply(methods);
  const saldo = balanceHeader(link);
  // Ya no debe nada: se le dice, y no se le enseña ninguna cuenta.
  if (saldo.paid) return ALREADY_PAID_REPLY;
  /** El saldo primero y la cuenta debajo, separados, para que se copie limpio. */
  const conSaldo = (cuerpo: string | null): string | null =>
    cuerpo ? [saldo.line, cuerpo].filter(Boolean).join("\n\n") : null;

  switch (button) {
    case "yape":
      return conSaldo(yape);
    case "transferencia":
      return conSaldo(formatTransferAccounts(methods));
    case "link_pago": {
      const tpl = String(cfg.paymentLinkTemplate ?? "").trim();
      const cobro = link.payLink ?? null;
      // Sin texto configurado: el cobro de Flow si lo hay, y si no el Yape.
      // Nunca el silencio — un botón que no contesta parece un chat roto.
      if (!tpl) return conSaldo(cobro ? defaultPayLinkBody(cobro, link.payLinkHours) : yape);
      // Un texto que pide `{link}` y no tiene link no se manda a medias: sería
      // mandarle una frase que promete un enlace que no está.
      if (/\{link\}/i.test(tpl) && !cobro) return conSaldo(yape);
      return tpl
        .replace(/\{saldo\}/gi, link.saldo ?? "")
        .replace(/\{pedido\}/gi, link.pedido ?? "")
        .replace(/\{yape\}/gi, yapeNumberParam(methods) ?? "")
        .replace(/\{link\}/gi, cobro ?? "")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    }
  }
}

/**
 * Los «ok» que no preguntan nada.
 *
 * POR QUÉ UNA LISTA CERRADA Y NO «cualquier texto». Interpretar texto libre es
 * justo lo que este módulo no hace: un «¿me llegó mal el producto?» tiene que
 * ir a la asesora, y contestarle con un número de Yape sería atropellarla.
 * Pero un «ok» pelado no es una consulta: no lleva pregunta, no lleva dato
 * nuevo, y el bot de ventas no tiene nada útil que hacer con él —se vio en el
 * chat de Richard, que contestó «Ok» y recibió «ya le paso tu consulta a una
 * asesora», una derivación por nada—. Ahí el mensaje que sirve es el que ya
 * sabemos: cuánto debe y a dónde pagarlo.
 */
const ACKS = new Set([
  "ok",
  "oka",
  "okey",
  "okay",
  "oki",
  "ok gracias",
  "okey gracias",
  "ya",
  "ya esta",
  "ya ok",
  "listo",
  "listo gracias",
  "bien",
  "buenoentendido",
  "entendido",
  "entendido gracias",
  "de acuerdo",
  "perfecto",
  "dale",
  "gracias",
  "muchas gracias",
  "gracias ok",
  "si",
  "sí",
  "si gracias",
  "correcto",
  "conforme",
]);

/**
 * ¿Es un acuse de recibo y nada más? Pura.
 *
 * Un mensaje de solo emojis (👍, 🙏) cuenta: dice exactamente lo mismo que un
 * «ok». `key()` se los come enteros, así que un texto que queda vacío después
 * de normalizar —y no estaba vacío antes— es eso.
 */
export function isAcknowledgement(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  // Un mensaje largo no es un «ok» aunque empiece por uno.
  if (raw.length > 40) return false;
  const k = key(raw);
  if (!k) return true;
  return ACKS.has(k);
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
    ensureLink?: typeof ensureFlowPaymentLink;
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
  if (button) return replyToButton(admin, storeId, creds, msg, button, opts);

  // Un «ok» después del aviso: se le repite lo que necesita para pagar.
  if (!msg.buttonText && !msg.buttonPayload && isAcknowledgement(msg.text)) {
    return replyToAck(admin, storeId, creds, msg, opts);
  }

  return { reason: "not_a_payment_button" };
}

/** Cuántas horas después del aviso un «ok» se sigue leyendo como respuesta a
 *  ese aviso. Pasadas, es una conversación nueva y no nuestra. */
const ACK_WINDOW_HOURS = 48;

/**
 * Contesta un «ok» con el saldo y el Yape, UNA sola vez por aviso.
 *
 * Las dos rejas son lo que lo hace inofensivo:
 *
 *  1. Tiene que haber un aviso enviado a ese celular en las últimas 48 h. Sin
 *     eso, el «ok» es de otra conversación y no nos incumbe.
 *  2. Y no haberle contestado ya —ni por botón ni por otro «ok»— desde ese
 *     aviso. Repetirle el número de Yape a cada «gracias» es acoso, no ayuda.
 */
async function replyToAck(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  msg: InboundMessage,
  opts: { sendText?: typeof sendWhatsappText; nowIso?: string },
): Promise<InboundResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const link = await latestTransitContext(admin, storeId, msg.from);
  if (!link.sentAt) return { reason: "ack_sin_aviso" };
  if (Date.parse(nowIso) - Date.parse(link.sentAt) > ACK_WINDOW_HOURS * 3600 * 1000) {
    return { reason: "ack_fuera_de_ventana" };
  }

  const { data: yaContestado } = await admin
    .from("wa_auto_replies")
    .select("id")
    .eq("store_id", storeId)
    .eq("phone", msg.from)
    .eq("ok", true)
    .gte("created_at", link.sentAt)
    .limit(1)
    .maybeSingle();
  if (yaContestado) return { reason: "ack_ya_contestado" };

  const send = opts.sendText ?? sendWhatsappText;
  const phoneNumberId = msg.phoneNumberId ?? creds.whatsapp_phone_number_id;
  if (!creds.kapso_api_key || !phoneNumberId) return { reason: "store_not_configured" };

  const methods = await loadStorePaymentMethods(admin, storeId);
  const text = buildButtonReply("yape", methods, { paymentLinkTemplate: null }, link.ctx);
  if (!text) return { reason: "no_payment_methods" };

  // La reserva va DESPUÉS de las rejas y antes de hablar, igual que en los
  // botones: si Kapso reentrega el mismo `wamid`, la unique lo para.
  const { error: claimError } = await admin.from("wa_auto_replies").insert({
    store_id: storeId,
    inbound_message_id: msg.id,
    phone: msg.from,
    phone_number_id: phoneNumberId,
    trigger: "ack",
    order_id: link.orderId,
  });
  if (claimError) {
    if (claimError.code === "23505") return { reason: "duplicate_inbound" };
    return { reason: `claim_failed:${claimError.message}` };
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
  await admin
    .from("wa_auto_replies")
    .update({ body: text, ok, error, provider_message_id: providerId })
    .eq("store_id", storeId)
    .eq("inbound_message_id", msg.id);

  return { reason: ok ? "replied:ack" : `reply_failed:${error}` };
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
    ensureLink?: typeof ensureFlowPaymentLink;
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
  // El cobro por pasarela se crea SOLO para el botón que lo pide: crear una
  // orden cobrable es un efecto, y no se dispara por pulsar «Yape».
  const ctx: LinkContext =
    button === "link_pago" ? { ...link.ctx, ...(await resolvePayLink(admin, storeId, creds, link, opts)) } : link.ctx;
  const text = buildButtonReply(button, methods, { paymentLinkTemplate: creds.shalom_transit_payment_link }, ctx);
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

  // Y el ticket de Shalom detrás, CON CADA BOTÓN y no solo con el primero.
  //
  // POR QUÉ SE REPITE. Quien pulsa «Transferencia» después de «Yape» está
  // mirando esa segunda respuesta, y el ticket que llegó con la primera ya
  // quedó arriba. Es el mismo documento puesto donde se está mirando, que es
  // justo el problema que resolvió sacarlo de la cabecera del aviso.
  //
  // Va DESPUÉS del texto y sin poder tumbarlo: lo que la clienta necesita para
  // pagar son las cuentas; el ticket es el respaldo. Si falla —guía sin OSE ID,
  // Shalom caído— queda el motivo en la fila del aviso y el mensaje útil ya
  // salió. El PDF sale de la caché, así que repetirlo no cuesta otra llamada.
  let ticket = "";
  if (link.notificationId && link.shipmentId) {
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

/**
 * El cobro de Flow.cl por el saldo de HOY, para el botón «Link de pago».
 *
 * TODO ES UN «NO» SILENCIOSO salvo el camino bueno: sin interruptor, sin
 * credenciales, sin pedido, sin saldo o con la pasarela caída, se devuelve
 * `null` y la respuesta cae al Yape. Una clienta que pulsa un botón tiene que
 * recibir algo con lo que pagar; que la pasarela falle no puede costarle eso.
 * Lo que sí queda es la anomalía, para que se vea al día siguiente.
 */
async function resolvePayLink(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  ctx: TransitContext,
  opts: { ensureLink?: typeof ensureFlowPaymentLink; nowIso?: string },
): Promise<{ payLink: string | null; payLinkHours: number | null }> {
  const NADA = { payLink: null, payLinkHours: null };
  if (!creds.flowcl_link_enabled) return NADA;
  if (!creds.flowcl_api_key || !creds.flowcl_secret_key || !creds.flowcl_webhook_secret) {
    await noteAnomaly(admin, {
      storeId,
      source: "inbound_message",
      reason: "flowcl_sin_credenciales",
      sample: { orderId: ctx.orderId },
    });
    return NADA;
  }
  const saldo = ctx.ctx.saldoValue;
  if (!ctx.orderId || saldo == null || !(saldo > 0)) return NADA;

  const email = (await customerEmail(admin, ctx.orderId)) ?? creds.flowcl_link_email ?? "";
  const ensure = opts.ensureLink ?? ensureFlowPaymentLink;
  const res = await ensure(
    admin,
    {
      storeId,
      orderId: ctx.orderId,
      orderName: ctx.ctx.pedido,
      // Es el saldo de un pedido ya despachado: lo que falta, no un adelanto.
      kind: "diferencia",
      amount: saldo,
      email,
      ttlHours: creds.flowcl_link_ttl_hours,
      yapeOnly: creds.flowcl_link_yape_only,
      subject: `Saldo del pedido ${ctx.ctx.pedido ?? ""}`.trim(),
      currency: creds.currency,
    },
    {
      client: new FlowClient({
        apiKey: creds.flowcl_api_key,
        secretKey: creds.flowcl_secret_key,
        baseUrl: env.flowclApiBase(),
      }),
      siteUrl: env.siteUrl(),
      webhookSecret: creds.flowcl_webhook_secret,
      nowIso: opts.nowIso,
    },
  );
  if (!res.ok) {
    await noteAnomaly(admin, {
      storeId,
      source: "inbound_message",
      reason: "flowcl_link_fallido",
      sample: { orderId: ctx.orderId, motivo: res.reason },
    });
    return NADA;
  }
  return { payLink: res.link, payLinkHours: creds.flowcl_link_ttl_hours };
}

/** El email del pedido, si lo trae. Casi nunca: los pedidos entran por
 *  WhatsApp y ahí nadie pide un correo. Por eso hay uno de respaldo. */
async function customerEmail(admin: SupabaseClient, orderId: string): Promise<string | null> {
  const { data } = await admin
    .from("orders")
    .select("contacto:raw->>contact_email,cliente:raw->customer->>email")
    .eq("id", orderId)
    .maybeSingle();
  const row = (data ?? null) as { contacto: string | null; cliente: string | null } | null;
  const email = (row?.contacto ?? row?.cliente ?? "").trim();
  return email || null;
}

/** Lo que hace falta del último aviso: de qué pedido habla, cuánto debe HOY y a
 *  qué guía pedirle el ticket. */
interface TransitContext {
  ctx: LinkContext;
  orderId: string | null;
  notificationId: string | null;
  shipmentId: string | null;
  /** Cuándo salió ese aviso: la ventana del «ok» se mide desde aquí. */
  sentAt: string | null;
}

const SIN_SALDO: LinkContext = { saldo: null, saldoValue: null, pedido: null };

const SIN_AVISO: TransitContext = {
  ctx: SIN_SALDO,
  orderId: null,
  notificationId: null,
  shipmentId: null,
  sentAt: null,
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
    .select("id,order_id,shipment_id,sent_at")
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
    sent_at: string | null;
  } | null;
  if (!row) return SIN_AVISO;
  const base = {
    orderId: row.order_id,
    notificationId: row.id,
    shipmentId: row.shipment_id,
    sentAt: row.sent_at,
  };
  if (!row.order_id) return { ...base, ctx: SIN_SALDO };

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

  const saldo = pendingBalance(m?.order_total ?? null, validated);
  return {
    ...base,
    ctx: { saldo: moneyLabel(saldo), saldoValue: saldo, pedido: m?.order_name ?? null },
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
