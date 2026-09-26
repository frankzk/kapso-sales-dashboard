// Agradecimiento con catálogo al entregar.
//
// QUÉ HACE. Cuando un pedido pasa a ENTREGADO se le manda a la clienta una
// plantilla de WhatsApp: gracias por la compra, y un botón al catálogo privado
// de la tienda con precios de descuento. El catálogo identifica a la clienta por
// su celular (`?wa=`), así que el botón lleva URL dinámica y el número va en la
// variable del botón.
//
// POR QUÉ UNA PLANTILLA. La entrega llega días después de la última
// conversación: la ventana de 24 h de WhatsApp ya se cerró, y fuera de ella solo
// entra una plantilla aprobada. Lleva una oferta, así que es de MARKETING — Meta
// reclasifica o rechaza una oferta presentada como Utilidad.
//
// ES LA GEMELA DE LA RECUPERACIÓN DE DEVUELTOS (lib/return-recovery.ts): mismo
// cron, mismo helper de envío, misma forma de configurar las variables por
// tokens. Lo que cambia son las reglas de a quién:
//
//   · Solo pedidos ENTREGADOS, y solo si la entrega es reciente. Muchas
//     entregas se marcan en bloque al importar un reporte de Aliclik, a veces
//     días después — y un «gracias» de hace una semana suena a error.
//   · UNA vez por pedido, y UNA por clienta cada 7 días: quien recibió dos
//     pedidos el mismo día recibe un solo agradecimiento.
//   · Tope por corrida y horario: una importación que marca 200 entregas de
//     golpe no puede convertirse en 200 plantillas de marketing en un minuto,
//     que es exactamente lo que le baja la calidad al número.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { isSendablePhone, isTierLimitError, sanitizeTemplateParam } from "@/lib/leads-ingest";
import { sendWhatsappTemplate } from "@/lib/kapso";
import { firstName, recoveryWithinHours } from "@/lib/return-recovery";

/** Envíos por tienda y por corrida (el cron corre cada 5 min ⇒ hasta 300/h). */
export const THANKS_BATCH_CAP = 25;

/** Una clienta no recibe dos agradecimientos en esta ventana. */
export const THANKS_PHONE_COOLDOWN_DAYS = 7;

/** Tras tantos rechazos de Meta sobre el mismo pedido, se deja de intentar. */
export const THANKS_MAX_ATTEMPTS = 3;

/** Tokens del CUERPO de la plantilla. */
export const THANKS_BODY_TOKENS = ["nombre", "pedido"] as const;
export type ThanksBodyToken = (typeof THANKS_BODY_TOKENS)[number];

/** Tokens de la variable del BOTÓN de URL dinámica. */
export const THANKS_BUTTON_TOKENS = ["telefono", "pedido"] as const;
export type ThanksButtonToken = (typeof THANKS_BUTTON_TOKENS)[number];

/** Lo que se lee de cada pedido candidato (`order_master`). */
export interface ThanksCandidate {
  order_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  general_status: string | null;
  delivered_at: string | null;
}

export const THANKS_COLS =
  "order_id, order_name, customer_name, customer_phone, general_status, delivered_at";

/** Lo que ya consta de envíos previos, para no repetir. */
export interface ThanksHistory {
  /** Pedidos con un envío aceptado. */
  thankedOrders: Set<string>;
  /** Intentos rechazados por pedido. */
  failedAttempts: Map<string, number>;
  /** Teléfonos con un envío aceptado dentro de la ventana de 7 días. */
  recentPhones: Set<string>;
}

/**
 * Por qué este pedido NO recibe el agradecimiento, o null si lo recibe.
 * Devuelve el motivo y no un booleano para que se pueda contar y explicar. Pura.
 */
export function thanksSkipReason(
  c: ThanksCandidate,
  history: ThanksHistory,
  opts: { nowMs: number; maxHours: number },
): string | null {
  if (c.general_status !== "entregado") return "el pedido no está entregado";
  if (history.thankedOrders.has(c.order_id)) return "ya se le agradeció";
  if ((history.failedAttempts.get(c.order_id) ?? 0) >= THANKS_MAX_ATTEMPTS) {
    return `Meta lo rechazó ${THANKS_MAX_ATTEMPTS} veces`;
  }
  if (!c.delivered_at) return "sin fecha de entrega";
  const hours = (opts.nowMs - Date.parse(c.delivered_at)) / 3_600_000;
  if (!Number.isFinite(hours) || hours > opts.maxHours) {
    return `entregado hace más de ${opts.maxHours} h`;
  }
  const phone = (c.customer_phone ?? "").trim();
  if (!isSendablePhone(phone)) return "sin número de WhatsApp válido";
  if (history.recentPhones.has(phone)) {
    return `ya se le agradeció en los últimos ${THANKS_PHONE_COOLDOWN_DAYS} días`;
  }
  // Sin nombre el saludo sale «¡Hola !», y Meta rechaza el parámetro vacío.
  if (!firstName(c.customer_name)) return "sin nombre de la clienta";
  return null;
}

export function parseThanksBodyParams(raw: string | null | undefined): ThanksBodyToken[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is ThanksBodyToken => (THANKS_BODY_TOKENS as readonly string[]).includes(t));
}

/**
 * Un token por cada botón de URL DINÁMICA de la plantilla, en orden.
 *
 * ES UNA LISTA porque Meta exige un valor para CADA botón dinámico, y una
 * plantilla puede tener varios: la de Kenku lleva dos —«Kenku» y «Aurela»,
 * cada uno a su catálogo— y los dos esperan el celular. Con un solo valor,
 * Meta rechaza el envío entero por número de parámetros. Vacío = la plantilla
 * no lleva botones dinámicos. Los tokens desconocidos se descartan.
 */
export function parseThanksButtonParams(raw: string | null | undefined): ThanksButtonToken[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is ThanksButtonToken => (THANKS_BUTTON_TOKENS as readonly string[]).includes(t));
}

/** «KP136564» — el nombre del pedido sin «#», que en una URL cortaría el link. */
function orderCode(name: string | null | undefined): string {
  return String(name ?? "").trim().replace(/^#+/, "");
}

/**
 * Parámetros del cuerpo, en el orden configurado. Null si alguno queda vacío:
 * Meta rechaza los vacíos (#132018) y es mejor no gastar el envío. Pura.
 */
export function thanksBodyParams(tokens: ThanksBodyToken[], c: ThanksCandidate): string[] | null {
  const values = tokens.map((t) =>
    t === "nombre" ? firstName(c.customer_name) : sanitizeTemplateParam(orderCode(c.order_name)),
  );
  return values.every((v) => v.length > 0) ? values.map(sanitizeTemplateParam) : null;
}

/**
 * La variable del botón. `telefono` va en DÍGITOS y sin «+»: en una URL el «+»
 * se lee como un espacio, así que `?wa=+519…` le llegaría al catálogo como
 * ` 519…`. Pura.
 */
export function thanksButtonParam(token: ThanksButtonToken, c: ThanksCandidate): string {
  if (token === "telefono") return (c.customer_phone ?? "").replace(/\D/g, "");
  return orderCode(c.order_name);
}

export interface ThanksConfig {
  templateName: string;
  language: string;
  bodyTokens: ThanksBodyToken[];
  buttonTokens: ThanksButtonToken[];
  phoneNumberId: string;
  apiKey: string;
  hourStart: number;
  hourEnd: number;
  maxHours: number;
}

/** La config de la tienda, o null si le falta algo para poder enviar. */
export function thanksConfig(creds: StoreCreds): ThanksConfig | null {
  if (!creds.delivered_thanks_enabled) return null;
  const templateName = creds.delivered_thanks_template_name?.trim();
  if (!templateName) return null;
  const phoneNumberId =
    creds.delivered_thanks_phone_number_id?.trim() || creds.whatsapp_phone_number_id;
  if (!creds.kapso_api_key || !phoneNumberId) return null;
  return {
    templateName,
    language: creds.delivered_thanks_template_language?.trim() || "es",
    bodyTokens: parseThanksBodyParams(creds.delivered_thanks_params),
    buttonTokens: parseThanksButtonParams(creds.delivered_thanks_button_param),
    phoneNumberId,
    apiKey: creds.kapso_api_key,
    hourStart: creds.delivered_thanks_hour_start ?? 9,
    hourEnd: creds.delivered_thanks_hour_end ?? 21,
    maxHours: creds.delivered_thanks_max_hours ?? 72,
  };
}

export interface ThanksReport {
  sent: number;
  failed: number;
  skipped: number;
}

async function loadHistory(
  admin: SupabaseClient,
  storeId: string,
  orderIds: string[],
  phones: string[],
  nowMs: number,
): Promise<ThanksHistory> {
  const history: ThanksHistory = {
    thankedOrders: new Set(),
    failedAttempts: new Map(),
    recentPhones: new Set(),
  };
  if (orderIds.length) {
    const { data, error } = await admin
      .from("delivered_thanks_sends")
      .select("order_id, ok")
      .in("order_id", orderIds);
    if (error) throw new Error(`delivered thanks history: ${error.message}`);
    for (const r of (data ?? []) as { order_id: string; ok: boolean }[]) {
      if (r.ok) history.thankedOrders.add(r.order_id);
      else history.failedAttempts.set(r.order_id, (history.failedAttempts.get(r.order_id) ?? 0) + 1);
    }
  }
  if (phones.length) {
    const since = new Date(nowMs - THANKS_PHONE_COOLDOWN_DAYS * 86_400_000).toISOString();
    const { data, error } = await admin
      .from("delivered_thanks_sends")
      .select("phone")
      .eq("store_id", storeId)
      .eq("ok", true)
      .gte("sent_at", since)
      .in("phone", phones);
    if (error) throw new Error(`delivered thanks phones: ${error.message}`);
    for (const r of (data ?? []) as { phone: string }[]) history.recentPhones.add(r.phone);
  }
  return history;
}

/**
 * Un pase del cron para una tienda. No hace nada si la tienda no lo tiene
 * encendido, si está fuera de horario o si falta configuración.
 */
export async function runDeliveredThanks(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
  nowIso = new Date().toISOString(),
): Promise<ThanksReport> {
  const report: ThanksReport = { sent: 0, failed: 0, skipped: 0 };
  const cfg = thanksConfig(creds);
  if (!cfg) return report;
  const tz = creds.timezone || "America/Lima";
  if (!recoveryWithinHours(nowIso, tz, cfg.hourStart, cfg.hourEnd)) return report;

  const nowMs = Date.parse(nowIso);
  const sinceIso = new Date(nowMs - cfg.maxHours * 3_600_000).toISOString();
  const { data, error } = await admin
    .from("order_master")
    .select(THANKS_COLS)
    .eq("store_id", storeId)
    .eq("general_status", "entregado")
    .gte("delivered_at", sinceIso)
    .order("delivered_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`delivered thanks select: ${error.message}`);
  const rows = (data as unknown as ThanksCandidate[] | null) ?? [];
  if (!rows.length) return report;

  const history = await loadHistory(
    admin,
    storeId,
    rows.map((r) => r.order_id),
    [...new Set(rows.map((r) => (r.customer_phone ?? "").trim()).filter(Boolean))],
    nowMs,
  );

  for (const c of rows) {
    if (report.sent + report.failed >= THANKS_BATCH_CAP) break;
    if (thanksSkipReason(c, history, { nowMs, maxHours: cfg.maxHours })) {
      report.skipped += 1;
      continue;
    }
    const bodyParams = thanksBodyParams(cfg.bodyTokens, c);
    if (cfg.bodyTokens.length && !bodyParams) {
      report.skipped += 1;
      continue;
    }
    const phone = (c.customer_phone ?? "").trim();
    const buttonValues = cfg.buttonTokens.map((t) => thanksButtonParam(t, c));
    if (buttonValues.some((v) => !v)) {
      report.skipped += 1;
      continue;
    }

    let ok = false;
    let err: string | null = null;
    let code: number | undefined;
    try {
      const res = await sendTemplate(
        { apiKey: cfg.apiKey },
        {
          phoneNumberId: cfg.phoneNumberId,
          to: phone,
          templateName: cfg.templateName,
          language: cfg.language,
          bodyParams: bodyParams ?? undefined,
          buttonUrlParams: buttonValues.length ? buttonValues : undefined,
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

    await admin.from("delivered_thanks_sends").insert({
      store_id: storeId,
      order_id: c.order_id,
      phone,
      template_name: cfg.templateName,
      ok,
      error: err,
    });

    if (ok) {
      report.sent += 1;
      // La misma clienta con otro pedido entregado en este lote no recibe dos.
      history.thankedOrders.add(c.order_id);
      history.recentPhones.add(phone);
      continue;
    }
    report.failed += 1;
    history.failedAttempts.set(c.order_id, (history.failedAttempts.get(c.order_id) ?? 0) + 1);
    // Tope de mensajería de Meta: es de la tienda, no de este pedido. Seguir el
    // lote solo suma rechazos y ensucia la calidad del número.
    if (isTierLimitError(code, err)) break;
  }
  return report;
}
