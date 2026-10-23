// El aviso por WhatsApp cuando la guía de Shalom sale en tránsito (MOM §12).
//
// EL HUECO QUE TAPA. El cron de reconciliación ya se entera de que la guía
// pasó a `en_transito` y escribe `courier_status` en la línea de tiempo. Ahí se
// quedaba: la clienta no recibía nada, y el saldo pendiente —lo que decide si
// va a poder recoger— se cobraba a mano, chat por chat, cuando alguien se
// acordaba. En #KP133540 el tránsito se registró el 11/09 a las 11:46 y el
// saldo lo cobró una asesora el 15/09.
//
// DOS PASOS, NO UNO. El cron ENCOLA (`enqueueTransitNotification`) en el
// instante del tránsito y otro paso ENVÍA (`processTransitNotifications`).
// Separados a propósito: el envío puede necesitar bajar el ticket de Shalom
// (~45 s) y puede fallar por Meta, y el tránsito solo ocurre una vez. Si el
// envío fuera en línea con el rastreo, un fallo transitorio perdería el aviso
// para siempre — el cron no vuelve a ver la misma transición.
//
// UNA VEZ POR GUÍA. La unique de `shalom_transit_notifications.shipment_id`
// es la garantía: encolar dos veces no hace nada, y un envío aceptado por Meta
// cierra la fila.
//
// LO QUE NUNCA VA EN EL MENSAJE: la clave de recojo. Se entrega desde la
// salida, con el cobro validado y con auditoría (§12). Este aviso da guía,
// código y agencia, que sin la clave no abren nada.
//
// TAMBIÉN OLVA (0175). La cola, el envío, el horario, el número y los botones
// de cobro son los mismos; lo que cambia por courier es la PLANTILLA —Meta
// aprueba cada texto aparte— y los datos que la rellenan: la «guía» de Olva es
// su tracking («2552504-26»), no tiene código corto ni ticket, y devuelve a los
// 6 días y no a los 28. Por eso cada fila de la cola dice de qué courier es.
//
// Y UN TERCER AVISO: EL RECORDATORIO DE RECOJO (0242). El de llegada sale una
// vez y después nada; al 10-10-2026 Kenku tenía 230 pedidos en la agencia
// debiendo S/ 37.087. El recordatorio sale al día 3 y al día 7 de la llegada
// (Olva, que devuelve a los 6, solo el del 3) a quien sigue en la agencia y
// debe saldo. Son dos `kind` de esta misma cola —`recordatorio_d3` y
// `recordatorio_d7`—, así que la unique (shipment_id, kind) los deja salir una
// vez cada uno, y comparten número, horario, tope y botones con los otros dos.
// Lo encola `lib/shalom/pickup-reminder.ts`; aquí solo se envía. Su plantilla
// lleva la FOTO del producto en la cabecera.

import type { SupabaseClient } from "@supabase/supabase-js";
import { OLVA_PICKUP_WINDOW_DAYS, formatOlvaTracking } from "@/lib/olva/tracking";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";
import type { StoreCreds } from "@/lib/ingest";
import { getStoreCreds } from "@/lib/ingest";
import { sendWhatsappDocument, sendWhatsappTemplate, type WhatsappSendResult } from "@/lib/kapso";
import { isSendablePhone, sanitizeTemplateParam } from "@/lib/leads-ingest";
import { parseLabelLineItems } from "@/lib/labels/line-items";
import { tzParts } from "@/lib/metrics";
import { loadStorePaymentMethods, yapeNumberParam } from "@/lib/payment-methods";
import { isWebPrepaid } from "@/lib/order-paid";
import type { PaymentGateway } from "@/lib/payment-gateway";
import { replyFirstName } from "@/lib/wa-reply-templates";
import { shalomVoucherPdf, signedDocUrl } from "@/lib/shalom/label-cache";
import { loadStoreShalom } from "@/lib/shalom/session";
import { firstProductWithImage, waImageUrl, type CatalogImage } from "@/lib/cart-image-test";
import { isShopifyCdnUrl, productPhotosThatLoad } from "@/lib/product-photos";
import { AGENCY_AVAILABLE_STATES } from "@/lib/order-master-filters";
import { env } from "@/lib/env";

/** Los tokens que pueden ir en `stores.shalom_transit_params`. */
export const TRANSIT_TOKENS = [
  "nombre",
  "guia",
  "codigo",
  "producto",
  "agencia",
  "total",
  "adelanto",
  "saldo",
  "yape",
  // Solo del aviso de llegada: la fecha límite de recojo.
  "vence",
] as const;
export type TransitToken = (typeof TRANSIT_TOKENS)[number];

/** Los dos recordatorios de recojo (0242): al día 3 y al día 7 de la llegada.
 *  Dos `kind` y no uno con contador: así la unique (shipment_id, kind) que ya
 *  existe garantiza que cada uno salga como mucho una vez por guía. */
export const REMINDER_KINDS = ["recordatorio_d3", "recordatorio_d7"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Qué aviso es. Comparten cola, número, horario y cuentas; el texto no. Es
 *  la misma lista que el `check` de `shalom_transit_notifications.kind`. */
export const NOTICE_KINDS = ["transito", "disponible", ...REMINDER_KINDS] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export function isReminderKind(kind: string | null | undefined): kind is ReminderKind {
  return (REMINDER_KINDS as readonly string[]).includes(String(kind ?? ""));
}

/** El `kind` de una fila de la cola. Sin decirlo es el de tránsito: es el que
 *  ya existía antes de la 0170. */
export function parseNoticeKind(raw: string | null | undefined): NoticeKind {
  return (NOTICE_KINDS as readonly string[]).includes(String(raw ?? "")) ? (raw as NoticeKind) : "transito";
}

/** De qué courier es la guía. Decide la plantilla y los datos; nada más. */
export type NoticeCourier = "shalom" | "olva";

/** El orden de `guias_shalom` tal como se aprobó en Meta. */
export const TRANSIT_DEFAULT_PARAMS = TRANSIT_TOKENS.filter((t) => t !== "vence").join(",");
/** El de Olva: lo mismo sin `codigo`, que Olva no tiene. */
export const OLVA_TRANSIT_DEFAULT_PARAMS = TRANSIT_TOKENS.filter((t) => t !== "vence" && t !== "codigo").join(",");
/** El del recordatorio de recojo (0242), igual para Shalom y Olva: {{1}}
 *  nombre, {{2}} agencia, {{3}} guía, {{4}} saldo, {{5}} fecha límite. */
export const REMINDER_DEFAULT_PARAMS = "nombre,agencia,guia,saldo,vence";
/** Los nombres de plantilla por omisión del recordatorio (0242). */
export const REMINDER_DEFAULT_TEMPLATE: Record<NoticeCourier, string> = {
  shalom: "guias_shalom_recordatorio",
  olva: "guias_olva_recordatorio",
};

/** Días que Shalom guarda el paquete antes de devolverlo (MOM §12). */
export const PICKUP_WINDOW_DAYS = 28;

/** Cuántos días guarda el paquete cada courier (MOM §12). */
export function pickupWindowDays(courier: NoticeCourier): number {
  return courier === "olva" ? OLVA_PICKUP_WINDOW_DAYS : PICKUP_WINDOW_DAYS;
}

/**
 * «12 de octubre» — hasta cuándo puede recogerlo, en hora de Lima.
 *
 * POR QUÉ UNA FECHA Y NO «te quedan 12 días». La clienta lee el mensaje hoy y
 * lo vuelve a mirar el jueves; un contador relativo envejece mal dentro de un
 * WhatsApp que se queda en el chat. Una fecha sigue siendo cierta mañana.
 *
 * Devuelve «» si no se sabe cuándo llegó: sin ese dato no se inventa un plazo,
 * y `transitBodyParams` nombrará el hueco antes de gastar el envío. Pura.
 */
export function pickupDeadlineLabel(
  arrivedAtIso: string | null | undefined,
  timeZone: string,
  days: number = PICKUP_WINDOW_DAYS,
): string {
  if (!arrivedAtIso) return "";
  const t = Date.parse(arrivedAtIso);
  if (!Number.isFinite(t)) return "";
  const limite = new Date(t + days * 24 * 3600 * 1000);
  try {
    return new Intl.DateTimeFormat("es-PE", { timeZone, day: "numeric", month: "long" }).format(limite);
  } catch {
    return "";
  }
}

/** Cuántas veces se reintenta un envío antes de darlo por perdido. */
export const TRANSIT_MAX_ATTEMPTS = 5;
/** Tope de envíos por pasada del cron: cada uno puede costar una bajada del
 *  ticket, y el cron comparte sus 300 s con el rastreo. */
export const TRANSIT_BATCH_CAP = 20;

/**
 * Cuántos avisos más se pueden mandar AHORA sin pasar ninguno de los dos
 * topes de la tienda (0194). Pura.
 *
 * POR QUÉ HAY TOPE. El 28-09-2026 WhatsApp bloqueó el 600, el número desde el
 * que salían estos avisos: venía mandando 50-75 plantillas al día a clientas
 * que nunca le habían escrito. El número que lo reemplace es nuevo, y uno
 * nuevo tiene que empezar despacio. El de 24 h es el que mide Meta; el de una
 * hora reparte el día para que no salgan todos en la primera pasada del cron.
 *
 * Un tope ausente (`null`) no limita: así se comportaban las tiendas antes, y
 * es lo que ven las pruebas que no hablan de topes.
 */
export function noticeCapLeft(input: {
  sentLast24h: number;
  sentLastHour: number;
  dailyCap: number | null | undefined;
  hourlyCap: number | null | undefined;
}): number {
  const quedan = [
    input.dailyCap == null ? Infinity : input.dailyCap - input.sentLast24h,
    input.hourlyCap == null ? Infinity : input.hourlyCap - input.sentLastHour,
  ];
  return Math.max(0, Math.min(...quedan));
}
/** La URL firmada del ticket vive lo que Meta tarda en bajarlo, con margen. */
const TICKET_URL_SECONDS = 7 * 24 * 3600;

/** Parsea la config de tokens. Los desconocidos se ignoran: una tienda mal
 *  configurada manda un parámetro de menos —Meta lo rechaza con un error
 *  legible— y no tumba la corrida entera. */
export function parseTransitParams(raw: string | null | undefined): TransitToken[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is TransitToken => (TRANSIT_TOKENS as readonly string[]).includes(t));
}

/**
 * «89.10» — el importe SIN el símbolo, que es lo que va en un parámetro de la
 * plantilla.
 *
 * POR QUÉ SIN «S/». Las dos plantillas aprobadas ya lo escriben ellas:
 *
 *     💰 Monto total del pedido: S/ {{6}}
 *
 * así que mandar «S/ 89.10» en `{{6}}` le enseña a la clienta «S/ S/ 89.10».
 * La línea es esa: Kapta pone el DATO y la plantilla pone la presentación. Si
 * algún día se aprueba una plantilla que no escriba el símbolo, se añade el
 * token que lo lleve — no se cambia este, o vuelve el doble prefijo.
 *
 * CERO es un valor válido: un adelanto de S/ 0.00 o un saldo de S/ 0.00 son
 * datos ciertos que la clienta tiene que ver, no un hueco.
 */
export function amountValue(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount) || amount < 0) return "";
  return Number(amount).toFixed(2);
}

/**
 * «S/ 89.10» — con el símbolo, para el TEXTO LIBRE que escribe Kapta (la
 * respuesta al botón «Link de pago»). Ahí no hay plantilla que lo ponga.
 */
export function moneyLabel(amount: number | null | undefined): string {
  const v = amountValue(amount);
  return v ? `S/ ${v}` : "";
}

/**
 * «2× Zapatilla Runner (39-40), 1× Medias». Cantidad y variante, que es lo
 * que la clienta reconoce; el copy publicitario de Shopify no. Cabe en los
 * 120 caracteres que aceptamos por parámetro.
 */
export function productsLabel(lineItems: unknown): string {
  const items = parseLabelLineItems(lineItems);
  if (!items.length) return "";
  const parts = items.map((it) => {
    const variant = it.variant ? ` (${it.variant})` : "";
    return `${it.quantity}× ${it.name}${variant}`;
  });
  return sanitizeTemplateParam(parts.join(", "));
}

/** Los hechos de los que se rellena la plantilla. */
export interface TransitFacts {
  customerName: string | null;
  guideCode: string | null;
  shalomCodigo: string | null;
  lineItems: unknown;
  agencyName: string | null;
  orderTotal: number | null;
  validatedAmount: number | null;
  yapeNumber: string | null;
  /** Ya formateada; solo la usa el aviso de llegada. */
  pickupDeadline?: string | null;
}

/** El saldo pendiente: total menos lo VALIDADO, nunca negativo. `null` cuando
 *  no se sabe el total. Pura — la usan la plantilla y la respuesta al botón. */
export function pendingBalance(
  orderTotal: number | null | undefined,
  validatedAmount: number | null | undefined,
): number | null {
  if (orderTotal == null || !Number.isFinite(orderTotal)) return null;
  const validated = Number(validatedAmount) || 0;
  return Math.max(0, Math.round((orderTotal - validated) * 100) / 100);
}

/**
 * Resuelve los parámetros del cuerpo, en el orden configurado. Devuelve el
 * motivo cuando alguno queda vacío: es la última red antes de gastar un envío
 * que Meta va a rechazar por parámetro vacío (#132018), y el motivo se guarda
 * en la fila para que se vea QUÉ faltó. Pura.
 */
export function transitBodyParams(
  tokens: TransitToken[],
  f: TransitFacts,
): { ok: true; params: string[] } | { ok: false; missing: TransitToken[] } {
  const total = f.orderTotal ?? null;
  const validated = f.validatedAmount ?? 0;
  const saldo = pendingBalance(total, validated);
  const values = tokens.map((t): string => {
    switch (t) {
      case "nombre":
        return replyFirstName(f.customerName);
      case "guia":
        return sanitizeTemplateParam(f.guideCode);
      case "codigo":
        return sanitizeTemplateParam(f.shalomCodigo);
      case "producto":
        return productsLabel(f.lineItems);
      case "agencia":
        return sanitizeTemplateParam(f.agencyName);
      // Sin «S/»: lo escribe la plantilla. Ver `amountValue`.
      case "total":
        return total != null && total > 0 ? amountValue(total) : "";
      case "adelanto":
        return amountValue(validated);
      case "saldo":
        return amountValue(saldo);
      case "yape":
        return sanitizeTemplateParam(f.yapeNumber);
      case "vence":
        return sanitizeTemplateParam(f.pickupDeadline ?? null);
    }
  });
  const missing = tokens.filter((_, i) => !values[i]);
  if (missing.length) return { ok: false, missing };
  return { ok: true, params: values };
}

/** Horario local de envío, igual que la recuperación de devueltos. */
export function transitWithinHours(
  nowIso: string,
  tz: string,
  hourStart: number,
  hourEnd: number,
): boolean {
  const h = tzParts(nowIso, tz).hour;
  return h >= hourStart && h < hourEnd;
}

/** Config de envío resuelta desde la tienda, o `null` si le falta algo. */
export interface TransitConfig {
  courier: NoticeCourier;
  templateName: string;
  language: string;
  tokens: TransitToken[];
  attachTicket: boolean;
  /** La plantilla lleva cabecera de IMAGEN: la foto del producto (el
   *  recordatorio de recojo, 0242). Sin imagen no se manda. */
  headerImage?: boolean;
  /** La imagen de respaldo de la tienda, para el pedido sin foto. */
  fallbackImageUrl?: string | null;
  /** Número propio del aviso, o `null` para elegir por lead / tienda. */
  phoneNumberId: string | null;
  storePhoneNumberId: string | null;
  apiKey: string;
  hourStart: number;
  hourEnd: number;
  timezone: string;
}

export function transitConfig(
  creds: StoreCreds,
  kind: NoticeKind = "transito",
  courier: NoticeCourier = "shalom",
): { cfg: TransitConfig } | { cfg: null; reason: string } {
  // Lo que cambia por tipo de aviso —y por courier— es el TEXTO: plantilla,
  // variables, ticket y su propio interruptor. El número, el idioma, el horario
  // y las cuentas son de la tienda y se comparten — encender el de llegada, o
  // el de Olva, no puede obligar a reconfigurar por dónde sale.
  const llegada = kind === "disponible";
  // Los dos recordatorios (día 3 y día 7) son la MISMA plantilla: lo que los
  // separa es cuándo salen, no lo que dicen.
  const recordatorio = isReminderKind(kind);
  const olva = courier === "olva";
  const enabled = recordatorio
    ? olva ? creds.olva_reminder_template_enabled : creds.shalom_reminder_template_enabled
    : olva
      ? llegada ? creds.olva_arrival_template_enabled : creds.olva_transit_template_enabled
      : llegada ? creds.shalom_arrival_template_enabled : creds.shalom_transit_template_enabled;
  const templateName = recordatorio
    ? olva ? creds.olva_reminder_template_name : creds.shalom_reminder_template_name
    : olva
      ? llegada ? creds.olva_arrival_template_name : creds.olva_transit_template_name
      : llegada ? creds.shalom_arrival_template_name : creds.shalom_transit_template_name;
  const rawParams = recordatorio
    ? olva ? creds.olva_reminder_params : creds.shalom_reminder_params
    : olva
      ? llegada ? creds.olva_arrival_params : creds.olva_transit_params
      : llegada ? creds.shalom_arrival_params : creds.shalom_transit_params;
  // Olva no tiene ticket: su guía es un número y ya. El recordatorio lleva la
  // foto del producto en la cabecera, no el ticket: una cabecera es una sola.
  const attach = olva || recordatorio
    ? false
    : llegada ? creds.shalom_arrival_attach_ticket : creds.shalom_transit_attach_ticket;
  const que = `${recordatorio ? "recordatorio de recojo" : llegada ? "aviso de llegada" : "aviso"}${olva ? " de Olva" : ""}`;

  if (!enabled) return { cfg: null, reason: `${que} apagado en la tienda` };
  if (!templateName) return { cfg: null, reason: `la tienda no tiene plantilla de ${que} configurada` };
  if (!creds.kapso_api_key) return { cfg: null, reason: "la tienda no tiene API key de Kapso" };
  const tokens = parseTransitParams(rawParams);
  if (!tokens.length) return { cfg: null, reason: "la tienda no tiene el orden de variables configurado" };
  return {
    cfg: {
      courier,
      templateName,
      language: creds.shalom_transit_template_language ?? "es",
      tokens,
      attachTicket: Boolean(attach),
      headerImage: recordatorio,
      fallbackImageUrl: recordatorio ? creds.shalom_reminder_fallback_image_url?.trim() || null : null,
      phoneNumberId: creds.shalom_transit_phone_number_id?.trim() || null,
      storePhoneNumberId: creds.whatsapp_phone_number_id,
      apiKey: creds.kapso_api_key,
      hourStart: creds.shalom_transit_hour_start ?? 8,
      hourEnd: creds.shalom_transit_hour_end ?? 21,
      timezone: creds.timezone || "America/Lima",
    },
  };
}

/**
 * Por qué número sale el aviso. El propio del aviso manda si está; si no, el
 * número por el que la clienta ESCRIBIÓ (su lead): es el que reconoce y donde
 * el bot ya sostiene la conversación. Y si tampoco, el de la tienda. Pura.
 */
export function resolveSenderNumber(
  cfg: Pick<TransitConfig, "phoneNumberId" | "storePhoneNumberId">,
  leadPhoneNumberId: string | null | undefined,
): string | null {
  return cfg.phoneNumberId || leadPhoneNumberId?.trim() || cfg.storePhoneNumberId || null;
}

// ── Cola ────────────────────────────────────────────────────────────────────

/**
 * Deja el aviso en cola. Idempotente por guía: la unique de `shipment_id` hace
 * que el segundo intento no escriba nada, y ese silencio es el comportamiento
 * deseado — el cron puede ver el mismo tránsito dos veces.
 */
export async function enqueueTransitNotification(
  admin: SupabaseClient,
  input: {
    storeId: string;
    shipmentId: string;
    orderId: string | null;
    kind?: NoticeKind;
    /** Sin decirlo es Shalom: es el que ya existía. */
    courier?: NoticeCourier;
  },
): Promise<boolean> {
  const kind: NoticeKind = input.kind ?? "transito";
  const courier: NoticeCourier = input.courier ?? "shalom";
  const { error } = await admin
    .from("shalom_transit_notifications")
    .upsert(
      { store_id: input.storeId, shipment_id: input.shipmentId, order_id: input.orderId, kind, courier },
      { onConflict: "shipment_id,kind", ignoreDuplicates: true },
    );
  if (error) {
    console.error(`aviso en tránsito: no se pudo encolar ${input.shipmentId} — ${error.message}`);
    return false;
  }
  return true;
}

export interface TransitQueueRow {
  id: string;
  store_id: string;
  shipment_id: string;
  order_id: string | null;
  attempts: number;
  kind?: NoticeKind | null;
  courier?: NoticeCourier | null;
}

export interface TransitReport {
  sent: number;
  failed: number;
  skipped: number;
  /** Se dejaron para la próxima pasada (fuera de horario, presupuesto agotado). */
  deferred: number;
  errors: string[];
}

interface ShipmentRow {
  id: string;
  guide_code: string | null;
  shalom_codigo: string | null;
  shalom_ose_id: number | null;
  created_via?: string | null;
  olva_tracking?: string | null;
  olva_emision?: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  agency_branch: string | null;
  province: string | null;
  district: string | null;
  /** Para el recordatorio (0242): ¿sigue esperando en la agencia? */
  pickup_state?: string | null;
  delivery_status?: string | null;
  /** Olva la escribe al llegar; Shalom no (MOM §12). */
  agency_arrived_at?: string | null;
}

// ── Recordatorio de recojo (0242) ───────────────────────────────────────────

/**
 * Desde cuándo está la guía en la agencia, para el recordatorio. Pura.
 *
 * TRES FUENTES, EN ESTE ORDEN:
 *  1. El PRIMER `courier_status` → `disponible_para_recojo` que el rastreo
 *     escribió para ESA guía. Es el hecho, y el primero porque Shalom mueve su
 *     fecha de `destino` mientras el paquete sigue allí (MOM §12, «La llegada
 *     que cuenta es la primera»).
 *  2. Cuándo salió el aviso de llegada: si se mandó, el paquete ya estaba.
 *  3. `shipments.agency_arrived_at`, que llena el rastreo de Olva y Shalom no.
 *
 * Sin ninguna, `null`: no se adivina una llegada, y sin llegada no hay día 3
 * ni fecha límite que decir.
 */
export function guideArrivalAt(input: {
  firstArrivalEventAt: string | null | undefined;
  arrivalNoticeSentAt: string | null | undefined;
  agencyArrivedAt: string | null | undefined;
}): string | null {
  for (const v of [input.firstArrivalEventAt, input.arrivalNoticeSentAt, input.agencyArrivedAt]) {
    if (v && Number.isFinite(Date.parse(v))) return v;
  }
  return null;
}

/** Estados de entrega con los que la guía ya no está esperando a nadie. */
const GUIDE_CLOSED_DELIVERY = ["entregado", "anulado", "transferido", "devuelto"];

/** ¿Sigue la guía esperando a la clienta en la agencia? Pura. La lista de
 *  sub-estados es la del Master (`AGENCY_AVAILABLE_STATES`): una sola. */
export function stillAtAgency(pickupState: string | null | undefined, deliveryStatus: string | null | undefined): boolean {
  if (deliveryStatus && GUIDE_CLOSED_DELIVERY.includes(deliveryStatus)) return false;
  return (AGENCY_AVAILABLE_STATES as readonly string[]).includes(String(pickupState ?? ""));
}

/**
 * Por qué NO mandar un recordatorio que ya está en la cola, o `null`. Pura.
 *
 * Se mira OTRA VEZ al enviar porque entre encolar y enviar pueden pasar horas
 * —el tope y el horario los retienen—: la clienta puede haber recogido el
 * paquete, o puede haberse pasado el plazo. Un «recógelo antes del 16» el 17
 * es mentira, y uno a quien ya lo recogió le pide plata por algo que tiene en
 * la mano. Lo de «ya pagó todo» lo decide `noticeSkipReason`, como para los
 * otros avisos.
 */
export function reminderSendSkipReason(input: {
  courier: NoticeCourier;
  pickupState: string | null | undefined;
  deliveryStatus: string | null | undefined;
  arrivedAt: string | null | undefined;
  nowIso: string;
}): string | null {
  if (!stillAtAgency(input.pickupState, input.deliveryStatus)) return "la guía ya no está esperando en la agencia";
  const t = input.arrivedAt ? Date.parse(input.arrivedAt) : NaN;
  if (!Number.isFinite(t)) return "no se sabe cuándo llegó a la agencia";
  const limite = t + pickupWindowDays(input.courier) * 24 * 3600 * 1000;
  if (Date.parse(input.nowIso) >= limite) return "ya pasó la fecha límite de recojo";
  return null;
}

/**
 * La imagen de la cabecera del recordatorio. Pura.
 *
 * La foto del primer producto del pedido que la tenga en el espejo de catálogo
 * —la misma búsqueda que la prueba de carritos (0233): por `product_id` y, si
 * no, por título—, servida en JPG por /api/wa-image porque Meta no acepta
 * WebP. Sin foto, la imagen de respaldo de la tienda. Sin ninguna, NO se manda:
 * la plantilla se aprobó con cabecera de imagen y Meta rechaza un envío sin
 * ella, así que gastar el intento no sirve de nada.
 */
export function reminderHeaderImage(input: {
  lineItems: unknown;
  catalog: CatalogImage[];
  siteUrl: string;
  storeId: string;
  fallbackUrl: string | null | undefined;
}): { ok: true; link: string; source: "producto" | "respaldo" } | { ok: false; reason: string } {
  const productId = firstProductWithImage(input.lineItems, input.catalog);
  if (productId) return { ok: true, link: waImageUrl(input.siteUrl, input.storeId, productId), source: "producto" };
  const fallback = String(input.fallbackUrl ?? "").trim();
  if (/^https:\/\//i.test(fallback)) return { ok: true, link: fallback, source: "respaldo" };
  return {
    ok: false,
    reason: "sin foto del producto ni imagen de respaldo: la plantilla del recordatorio lleva imagen en la cabecera",
  };
}

/** Cuándo llegó ESTA guía a la agencia, leyendo las tres fuentes de
 *  `guideArrivalAt`. Una lectura que falla cuenta como dato ausente: a lo sumo
 *  el recordatorio no sale, nunca sale con una fecha inventada. */
export async function loadGuideArrival(
  admin: SupabaseClient,
  input: { shipmentId: string; orderId: string | null; guideCode: string | null; agencyArrivedAt?: string | null },
): Promise<string | null> {
  const [evento, aviso] = await Promise.all([
    input.orderId && input.guideCode
      ? admin
          .from("order_events")
          .select("occurred_at")
          .eq("order_id", input.orderId)
          .eq("guide_code", input.guideCode)
          .eq("kind", "courier_status")
          .eq("new_operational", "disponible_para_recojo")
          .order("occurred_at", { ascending: true })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("shalom_transit_notifications")
      .select("sent_at")
      .eq("shipment_id", input.shipmentId)
      .eq("kind", "disponible")
      .eq("status", "sent")
      .maybeSingle(),
  ]);
  return guideArrivalAt({
    firstArrivalEventAt: ((evento.data ?? null) as { occurred_at: string | null } | null)?.occurred_at ?? null,
    arrivalNoticeSentAt: ((aviso.data ?? null) as { sent_at: string | null } | null)?.sent_at ?? null,
    agencyArrivedAt: input.agencyArrivedAt ?? null,
  });
}

/**
 * El número con el que el COURIER conoce la guía, que es el que la clienta va
 * a decir en el mostrador. En Shalom es el nº de orden; en Olva, el tracking
 * con su año («2552504-26»), no el código interno del rótulo de Kapta.
 */
export function noticeGuideCode(courier: NoticeCourier, shipment: ShipmentRow): string | null {
  if (courier === "olva") {
    return shipment.olva_tracking && shipment.olva_emision
      ? formatOlvaTracking({ tracking: shipment.olva_tracking, emision: shipment.olva_emision })
      : null;
  }
  return shipment.guide_code;
}

/** Lee todo lo que la plantilla necesita de un pedido. Ninguna lectura lanza:
 *  lo que falte sale como hueco y `transitBodyParams` lo nombra. */
async function gatherFacts(
  admin: SupabaseClient,
  storeId: string,
  shipment: ShipmentRow,
  orderId: string | null,
  courier: NoticeCourier = "shalom",
): Promise<{
  facts: TransitFacts;
  phone: string | null;
  leadPhoneNumberId: string | null;
  orderName: string | null;
  /** Cuándo quedó disponible en la agencia; de aquí sale la fecha límite. */
  arrivedAt: string | null;
  /** Estado general del pedido: a uno cerrado no se le escribe. */
  generalStatus: string | null;
  /** Lo cobró la pasarela del checkout: no hay saldo que pedir. */
  webPrepaid: boolean;
}> {
  const [master, order, draft, payments, methods, llegada] = await Promise.all([
    orderId
      ? admin
          .from("order_master")
          .select("order_name,customer_name,customer_phone,order_total,general_status")
          .eq("order_id", orderId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    orderId
      ? admin
          .from("orders")
          .select("name,total_amount,customer_phone,line_items,financial_status,total_refunded,payment_gateway")
          .eq("id", orderId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    orderId
      ? admin.from("shalom_order_drafts").select("destiny_terminal_name").eq("order_id", orderId).maybeSingle()
      : Promise.resolve({ data: null }),
    orderId
      ? admin.from("order_payments").select("amount,validation_status").eq("order_id", orderId)
      : Promise.resolve({ data: [] as { amount: number | null; validation_status: string }[] }),
    loadStorePaymentMethods(admin, storeId),
    // Cuándo llegó a la agencia. Sale de la línea de tiempo y no de un campo
    // del envío porque es el mismo hecho que el rastreo ya escribe, y tenerlo
    // en dos sitios es tenerlo mal en uno de los dos.
    orderId
      ? admin
          .from("order_events")
          .select("occurred_at")
          .eq("order_id", orderId)
          .eq("new_operational", "disponible_para_recojo")
          .order("occurred_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const m = (master.data ?? null) as {
    order_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    order_total: number | null;
    general_status: string | null;
  } | null;
  const o = (order.data ?? null) as {
    name: string | null;
    total_amount: number | null;
    customer_phone: string | null;
    line_items: unknown;
    financial_status?: string | null;
    total_refunded?: number | string | null;
    payment_gateway?: PaymentGateway | null;
  } | null;
  const d = (draft.data ?? null) as { destiny_terminal_name: string | null } | null;

  // Lo VALIDADO, y solo eso: un comprobante en revisión todavía no es dinero
  // recibido, y decirle a la clienta que su adelanto ya cuenta cuando no se ha
  // validado es prometer una clave que no se va a liberar.
  const validated = ((payments.data ?? []) as { amount: number | null; validation_status: string }[])
    .filter((p) => p.validation_status === "validado")
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const phone = m?.customer_phone ?? o?.customer_phone ?? shipment.customer_phone ?? null;

  const lead = phone
    ? await admin
        .from("leads")
        .select("wa_phone_number_id")
        .eq("store_id", storeId)
        .eq("phone", phone)
        .maybeSingle()
    : { data: null };
  const leadPhoneNumberId = ((lead.data ?? null) as { wa_phone_number_id: string | null } | null)
    ?.wa_phone_number_id ?? null;

  const agencyName =
    d?.destiny_terminal_name?.trim() ||
    shipment.agency_branch?.trim() ||
    [shipment.province, shipment.district].filter(Boolean).join(" / ") ||
    null;

  return {
    facts: {
      customerName: m?.customer_name ?? shipment.customer_name ?? null,
      guideCode: noticeGuideCode(courier, shipment),
      shalomCodigo: courier === "shalom" ? shipment.shalom_codigo : null,
      lineItems: o?.line_items ?? [],
      agencyName,
      orderTotal: m?.order_total ?? o?.total_amount ?? null,
      validatedAmount: validated,
      yapeNumber: yapeNumberParam(methods),
    },
    phone,
    leadPhoneNumberId,
    orderName: m?.order_name ?? o?.name ?? null,
    arrivedAt: ((llegada.data ?? null) as { occurred_at: string } | null)?.occurred_at ?? null,
    generalStatus: m?.general_status ?? null,
    webPrepaid: isWebPrepaid({
      financialStatus: o?.financial_status ?? null,
      totalRefunded: o?.total_refunded == null ? null : Number(o.total_refunded),
      paymentGateway: o?.payment_gateway ?? null,
    }),
  };
}

const CLOSED_ORDER_STATUSES = ["anulado", "entregado", "devuelto"];

/**
 * Por qué NO mandar este aviso, o `null` si hay que mandarlo. Pura.
 *
 * Los dos avisos son de COBRO: llevan el saldo y los botones para pagarlo. Así
 * que no salen a quien ya no debe nada ni a un pedido cerrado. #KP135533: a
 * Alvina se le mandó «ya llegó a tu agencia» con saldo S/ 0.00 y los tres
 * botones de pago, un día después de pagar todo y con el pedido ya marcado
 * Entregado. Pedirle dinero a quien ya pagó es la forma más rápida de que deje
 * de creerse los mensajes que sí importan.
 *
 * PAGADO EN EL CHECKOUT, TAMPOCO (09-10-2026). El saldo se calculaba solo con
 * los comprobantes de Yape, y un pedido cobrado por la pasarela no tiene
 * ninguno: salía «Total 134.10 · Pagado 0.00 · Saldo 134.10». Trece pedidos
 * pagados por web recibieron ese cobro entre el 17-09 y el 09-10 —los de Olva
 * con el Yape para pagar—, y en #KP138120 la clienta contestó con la captura de
 * su pago, que el bot de cobranza registró como un pago nuevo. Las dos vías de
 * cobro no se suman (MOM §12, lib/order-paid.ts): pagado en el checkout es
 * pagado entero, igual que «ya pagó todo».
 *
 * Saldo desconocido (sin total) NO se salta aquí: ahí la plantilla ya se niega
 * sola por falta de datos, con el motivo escrito.
 */
export function noticeSkipReason(input: {
  generalStatus: string | null | undefined;
  orderTotal: number | null | undefined;
  validatedAmount: number | null | undefined;
  /** Lo cobró la pasarela del checkout (`isWebPrepaid`). */
  webPrepaid?: boolean;
}): string | null {
  if (input.generalStatus && CLOSED_ORDER_STATUSES.includes(input.generalStatus)) {
    return `el pedido ya está ${input.generalStatus}`;
  }
  if (input.webPrepaid) return "pagado en el checkout: no hay saldo que cobrar";
  const saldo = pendingBalance(input.orderTotal, input.validatedAmount);
  if (saldo === 0) return "ya pagó todo: no hay saldo que cobrar";
  return null;
}

type SendTemplate = typeof sendWhatsappTemplate;

/**
 * Procesa la cola: hasta `limit` avisos pendientes cuya hora llegó, en orden
 * de llegada. Es el único camino de envío. Cada fila termina en `sent`,
 * `failed` o `skipped`, o se queda `pending` con `next_attempt_at` corrido —
 * nunca se pierde en silencio.
 */
export async function processTransitNotifications(
  admin: SupabaseClient,
  opts: {
    limit?: number;
    nowIso?: string;
    /** Presupuesto en ms; al agotarse se deja el resto para la próxima. */
    budgetMs?: number;
    sendTemplate?: SendTemplate;
    loadCreds?: (storeId: string) => Promise<StoreCreds | null>;
    /** Solo esta tienda. El cron drena todas; el botón de Ajustes, la suya. */
    storeId?: string;
    /** Cuántos avisos ENVIADOS tiene la tienda desde `sinceIso`. Para el tope. */
    countSent?: (storeId: string, sinceIso: string) => Promise<number>;
    /** De dónde sale la URL pública de /api/wa-image (la foto del recordatorio). */
    siteUrl?: string;
  } = {},
): Promise<TransitReport> {
  const report: TransitReport = { sent: 0, failed: 0, skipped: 0, deferred: 0, errors: [] };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const started = Date.now();
  const budget = opts.budgetMs ?? 150_000;
  const send = opts.sendTemplate ?? sendWhatsappTemplate;
  const loadCreds = opts.loadCreds ?? ((id: string) => getStoreCreds(id, admin));
  // El espejo de catálogo de cada tienda, leído UNA vez por pasada y solo si
  // sale algún recordatorio: son unos cientos de filas y casi no cambian.
  const catalogs = new Map<string, Promise<CatalogImage[] | null>>();
  const loadCatalog = (storeId: string): Promise<CatalogImage[] | null> => {
    if (!catalogs.has(storeId)) catalogs.set(storeId, loadStoreCatalog(admin, storeId, Date.parse(nowIso)));
    return catalogs.get(storeId)!;
  };
  const siteUrl = opts.siteUrl ?? env.siteUrl();
  const countSent =
    opts.countSent ??
    (async (storeId: string, sinceIso: string): Promise<number> => {
      const { count, error } = await admin
        .from("shalom_transit_notifications")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId)
        .eq("status", "sent")
        .gte("sent_at", sinceIso);
      // Si no se puede contar, se cuenta como LLENO: mandar a ciegas con un
      // número nuevo es justo lo que el tope existe para evitar.
      if (error) return Number.POSITIVE_INFINITY;
      return count ?? 0;
    });
  // Enviados por tienda en esta ventana, contados una vez y llevados a mano
  // mientras la pasada envía.
  const enviados = new Map<string, { day: number; hour: number }>();
  const credsByStore = new Map<string, StoreCreds | null>();

  /** Carga (una vez) lo que hace falta para saber el cupo de una tienda. */
  const cupoDe = async (storeId: string): Promise<number> => {
    if (!credsByStore.has(storeId)) credsByStore.set(storeId, await loadCreds(storeId));
    const tienda = credsByStore.get(storeId) ?? null;
    const dailyCap = tienda?.shalom_notice_daily_cap ?? null;
    const hourlyCap = tienda?.shalom_notice_hourly_cap ?? null;
    if (dailyCap == null && hourlyCap == null) return Number.POSITIVE_INFINITY;
    if (!enviados.has(storeId)) {
      const t = Date.parse(nowIso);
      const [day, hour] = await Promise.all([
        countSent(storeId, new Date(t - 24 * 3600_000).toISOString()),
        countSent(storeId, new Date(t - 3600_000).toISOString()),
      ]);
      enviados.set(storeId, { day, hour });
    }
    const cuenta = enviados.get(storeId)!;
    return noticeCapLeft({ sentLast24h: cuenta.day, sentLastHour: cuenta.hour, dailyCap, hourlyCap });
  };

  // UNA TIENDA CON EL TOPE LLENO NO OCUPA PUESTOS DE LA PASADA. La pasada coge
  // los N pendientes más antiguos de TODAS las tiendas; si los de una tienda
  // topada entraban, se quedaban ahí sin salir —el tope no los deja— y la
  // siguiente pasada volvía a cogerlos a ellos. Pasó el 28-09-2026: Kenku llegó
  // a sus 30 del día con 40 avisos esperando, esos 40 llenaban los 20 puestos
  // de cada pasada, y Aurela —con 7 de sus 30 usados— no mandó nada en toda la
  // mañana. Así que primero se mira qué tiendas tienen cupo, y la cola se pide
  // solo de ésas.
  let conCupo: string[] | null = null; // null = sin filtrar por tienda
  if (!opts.storeId) {
    const { data: pend, error: pendErr } = await admin
      .from("shalom_transit_notifications")
      .select("store_id")
      .eq("status", "pending")
      .lte("next_attempt_at", nowIso)
      .limit(2000);
    if (pendErr) {
      report.errors.push(`cola: ${pendErr.message}`);
      return report;
    }
    const tiendas = [...new Set(((pend ?? []) as { store_id: string }[]).map((r) => r.store_id))];
    if (!tiendas.length) return report;
    conCupo = [];
    for (const id of tiendas) {
      if ((await cupoDe(id)) > 0) conCupo.push(id);
    }
    if (!conCupo.length) {
      // Todas topadas: nada que hacer hasta que se libere cupo. Esperan.
      report.deferred += (pend ?? []).length;
      return report;
    }
  }

  let query = admin
    .from("shalom_transit_notifications")
    .select("id,store_id,shipment_id,order_id,attempts,kind,courier")
    .eq("status", "pending")
    .lte("next_attempt_at", nowIso);
  if (opts.storeId) query = query.eq("store_id", opts.storeId);
  if (conCupo) query = query.in("store_id", conCupo);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? TRANSIT_BATCH_CAP);
  if (error) {
    report.errors.push(`cola: ${error.message}`);
    return report;
  }
  const rows = (data ?? []) as TransitQueueRow[];
  if (!rows.length) return report;

  // Por tienda Y tipo: una tienda puede tener encendido el de tránsito y
  // apagado el de llegada, que es justo como se van a estrenar.
  const configByStore = new Map<string, ReturnType<typeof transitConfig>>();

  for (const row of rows) {
    if (Date.now() - started > budget) {
      report.deferred += 1;
      continue;
    }

    const kind: NoticeKind = parseNoticeKind(row.kind);
    const courier: NoticeCourier = row.courier === "olva" ? "olva" : "shalom";
    const claveCfg = `${row.store_id}:${kind}:${courier}`;
    if (!credsByStore.has(row.store_id)) {
      credsByStore.set(row.store_id, await loadCreds(row.store_id));
    }
    if (!configByStore.has(claveCfg)) {
      const creds = credsByStore.get(row.store_id) ?? null;
      configByStore.set(
        claveCfg,
        creds ? transitConfig(creds, kind, courier) : { cfg: null, reason: "tienda no encontrada" },
      );
    }
    const resolved = configByStore.get(claveCfg)!;

    if (!resolved.cfg) {
      // Apagado o sin configurar NO es un fallo: es la tienda decidiendo. Se
      // cierra la fila para que encender el aviso después no dispare avisos de
      // guías que salieron hace semanas.
      await admin
        .from("shalom_transit_notifications")
        .update({ status: "skipped", error: resolved.reason, updated_at: nowIso })
        .eq("id", row.id);
      report.skipped += 1;
      continue;
    }
    const cfg = resolved.cfg;

    if (!transitWithinHours(nowIso, cfg.timezone, cfg.hourStart, cfg.hourEnd)) {
      report.deferred += 1;
      continue;
    }

    // EL TOPE (0194). Al llegar, el aviso se queda en la cola tal cual —ni se
    // toca la fila— y sale en la siguiente pasada con cupo. No se pierde. Se
    // vuelve a mirar aquí porque el cupo se gasta DENTRO de la pasada.
    if ((await cupoDe(row.store_id)) <= 0) {
      report.deferred += 1;
      continue;
    }

    const outcome = await sendOne(admin, row, cfg, { nowIso, send, kind, loadCatalog, siteUrl });
    const cuenta = enviados.get(row.store_id);
    if (outcome === "sent" && cuenta) {
      cuenta.day += 1;
      cuenta.hour += 1;
    }
    if (outcome === "sent") report.sent += 1;
    else if (outcome === "failed") report.failed += 1;
    else if (outcome === "retry") report.deferred += 1;
    else if (outcome === "skipped") report.skipped += 1;
  }

  return report;
}

/** Corre el reintento: 30 min, 60, 90… Con el cron cada media hora, cinco
 *  intentos cubren un par de horas de Meta o Shalom caídos. */
function nextAttemptIso(nowIso: string, attempts: number): string {
  return new Date(Date.parse(nowIso) + Math.min(attempts, 6) * 30 * 60_000).toISOString();
}

async function sendOne(
  admin: SupabaseClient,
  row: TransitQueueRow,
  cfg: TransitConfig,
  ctx: {
    nowIso: string;
    send: SendTemplate;
    kind?: NoticeKind;
    /** El espejo de catálogo de la tienda, para la foto del recordatorio.
     *  `null`: no se pudo leer. */
    loadCatalog?: (storeId: string) => Promise<CatalogImage[] | null>;
    siteUrl?: string;
  },
): Promise<"sent" | "failed" | "retry" | "skipped"> {
  const attempts = (row.attempts ?? 0) + 1;
  const courier = cfg.courier ?? "shalom";
  const recordatorio = isReminderKind(ctx.kind);

  /** Cerrar la fila sin mandar: no es un fallo, es que ya no toca. */
  const skip = async (motivo: string, patch: Record<string, unknown> = {}): Promise<"skipped"> => {
    await admin
      .from("shalom_transit_notifications")
      .update({ status: "skipped", error: motivo, updated_at: ctx.nowIso, ...patch })
      .eq("id", row.id);
    return "skipped";
  };

  const fail = async (
    error: string,
    extra: { retryable: boolean; code?: number; patch?: Record<string, unknown> },
  ): Promise<"failed" | "retry"> => {
    const definitive = !extra.retryable || attempts >= TRANSIT_MAX_ATTEMPTS;
    await admin
      .from("shalom_transit_notifications")
      .update({
        attempts,
        error,
        error_code: extra.code ?? null,
        status: definitive ? "failed" : "pending",
        next_attempt_at: definitive ? ctx.nowIso : nextAttemptIso(ctx.nowIso, attempts),
        updated_at: ctx.nowIso,
        ...(extra.patch ?? {}),
      })
      .eq("id", row.id);
    return definitive ? "failed" : "retry";
  };

  const { data: sh } = await admin
    .from("shipments")
    .select(
      "id,guide_code,shalom_codigo,shalom_ose_id,olva_tracking,olva_emision,customer_name,customer_phone,agency_branch,province,district,created_via,pickup_state,delivery_status,agency_arrived_at",
    )
    .eq("id", row.shipment_id)
    .maybeSingle();
  const shipment = (sh ?? null) as ShipmentRow | null;
  if (!shipment) return fail("la guía ya no existe", { retryable: false });

  const { facts, phone, leadPhoneNumberId, orderName, arrivedAt, generalStatus, webPrepaid } = await gatherFacts(
    admin,
    row.store_id,
    shipment,
    row.order_id,
    courier,
  );

  // Se decide AL ENVIAR y no al encolar: entre una cosa y otra la clienta puede
  // haber pagado, y lo que importa es si debe algo cuando el mensaje sale.
  const noAvisar = noticeSkipReason({
    generalStatus,
    orderTotal: facts.orderTotal,
    validatedAmount: facts.validatedAmount,
    webPrepaid,
  });
  if (noAvisar) return skip(noAvisar);

  // El recordatorio (0242) además tiene que seguir siendo verdad AL ENVIAR: el
  // paquete sigue en la agencia y el plazo no ha pasado. Su llegada se lee por
  // guía y la primera, como en `guideArrivalAt` — la misma que usó quien lo
  // encoló, para que la fecha límite del mensaje sea la que decidió el día 3.
  let llegada = arrivedAt;
  if (recordatorio) {
    llegada = await loadGuideArrival(admin, {
      shipmentId: row.shipment_id,
      orderId: row.order_id,
      guideCode: shipment.guide_code,
      agencyArrivedAt: shipment.agency_arrived_at ?? null,
    });
    const yaNo = reminderSendSkipReason({
      courier,
      pickupState: shipment.pickup_state,
      deliveryStatus: shipment.delivery_status,
      arrivedAt: llegada,
      nowIso: ctx.nowIso,
    });
    if (yaNo) return skip(yaNo);
  }
  // La fecha límite solo la piden el aviso de llegada y el recordatorio; se
  // calcula siempre porque cuesta nada y así `transitBodyParams` decide con el
  // dato delante. Con los días de CADA courier: Olva devuelve a los 6, Shalom
  // a los 28.
  facts.pickupDeadline = pickupDeadlineLabel(llegada, cfg.timezone, pickupWindowDays(courier));

  if (!phone || !isSendablePhone(phone)) {
    return fail(`sin celular peruano al que escribir (${phone ?? "vacío"})`, { retryable: false, patch: { phone } });
  }
  const phoneNumberId = resolveSenderNumber(cfg, leadPhoneNumberId);
  if (!phoneNumberId) return fail("la tienda no tiene número de WhatsApp configurado", { retryable: true });

  const built = transitBodyParams(cfg.tokens, facts);
  if (!built.ok) {
    // Un dato que falta hoy puede aparecer mañana (la agencia apuntada tarde,
    // por ejemplo), así que se reintenta; al agotar los intentos queda escrito
    // QUÉ faltó, que es lo que alguien necesita para arreglarlo.
    return fail(`faltan datos para la plantilla: ${built.missing.join(", ")}`, {
      retryable: true,
      patch: { phone, phone_number_id: phoneNumberId },
    });
  }

  // La foto del producto en la cabecera del recordatorio (0242). Sin foto ni
  // imagen de respaldo NO se manda: Meta rechaza una plantilla de cabecera de
  // imagen que llega sin ella, y reintentarlo no la hace aparecer. Pero un
  // catálogo que no se pudo leer (la base, o Storage desde el cierre: MOM §39)
  // no es «sin foto»: sin respaldo, se reintenta.
  let headerImage: { link: string } | undefined;
  let imageSource: "producto" | "respaldo" | null = null;
  if (cfg.headerImage) {
    const catalog = ctx.loadCatalog ? await ctx.loadCatalog(row.store_id) : [];
    const img = reminderHeaderImage({
      lineItems: facts.lineItems,
      catalog: catalog ?? [],
      siteUrl: ctx.siteUrl ?? env.siteUrl(),
      storeId: row.store_id,
      fallbackUrl: cfg.fallbackImageUrl,
    });
    if (!img.ok && catalog === null) {
      return fail("no se pudo leer el catálogo de fotos del producto y la tienda no tiene imagen de respaldo", {
        retryable: true,
        patch: { phone, phone_number_id: phoneNumberId },
      });
    }
    if (!img.ok) return skip(img.reason, { phone, phone_number_id: phoneNumberId });
    headerImage = { link: img.link };
    imageSource = img.source;
  }

  // El ticket de Shalom en cabecera, si la tienda lo pide. Se baja (o se lee de
  // la caché) y se firma una URL que Meta pueda abrir. Sin ticket no se manda
  // una plantilla que lo exige: Meta la rechazaría igual y con menos contexto.
  let headerDocument: { link: string; filename: string } | undefined;
  if (cfg.attachTicket) {
    if (!shipment.shalom_ose_id) {
      // Una guía creada a mano en Shalom Pro sí tiene OSE ID; el cron lo trae
      // del listado de la cuenta (lib/shalom/ose-backfill.ts). Se espera a
      // que llegue en vez de dar el aviso por perdido.
      const manual = shipment.created_via === SHALOM_ORIGIN.manual;
      return fail(
        manual
          ? "la plantilla lleva el ticket y la guía manual aún no tiene OSE ID: se busca en la cuenta de Shalom"
          : "la plantilla lleva el ticket pero la guía no tiene OSE ID (no se creó por API)",
        { retryable: manual, patch: { phone, phone_number_id: phoneNumberId } },
      );
    }
    const link = await ticketLink(admin, row.store_id, shipment.shalom_ose_id);
    if (!link) {
      return fail("no se pudo obtener el ticket de Shalom para adjuntarlo", {
        retryable: true,
        patch: { phone, phone_number_id: phoneNumberId },
      });
    }
    headerDocument = { link, filename: `ticket-shalom-${shipment.guide_code ?? shipment.shalom_ose_id}.pdf` };
  }

  let res: WhatsappSendResult;
  try {
    res = await ctx.send(
      { apiKey: cfg.apiKey },
      {
        phoneNumberId,
        to: phone,
        templateName: cfg.templateName,
        language: cfg.language,
        bodyParams: built.params,
        ...(headerDocument ? { headerDocument } : {}),
        ...(headerImage ? { headerImage } : {}),
      },
    );
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // La foto que viajó, solo cuando hubo una: la columna es de la 0242.
  const imagen = headerImage ? { header_image_url: headerImage.link } : {};

  if (!res.ok) {
    // Una llamada ambigua —la petición pudo llegar a Meta y la respuesta no
    // volvió— NO se reintenta a ciegas: repetirla duplicaría el aviso. Se da
    // por perdida con el motivo escrito; alguien puede mandarla a mano.
    return fail(res.error ?? "envío rechazado", {
      retryable: !res.ambiguous,
      code: res.code,
      patch: { phone, phone_number_id: phoneNumberId, template_name: cfg.templateName, params: built.params, ...imagen },
    });
  }

  await admin
    .from("shalom_transit_notifications")
    .update({
      attempts,
      status: "sent",
      sent_at: ctx.nowIso,
      phone,
      phone_number_id: phoneNumberId,
      template_name: cfg.templateName,
      params: built.params,
      provider_message_id: res.id,
      error: null,
      error_code: null,
      updated_at: ctx.nowIso,
      ...imagen,
      // Aquí NO se sella `ticket_sent_at`, aunque el ticket haya viajado en la
      // cabecera. Medido en el chat real: encima de un mensaje de quince líneas
      // el adjunto queda arriba del todo y pasa desapercibido justo cuando la
      // clienta baja a los botones. Así que se reenvía con la primera respuesta,
      // que es donde ella está mirando. El sello lo pone esa vía y es lo que
      // evita el tercer y cuarto envío a quien pulsa los tres botones.
    })
    .eq("id", row.id);

  if (row.order_id) {
    // Queda en la línea de tiempo del pedido, al lado del `courier_status` que
    // lo disparó: quien mire el pedido tiene que ver que se avisó y con qué.
    const que = recordatorio
      ? `Recordatorio de recojo (día ${ctx.kind === "recordatorio_d7" ? 7 : 3})`
      : ctx.kind === "disponible"
        ? "Aviso de llegada a la agencia"
        : "Aviso de guía en tránsito";
    const conImagen =
      imageSource === "producto" ? " con la foto del producto" : imageSource === "respaldo" ? " con la imagen de respaldo" : "";
    await admin.from("order_events").insert({
      store_id: row.store_id,
      order_id: row.order_id,
      kind: "whatsapp_template",
      occurred_at: ctx.nowIso,
      actor: null,
      source: `${courier}_transit`,
      courier,
      guide_code: shipment.guide_code,
      note: `📤 ${que}: plantilla «${cfg.templateName}» enviada${
        orderName ? ` por ${orderName}` : ""
      }${headerDocument ? " con el ticket de Shalom" : ""}${conImagen}.`,
    });
  }
  return "sent";
}

/**
 * Manda el ticket PDF de Shalom por la guía de un aviso ya enviado, cuando la
 * clienta contesta (ver 0167).
 *
 * VA AQUÍ Y NO EN LA PLANTILLA porque el botón abre la ventana de 24 h: dentro
 * de ella un documento sale como mensaje normal, sin plantilla que aprobar en
 * Meta y sin número de Yape escrito a mano que pueda desalinearse.
 *
 * UNA VEZ POR GUÍA: el sello `ticket_sent_at` vive en la fila del aviso, que es
 * única por guía. Quien pulsa dos botones no recibe dos tickets.
 *
 * NUNCA LANZA y nunca es un fallo del que dependa nada: el texto con las
 * cuentas ya salió antes. Una guía sin `ose_id` —llegó por el Excel— o Shalom
 * caído dejan el motivo escrito y ya está.
 */
export async function sendTransitTicket(
  admin: SupabaseClient,
  input: {
    notificationId: string;
    shipmentId: string;
    storeId: string;
    phone: string;
    phoneNumberId: string;
    apiKey: string;
    guideCode?: string | null;
  },
  opts: { sendDocument?: typeof sendWhatsappDocument; nowIso?: string } = {},
): Promise<{ sent: boolean; reason?: string }> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const sendDoc = opts.sendDocument ?? sendWhatsappDocument;

  const stamp = async (patch: Record<string, unknown>) => {
    await admin.from("shalom_transit_notifications").update(patch).eq("id", input.notificationId);
  };

  try {
    const { data } = await admin
      .from("shipments")
      .select("shalom_ose_id,guide_code")
      .eq("id", input.shipmentId)
      .maybeSingle();
    const sh = (data ?? null) as { shalom_ose_id: number | null; guide_code: string | null } | null;
    const oseId = sh?.shalom_ose_id ?? null;
    if (!oseId) {
      await stamp({ ticket_error: "la guía no se creó por API (sin OSE ID): no hay ticket que mandar" });
      return { sent: false, reason: "sin_ose_id" };
    }

    const link = await ticketLink(admin, input.storeId, oseId);
    if (!link) {
      await stamp({ ticket_error: "no se pudo obtener el ticket de Shalom" });
      return { sent: false, reason: "sin_ticket" };
    }

    const guia = input.guideCode ?? sh?.guide_code ?? String(oseId);
    const res = await sendDoc(
      { apiKey: input.apiKey },
      {
        phoneNumberId: input.phoneNumberId,
        to: input.phone,
        documentUrl: link,
        filename: `ticket-shalom-${guia}.pdf`,
        caption: `📄 Este es el ticket de tu envío por Shalom. Guía ${guia}.`,
      },
    );
    if (!res.ok) {
      await stamp({ ticket_error: res.error ?? "envío del ticket rechazado" });
      return { sent: false, reason: "rechazado" };
    }
    await stamp({ ticket_sent_at: nowIso, ticket_error: null });
    return { sent: true };
  } catch (e) {
    await stamp({ ticket_error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    return { sent: false, reason: "error" };
  }
}

/**
 * Los productos CON foto del espejo de catálogo de una tienda (0164), para la
 * cabecera del recordatorio. La misma lectura que la prueba de carritos
 * (lib/cart-sequence.ts).
 *
 * Si Shopify ya no sirve las fotos de la tienda (MOM §39: sin token, o desde
 * el cierre la que pasa a WooCommerce), solo las fotos con su copia guardada:
 * una sin copia daría a Meta un 502 en la cabecera, y el recordatorio cae a la
 * imagen de respaldo como cuando el producto no tiene foto. Vale también para
 * los pedidos de WooCommerce, que casan con este catálogo por el título.
 *
 * `null` si no se pudo leer (la base, o Storage): no es «sin foto». Con imagen
 * de respaldo el recordatorio sale con ella, como siempre; sin ella se
 * reintenta en vez de quedar omitido (`sendOne`).
 */
async function loadStoreCatalog(admin: SupabaseClient, storeId: string, nowMs: number): Promise<CatalogImage[] | null> {
  try {
    const { data, error } = await admin
      .from("shopify_product_images")
      .select("product_id,catalog_title,image_url")
      .eq("store_id", storeId);
    if (error) return null;
    const rows = ((data ?? []) as (CatalogImage & { image_url: string | null })[])
      // Solo lo que /api/wa-image acepta servir (el CDN de Shopify): otra foto
      // daría a Meta un 404 en la cabecera y el envío fallaría.
      .filter((r) => isShopifyCdnUrl(r.image_url));
    const usable = await productPhotosThatLoad(admin, storeId, rows, nowMs);
    return (
      usable?.map((r) => ({
        product_id: String(r.product_id),
        catalog_title: r.catalog_title ?? null,
      })) ?? null
    );
  } catch {
    return null;
  }
}

/** URL firmada del ticket, bajándolo si todavía no está en caché. `null` si
 *  no se pudo. */
async function ticketLink(admin: SupabaseClient, storeId: string, oseId: number): Promise<string | null> {
  try {
    const store = await loadStoreShalom(admin, storeId);
    if (!store?.shalom_pro_email) return null;
    await shalomVoucherPdf(admin, storeId, store, oseId);
  } catch {
    return null;
  }
  return signedDocUrl(admin, oseId, "voucher", TICKET_URL_SECONDS);
}
