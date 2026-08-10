// Recuperación del pedido devuelto (MOM §11).
//
// EL HUECO QUE TAPA. El paquete salió contraentrega a provincia, la clienta no
// lo recibió y volvió al almacén. `returned_at` se sella, el pedido pasa a
// `devuelto` (§10) y ahí se detiene todo. El MOM dice que la devolución es
// entrada elegible a Reproprovincia, pero esa puerta solo se abre si alguien
// vuelve a escribirle a la clienta — y hoy no la abre nadie: la caja se queda en
// el almacén y la venta se pierde entera.
//
// LA PROPUESTA QUE LLEVA EL MENSAJE. No es "te lo reenviamos igual": el envío
// contraentrega ya falló una vez y repetirlo apuesta el flete a la misma
// clienta que no respondió. Lo que se ofrece es reenviar por AGENCIA con
// adelanto (§12) — la clienta paga primero y recoge en su agencia. Si acepta,
// deja de haber riesgo de flete perdido; si no contesta, no costó nada.
//
// POR QUÉ UNA PLANTILLA Y NO UN MENSAJE. Una devolución tarda semanas: la
// ventana de 24 h de WhatsApp lleva muchísimo tiempo cerrada, y fuera de ella
// solo entra una plantilla aprobada por Meta. Por eso el envío depende de que
// la tienda TENGA plantilla aprobada, y por eso Aurela nace apagada.
//
// DÓNDE TERMINA ESTO. En el envío. La respuesta de la clienta la atiende el bot
// de Kapso, que es quien ya sostiene la conversación y quien manda el número de
// cuenta cuando dice que sí — este repo no manda datos bancarios (ver
// docs/kapso-functions/README.md). De ahí en adelante el circuito de adelanto,
// comprobante y clave de recojo ya existe entero (§12).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { stripAccents } from "@/lib/couriers/sheet";
import { isSendablePhone, isTierLimitError, sanitizeTemplateParam } from "@/lib/leads-ingest";
import { sendWhatsappTemplate } from "@/lib/kapso";
import { tzParts } from "@/lib/metrics";

/** Estados de la recuperación sobre la guía. `null` = todavía sin tocar. */
export type RecoveryState = "enviado" | "descartado";

/** Tope de envíos por tienda por corrida del cron. La cola de devoluciones se
 *  llena de a poco (un retorno tarda semanas), así que un tope chico basta y
 *  además protege la calidad de la plantilla en sus primeros días: Meta vigila
 *  bloqueos y reportes, y un lote grande de golpe es justo lo que los dispara. */
export const RECOVERY_BATCH_CAP = 20;

/** Ventana de frescura por defecto (espejo de la migración 0112). */
export const RECOVERY_DEFAULT_MAX_DAYS = 30;

/**
 * Couriers cuya devolución entra a recuperación.
 *
 * Solo Aliclik, y no por capricho: es el flujo de PROVINCIA CONTRAENTREGA, el
 * único donde "no la recibió" significa que el paquete viajó, volvió y la venta
 * sigue viva. Una devolución de agencia (Shalom/Olva) ya se pagó por adelantado
 * —no hay adelanto que proponer— y una de Lima se gestiona el mismo día con la
 * clienta al teléfono, sin plantilla de por medio.
 */
export const RECOVERY_COURIERS = new Set(["aliclik"]);

/**
 * Motivos que significan "la vio y la rechazó".
 *
 * MOM §11: «Si el cliente vio el producto y aun así lo rechazó, normalmente no
 * reenviar». Es la regla más importante de este módulo, porque el mensaje pide
 * PLATA POR ADELANTADO: pedírsela a quien tuvo la caja en la puerta y dijo que
 * no es la forma más rápida de que reporte el número — y un reporte le cuesta
 * la plantilla a toda la tienda, no solo a ese chat.
 *
 * Se compara contra `reported_status`, que llega en dos idiomas según la vía:
 * el reporte Excel guarda el ESTADO ENTREGA en español (RECHAZADO) y la API
 * guarda los enums en inglés unidos por " · " (REFUSED · RETURNED · CONFIRMED).
 * Por eso se buscan las dos formas y por subcadena, no por igualdad.
 *
 * En español se busca la RAÍZ y no la palabra entera: el enum del courier dice
 * RECHAZADO, pero `non_delivery_reason` es texto libre que escribe una persona
 * y ahí aparece conjugado —«la clienta rechazó», «rechaza el producto»—. Con la
 * palabra completa, esos casos pasaban el filtro y recibían el mensaje. La raíz
 * puede sobrar de más en algún texto raro, y eso es exactamente el lado barato
 * del error: se pierde una recuperación dudosa, no la plantilla de la tienda.
 */
const REFUSED_MARKERS = ["RECHAZ", "REFUSED"];

/**
 * Motivos que SÍ son recuperables: la clienta nunca llegó a ver el producto.
 * No se usan para decidir (lo que decide es la ausencia de rechazo), pero
 * documentan qué población queda: NO CONTESTA / NOT_RESPOND, CANCELADO / CANCEL
 * y las guías que volvieron sin motivo legible.
 */
export const RECOVERABLE_REASONS = ["NO CONTESTA", "NOT_RESPOND", "CANCELADO", "CANCEL"] as const;

/** Sin acentos y en mayúsculas, para comparar motivos que llegan de dos vías. */
function statusKey(v: string | null | undefined): string {
  return stripAccents(String(v ?? "")).toUpperCase();
}

/**
 * True cuando el reporte dice que la clienta rechazó el paquete teniéndolo
 * delante. Mira `reported_status` y `non_delivery_reason`: el primero es lo que
 * dijo el courier, el segundo lo que anotó quien gestionó. Basta con que uno
 * hable de rechazo — ante la duda NO se recupera, que es el lado barato del
 * error (se pierde una venta dudosa, no la plantilla de la tienda).
 */
export function wasRefusedInPerson(
  reportedStatus: string | null | undefined,
  nonDeliveryReason: string | null | undefined,
): boolean {
  const haystack = `${statusKey(reportedStatus)} ${statusKey(nonDeliveryReason)}`;
  return REFUSED_MARKERS.some((m) => haystack.includes(m));
}

/** La fila de `shipments` que necesitan la cola y el envío. */
export interface RecoveryCandidate {
  id: string;
  courier: string;
  guide_code: string | null;
  order_name: string | null;
  /** El pedido de Shopify REALMENTE enlazado. Es la única señal que no miente:
   *  `order_name` puede ser una conjetura del importador (ver 0115), así que la
   *  cola gatea por esto y no por el texto. */
  order_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product: string | null;
  district: string | null;
  province: string | null;
  reported_collect_amount: number | null;
  returned_at: string | null;
  /** Quién dio por devuelta la guía (0116). No excluye a nadie de la cola —un
   *  paquete recibido a mano es tan real como uno reportado— pero SÍ se muestra:
   *  quien pulsa «Enviar» le está pidiendo un adelanto a la clienta y tiene
   *  derecho a saber si detrás hay constancia del courier. */
  returned_source: string | null;
  reported_status: string | null;
  non_delivery_reason: string | null;
  recovery_state: string | null;
  recovery_sent_at: string | null;
}

/**
 * Por qué esta guía NO entra a recuperación, o `null` si entra.
 *
 * Devuelve el motivo en vez de un booleano porque la cola lo MUESTRA: cuando
 * alguien pregunta "¿y por qué a esta no le escribimos?", la respuesta tiene
 * que estar en la pantalla y no en el código. Pura.
 */
export function recoverySkipReason(
  c: RecoveryCandidate,
  opts: { nowMs: number; maxDays: number },
): string | null {
  if (c.recovery_state === "enviado") return "ya se le escribió";
  if (c.recovery_state === "descartado") return "descartada a mano";
  if (!c.returned_at) return "la guía no volvió";
  if (!RECOVERY_COURIERS.has(String(c.courier ?? "").toLowerCase())) {
    return `${c.courier} no es contraentrega de provincia`;
  }
  if (wasRefusedInPerson(c.reported_status, c.non_delivery_reason)) {
    return "la rechazó viendo el producto (MOM §11)";
  }
  if (!isSendablePhone(c.customer_phone)) return "sin número de WhatsApp válido";
  // Sin nombre o sin producto la plantilla sale con huecos: Meta rechaza los
  // parámetros vacíos (#132018) y, aunque los aceptara, un "¡Hola !" quema el
  // mensaje. Se salta sin consumir nada — si el dato aparece después, vuelve.
  if (!String(c.customer_name ?? "").trim()) return "sin nombre de la clienta";
  if (!String(c.product ?? "").trim()) return "sin producto en la guía";
  const returnedMs = Date.parse(c.returned_at);
  if (Number.isFinite(returnedMs)) {
    const days = (opts.nowMs - returnedMs) / 86_400_000;
    if (days > opts.maxDays) return `devuelta hace más de ${opts.maxDays} días`;
  }
  // Sin pedido enlazado no se escribe. El token `pedido` de la plantilla cae al
  // código de guía cuando falta el nombre, así que a la clienta le llegaría
  // «por tu pedido AUR5X146449144483» — un código interno del courier que ella
  // no ha visto nunca.
  //
  // Se mira `order_id` y NO `order_name`: el nombre puede ser una conjetura del
  // importador (0115), y durante meses fue una conjetura CON EL PREFIJO DE OTRA
  // TIENDA. Un texto inventado pasaría este filtro; el enlace no.
  //
  // Va la ÚLTIMA de las exclusiones a propósito: es la única que quien mira la
  // cola puede resolver ahí mismo, así que solo debe aparecer cuando no hay otro
  // motivo por delante. No tiene sentido ofrecer «enlazar pedido» en una guía
  // que además está excluida por el MOM §11.
  if (!c.order_id) return RECOVERY_SKIP_NO_ORDER;
  return null;
}

/** El motivo que la cola convierte en acción en vez de en explicación: es el
 *  único que se resuelve desde la propia pantalla. */
export const RECOVERY_SKIP_NO_ORDER = "sin pedido de Shopify enlazado";

// ── Parámetros de la plantilla ──────────────────────────────────────────────
//
// El cuerpo lo aprueba Meta y NO es el mismo en las dos tiendas: Kenku y Aurela
// son WABAs distintas, con plantillas cargadas por separado. Compilar el orden
// de los parámetros obligaría a un deploy cada vez que una de las dos cambie una
// palabra, así que el orden se configura (`stores.return_recovery_params`) y
// acá solo se resuelve cada token contra la guía.

/** Tokens que se pueden usar en `return_recovery_params`. */
export const RECOVERY_TOKENS = [
  "nombre",
  "producto",
  "monto",
  "pedido",
  "distrito",
  "agencia",
] as const;
export type RecoveryToken = (typeof RECOVERY_TOKENS)[number];

/** "Jose" — solo el primer nombre. Un "JOSE PIO PADILLA" completo en un saludo
 *  suena a cobranza; el primer nombre suena a la tienda que le vendió. */
export function firstName(full: string | null | undefined): string {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const w = parts[0]!;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** "S/ 89.00" con el formato que ya usan los rótulos y la secuencia de carritos. */
export function amountLabel(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return "";
  return `S/ ${Number(amount).toFixed(2)}`;
}

/** Parsea la config de tokens. Los desconocidos se ignoran en vez de romper el
 *  envío: una tienda mal configurada manda un parámetro de menos —que Meta
 *  rechaza con un error legible— y no tumba la corrida entera del cron. */
export function parseRecoveryParams(raw: string | null | undefined): RecoveryToken[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is RecoveryToken => (RECOVERY_TOKENS as readonly string[]).includes(t));
}

/**
 * Resuelve los parámetros del cuerpo, en el orden configurado. Devuelve `null`
 * cuando alguno queda vacío: es la última red antes de gastar un envío que Meta
 * va a rechazar por parámetro vacío (#132018). Pura.
 */
export function recoveryBodyParams(
  tokens: RecoveryToken[],
  c: RecoveryCandidate,
): string[] | null {
  if (!tokens.length) return null;
  const values = tokens.map((t) => {
    switch (t) {
      case "nombre":
        return firstName(c.customer_name);
      case "producto":
        return sanitizeTemplateParam(c.product);
      case "monto":
        return amountLabel(c.reported_collect_amount);
      case "pedido":
        return sanitizeTemplateParam(c.order_name ?? c.guide_code);
      case "distrito":
        return sanitizeTemplateParam(c.district ?? c.province);
      case "agencia":
        return sanitizeTemplateParam(c.province ?? c.district);
    }
  });
  return values.every((v) => v.length > 0) ? values.map(sanitizeTemplateParam) : null;
}

/** Horario local de envío. Un mensaje de recuperación a las 3 a.m. no se
 *  responde: se silencia el chat, que es peor que no haberlo mandado. */
export function recoveryWithinHours(
  nowIso: string,
  tz: string,
  hourStart: number,
  hourEnd: number,
): boolean {
  const h = tzParts(nowIso, tz).hour;
  return h >= hourStart && h < hourEnd;
}

// ── Cola y envío ────────────────────────────────────────────────────────────

/** Columnas que la cola y el envío leen de `shipments`. */
export const RECOVERY_COLS =
  "id, courier, guide_code, order_name, order_id, customer_name, customer_phone, product, district, province, reported_collect_amount, returned_at, returned_source, reported_status, non_delivery_reason, recovery_state, recovery_sent_at";

export interface RecoveryQueueRow extends RecoveryCandidate {
  /** `null` cuando es elegible; el motivo cuando no. */
  skip: string | null;
}

/** Ordena la cola como se trabaja: primero lo elegible, y dentro de eso lo más
 *  reciente — una devolución de ayer se recupera mucho mejor que una de tres
 *  semanas. Pura. */
export function buildRecoveryQueue(
  rows: RecoveryCandidate[],
  opts: { nowMs: number; maxDays: number },
): RecoveryQueueRow[] {
  return rows
    .map((c) => ({ ...c, skip: recoverySkipReason(c, opts) }))
    .sort((a, b) => {
      if ((a.skip === null) !== (b.skip === null)) return a.skip === null ? -1 : 1;
      return Date.parse(b.returned_at ?? "") - Date.parse(a.returned_at ?? "");
    });
}

export interface RecoveryReport {
  sent: number;
  failed: number;
  skipped: number;
}

/** Config de envío resuelta desde la tienda. */
export interface RecoveryConfig {
  templateName: string;
  language: string;
  tokens: RecoveryToken[];
  phoneNumberId: string;
  apiKey: string;
}

/** Lee la config de la tienda, o `null` si le falta algo para poder enviar.
 *  Devolverlo junto evita que el cron y el botón diverjan en las condiciones. */
export function recoveryConfig(creds: StoreCreds): RecoveryConfig | null {
  if (!creds.return_recovery_enabled) return null;
  if (!creds.return_recovery_template_name) return null;
  // El número propio (0114) basta por sí solo: una tienda puede recuperar desde
  // una línea aparte aunque no tenga número principal configurado.
  const phoneNumberId =
    creds.return_recovery_phone_number_id?.trim() || creds.whatsapp_phone_number_id;
  if (!creds.kapso_api_key || !phoneNumberId) return null;
  const tokens = parseRecoveryParams(creds.return_recovery_params);
  if (!tokens.length) return null;
  return {
    templateName: creds.return_recovery_template_name,
    language: creds.return_recovery_template_language ?? "es",
    tokens,
    phoneNumberId,
    apiKey: creds.kapso_api_key,
  };
}

/**
 * Envía la plantilla a UNA guía devuelta y registra el intento.
 *
 * Es el único camino de envío: lo llaman igual el botón de la cola y el cron
 * automático, y por eso la elegibilidad se vuelve a comprobar acá dentro. Un
 * botón pulsado sobre una pantalla vieja —la guía ya se recuperó, o alguien la
 * descartó hace un minuto— tiene que morir en el servidor, no en el navegador.
 *
 * La marca `recovery_state='enviado'` SOLO se pone cuando Meta acepta. Un
 * rechazo (plantilla en revisión, tope de mensajería, número dado de baja) deja
 * la guía en la cola para el siguiente intento y el motivo en
 * `return_recovery_sends.error`. Es lo contrario del drip, que quema el toque
 * aunque falle: allá el riesgo es martillar cada 5 min a un número que Meta
 * rechaza; acá la cola es chica, se drena a mano y perder la única oportunidad
 * de recuperar la venta por un error transitorio es el peor desenlace.
 */
export async function sendRecoveryTemplate(
  admin: SupabaseClient,
  storeId: string,
  candidate: RecoveryCandidate,
  cfg: RecoveryConfig,
  opts: {
    sentBy?: string | null;
    maxDays: number;
    nowIso?: string;
    sendTemplate?: typeof sendWhatsappTemplate;
  },
): Promise<{ ok: boolean; error?: string; code?: number }> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const send = opts.sendTemplate ?? sendWhatsappTemplate;

  const skip = recoverySkipReason(candidate, { nowMs: Date.parse(nowIso), maxDays: opts.maxDays });
  if (skip) return { ok: false, error: skip };

  const bodyParams = recoveryBodyParams(cfg.tokens, candidate);
  if (!bodyParams) return { ok: false, error: "faltan datos para armar la plantilla" };

  let ok = false;
  let err: string | null = null;
  let code: number | undefined;
  try {
    const res = await send(
      { apiKey: cfg.apiKey },
      {
        phoneNumberId: cfg.phoneNumberId,
        to: candidate.customer_phone!,
        templateName: cfg.templateName,
        language: cfg.language,
        bodyParams,
      },
    );
    ok = res.ok;
    if (!res.ok) {
      err = res.error ?? "envío rechazado";
      code = res.code;
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  await admin.from("return_recovery_sends").insert({
    store_id: storeId,
    shipment_id: candidate.id,
    phone: candidate.customer_phone,
    template_name: cfg.templateName,
    ok,
    error: err,
    sent_by: opts.sentBy ?? null,
  });

  if (ok) {
    await admin
      .from("shipments")
      .update({ recovery_state: "enviado", recovery_sent_at: nowIso })
      .eq("id", candidate.id)
      // Cierra la carrera entre el cron y el botón: el que llegue segundo no
      // encuentra fila que actualizar y no hay doble marca. El doble ENVÍO no lo
      // evita esto —los dos ya hablaron con Meta—, pero para que ocurra harían
      // falta dos pasadas dentro del mismo segundo sobre la misma guía.
      .is("recovery_state", null);
  }

  return { ok, error: err ?? undefined, code };
}

/**
 * Un pase automático del cron para una tienda. No hace nada salvo que la tienda
 * tenga `return_recovery_auto` encendido: `enabled` solo habilita la cola y el
 * botón. Ese segundo interruptor es a propósito — el mensaje pide plata por
 * adelantado, así que el primer lote de cada tienda conviene mirarlo.
 */
export async function runReturnRecovery(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
  nowIso = new Date().toISOString(),
): Promise<RecoveryReport> {
  const report: RecoveryReport = { sent: 0, failed: 0, skipped: 0 };
  if (!creds.return_recovery_auto) return report;
  const cfg = recoveryConfig(creds);
  if (!cfg) return report;
  const tz = creds.timezone || "America/Lima";
  if (
    !recoveryWithinHours(
      nowIso,
      tz,
      creds.return_recovery_hour_start ?? 8,
      creds.return_recovery_hour_end ?? 21,
    )
  ) {
    return report;
  }

  const maxDays = creds.return_recovery_max_days ?? RECOVERY_DEFAULT_MAX_DAYS;
  const sinceIso = new Date(Date.parse(nowIso) - maxDays * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("shipments")
    .select(RECOVERY_COLS)
    .eq("store_id", storeId)
    .is("recovery_state", null)
    .not("returned_at", "is", null)
    .gte("returned_at", sinceIso)
    .order("returned_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`return recovery select: ${error.message}`);

  const rows = (data as unknown as RecoveryCandidate[] | null) ?? [];
  const nowMs = Date.parse(nowIso);
  const eligible = rows.filter((c) => recoverySkipReason(c, { nowMs, maxDays }) === null);
  report.skipped = rows.length - eligible.length;

  for (const c of eligible.slice(0, RECOVERY_BATCH_CAP)) {
    const res = await sendRecoveryTemplate(admin, storeId, c, cfg, {
      maxDays,
      nowIso,
      sendTemplate,
    });
    if (res.ok) {
      report.sent += 1;
      continue;
    }
    report.failed += 1;
    // Tope de mensajería de Meta: es de la tienda, no de esta guía. Seguir el
    // lote solo suma rechazos y ensucia la calidad de la plantilla.
    if (isTierLimitError(res.code, res.error ?? null)) break;
  }
  return report;
}
