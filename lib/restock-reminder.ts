// Recordatorio de reposición (MOM §34, 13-10-2026).
//
// QUÉ HACE. Cuando a la clienta se le está por acabar lo que compró, le llega
// una plantilla de WhatsApp: «tu {producto} ya debe estar por terminarse», con
// un botón «Sí, quiero». Si lo toca —o contesta un «sí» pelado— una asesora la
// toma: el lead sube a «Atender ahora» con lo que quiere reponer, y Kapta le
// confirma que alguien le escribe. Así lo pidió el dueño: «que responda SÍ y lo
// tome una asesora». No se arma ningún pedido solo.
//
// CUÁNDO. Cada producto tiene sus días por unidad (`restock_products`): dos
// frascos de 30 días duran 60. Sale `restock_days_before` días antes de que se
// acabe, contados desde la entrega. Un producto sin días no recibe nada: es
// opt-in por producto, para que un accesorio nunca reciba «se te está
// acabando». La consulta vive en SQL (`restock_candidates`, 0255).
//
// ES LA GEMELA DEL AGRADECIMIENTO AL ENTREGAR (lib/delivered-thanks.ts): mismo
// cron, mismo ritmo en ventana deslizante, mismo horario, mismo corte ante el
// tope de Meta. Lo que agrega:
//
//   · GRUPO DE CONTROL. Un porcentaje de clientas (10 % por defecto), elegidas
//     por su teléfono y siempre las mismas, se registran sin enviarles nada.
//     Sin eso no se sabe si el recordatorio vende o si iban a volver igual —
//     el winback de Kenku se midió sin control y su 3,9 % no dice nada—.
//   · QUIÉN NO. Quien pidió que no le escriban (BAJA, o «no me contacten» al
//     agente de voz), y quien recibió otro recordatorio hace menos de 20 días.
//
// LO QUE NO HACE: interpretar texto libre. Igual que los botones de pago
// (lib/wa-button-replies.ts), solo reacciona al botón de la tienda y a una
// lista CERRADA de «sí». Un «¿y tienen el de 120 cápsulas?» sigue con el bot y
// la asesora, como siempre.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { applyHandoff, isSendablePhone, isTierLimitError, sanitizeTemplateParam } from "@/lib/leads-ingest";
import { handoffStatus } from "@/lib/leads";
import { sendWhatsappTemplate, sendWhatsappText, type InboundMessage } from "@/lib/kapso";
import { firstName, recoveryWithinHours } from "@/lib/return-recovery";
import { THANKS_BATCH_CAP, thanksPaceBudget } from "@/lib/delivered-thanks";
import { waImageUrl } from "@/lib/cart-image-test";
import { env } from "@/lib/env";

/** Hasta cuántos días después de vencer todavía se manda. Pasado eso, un
 *  «se te está por acabar» llega tarde: ya se le acabó hace semanas. */
export const RESTOCK_WINDOW_DAYS = 14;

/** Una clienta no recibe dos recordatorios en esta ventana, aunque tenga dos
 *  pedidos que venzan seguidos. */
export const RESTOCK_PHONE_COOLDOWN_DAYS = 20;

/** Tras tantos rechazos de Meta sobre el mismo pedido, se deja de intentar. */
export const RESTOCK_MAX_ATTEMPTS = 3;

/** Cuántas horas después del recordatorio un «sí» se lee como respuesta a él. */
export const RESTOCK_REPLY_WINDOW_HOURS = 72;

/** Cuántos días después del recordatorio un «BAJA» se lee como respuesta a él. */
export const RESTOCK_OPT_OUT_WINDOW_DAYS = 7;

export const RESTOCK_DEFAULT_BUTTON = "Sí, quiero";

/** Tokens del CUERPO de la plantilla. */
export const RESTOCK_BODY_TOKENS = ["nombre", "producto", "unidades", "pedido"] as const;
export type RestockBodyToken = (typeof RESTOCK_BODY_TOKENS)[number];

/** Lo que devuelve `restock_candidates` por pedido. */
export interface RestockCandidate {
  order_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivered_at: string;
  product_key: string;
  product_name: string;
  units: number;
  due_at: string;
}

/** Lo que ya consta, para no repetir ni escribirle a quien no quiere. */
export interface RestockHistory {
  /** Intentos rechazados por pedido. */
  failedAttempts: Map<string, number>;
  /** Teléfonos con un recordatorio (o fila de control) en los últimos 20 días. */
  recentPhones: Set<string>;
  /** Teléfonos que pidieron no ser contactados. */
  optedOut: Set<string>;
  /** Productos con foto en el espejo del catálogo (`shopify_product_images`). */
  productsWithImage: Set<string>;
}

/**
 * ¿Esta clienta cae en el grupo de control? Por el teléfono y no al azar:
 * así una misma clienta queda siempre del mismo lado, y comparar los dos
 * grupos mes a mes compara a las mismas personas. Pura.
 */
export function isControlPhone(phone: string, pct: number): boolean {
  if (pct <= 0) return false;
  const n = createHash("sha256").update(`restock:${phone}`, "utf8").digest().readUInt32BE(0);
  return n % 100 < pct;
}

/**
 * Por qué este pedido NO recibe el recordatorio, o null si lo recibe. El motivo
 * y no un booleano, para poder contarlo. Pura.
 */
export function restockSkipReason(c: RestockCandidate, history: RestockHistory): string | null {
  if ((history.failedAttempts.get(c.order_id) ?? 0) >= RESTOCK_MAX_ATTEMPTS) {
    return `Meta lo rechazó ${RESTOCK_MAX_ATTEMPTS} veces`;
  }
  // La plantilla lleva la foto del producto en la cabecera: sin foto, Meta
  // rechaza el envío. Y el dueño decidió que sin foto no se manda (14-10-2026).
  if (!history.productsWithImage.has(c.product_key)) return "el producto no tiene foto en Shopify";
  const phone = (c.customer_phone ?? "").trim();
  if (!isSendablePhone(phone)) return "sin número de WhatsApp válido";
  if (history.optedOut.has(phone)) return "pidió que no le escriban";
  if (history.recentPhones.has(phone)) {
    return `ya se le recordó en los últimos ${RESTOCK_PHONE_COOLDOWN_DAYS} días`;
  }
  // Sin nombre el saludo sale «¡Hola !», y Meta rechaza el parámetro vacío.
  if (!firstName(c.customer_name)) return "sin nombre de la clienta";
  return null;
}

export function parseRestockBodyParams(raw: string | null | undefined): RestockBodyToken[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is RestockBodyToken => (RESTOCK_BODY_TOKENS as readonly string[]).includes(t));
}

/**
 * Parámetros del cuerpo, en el orden configurado. Null si alguno queda vacío:
 * Meta rechaza los vacíos (#132018). Pura.
 */
export function restockBodyParams(tokens: RestockBodyToken[], c: RestockCandidate): string[] | null {
  const values = tokens.map((t) => {
    if (t === "nombre") return firstName(c.customer_name);
    if (t === "producto") return c.product_name;
    if (t === "unidades") return String(c.units);
    return String(c.order_name ?? "").trim();
  });
  const clean = values.map(sanitizeTemplateParam);
  return clean.every((v) => v.length > 0) ? clean : null;
}

export interface RestockConfig {
  templateName: string;
  language: string;
  bodyTokens: RestockBodyToken[];
  phoneNumberId: string;
  apiKey: string;
  hourStart: number;
  hourEnd: number;
  paceCount: number;
  paceMinutes: number;
  daysBefore: number;
  controlPct: number;
}

/** La config de la tienda, o null si le falta algo para poder enviar. */
export function restockConfig(creds: StoreCreds): RestockConfig | null {
  if (!creds.restock_enabled) return null;
  const templateName = creds.restock_template_name?.trim();
  if (!templateName) return null;
  const phoneNumberId = creds.restock_phone_number_id?.trim() || creds.whatsapp_phone_number_id;
  if (!creds.kapso_api_key || !phoneNumberId) return null;
  return {
    templateName,
    language: creds.restock_template_language?.trim() || "es",
    bodyTokens: parseRestockBodyParams(creds.restock_params),
    phoneNumberId,
    apiKey: creds.kapso_api_key,
    hourStart: creds.restock_hour_start ?? 9,
    hourEnd: creds.restock_hour_end ?? 20,
    paceCount: creds.restock_pace_count ?? 5,
    paceMinutes: creds.restock_pace_minutes ?? 20,
    daysBefore: creds.restock_days_before ?? 7,
    controlPct: creds.restock_control_pct ?? 10,
  };
}

export interface RestockReport {
  sent: number;
  control: number;
  failed: number;
  skipped: number;
}

/** Los teléfonos que pidieron no ser contactados: BAJA a un recordatorio
 *  (`contact_opt_outs`) o «no me contacten» al agente de voz (0247). Si no se
 *  puede leer, se lanza: escribirle a quien lo prohibió es peor que esperar a
 *  la próxima corrida. */
async function loadOptOuts(admin: SupabaseClient, storeId: string, phones: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!phones.length) return out;
  const { data: bajas, error } = await admin
    .from("contact_opt_outs")
    .select("phone")
    .eq("store_id", storeId)
    .in("phone", phones);
  if (error) throw new Error(`restock opt-outs: ${error.message}`);
  for (const r of (bajas ?? []) as { phone: string }[]) out.add(r.phone);
  const { data: leads, error: leadsError } = await admin
    .from("leads")
    .select("phone")
    .eq("store_id", storeId)
    .in("phone", phones)
    .not("contact_opt_out_at", "is", null);
  if (leadsError) throw new Error(`restock lead opt-outs: ${leadsError.message}`);
  for (const r of (leads ?? []) as { phone: string }[]) out.add(r.phone);
  return out;
}

async function loadHistory(
  admin: SupabaseClient,
  storeId: string,
  orderIds: string[],
  phones: string[],
  productKeys: string[],
  nowMs: number,
): Promise<RestockHistory> {
  const history: RestockHistory = {
    failedAttempts: new Map(),
    recentPhones: new Set(),
    optedOut: new Set(),
    productsWithImage: new Set(),
  };
  if (orderIds.length) {
    const { data, error } = await admin
      .from("restock_sends")
      .select("order_id")
      .eq("ok", false)
      .in("order_id", orderIds);
    if (error) throw new Error(`restock history: ${error.message}`);
    for (const r of (data ?? []) as { order_id: string }[]) {
      history.failedAttempts.set(r.order_id, (history.failedAttempts.get(r.order_id) ?? 0) + 1);
    }
  }
  if (phones.length) {
    const since = new Date(nowMs - RESTOCK_PHONE_COOLDOWN_DAYS * 86_400_000).toISOString();
    const { data, error } = await admin
      .from("restock_sends")
      .select("phone")
      .eq("store_id", storeId)
      .eq("ok", true)
      .gte("sent_at", since)
      .in("phone", phones);
    if (error) throw new Error(`restock phones: ${error.message}`);
    for (const r of (data ?? []) as { phone: string }[]) history.recentPhones.add(r.phone);
    history.optedOut = await loadOptOuts(admin, storeId, phones);
  }
  if (productKeys.length) {
    const { data, error } = await admin
      .from("shopify_product_images")
      .select("product_id")
      .eq("store_id", storeId)
      .in("product_id", productKeys)
      .not("image_url", "is", null);
    if (error) throw new Error(`restock images: ${error.message}`);
    for (const r of (data ?? []) as { product_id: string }[]) history.productsWithImage.add(String(r.product_id));
  }
  return history;
}

/**
 * Un pase del cron para una tienda. No hace nada si la tienda no lo tiene
 * encendido, si está fuera de horario o si falta configuración.
 */
export async function runRestockReminders(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
  nowIso = new Date().toISOString(),
  siteUrl = env.siteUrl(),
): Promise<RestockReport> {
  const report: RestockReport = { sent: 0, control: 0, failed: 0, skipped: 0 };
  const cfg = restockConfig(creds);
  if (!cfg) return report;
  const tz = creds.timezone || "America/Lima";
  if (!recoveryWithinHours(nowIso, tz, cfg.hourStart, cfg.hourEnd)) return report;

  const nowMs = Date.parse(nowIso);

  // El ritmo es el de las llamadas a Meta: las filas de control no cuentan.
  const paceSince = new Date(nowMs - cfg.paceMinutes * 60_000).toISOString();
  const { data: recent, error: paceError } = await admin
    .from("restock_sends")
    .select("sent_at")
    .eq("store_id", storeId)
    .eq("arm", "enviado")
    .gte("sent_at", paceSince);
  if (paceError) throw new Error(`restock pace: ${paceError.message}`);
  const budget = thanksPaceBudget({
    count: cfg.paceCount,
    minutes: cfg.paceMinutes,
    attemptsInWindow: (recent ?? []).length,
  });
  if (budget === 0) return report;

  const { data, error } = await admin.rpc("restock_candidates", {
    p_store_id: storeId,
    p_now: nowIso,
    p_days_before: cfg.daysBefore,
    p_window_days: RESTOCK_WINDOW_DAYS,
    p_limit: 300,
  });
  if (error) throw new Error(`restock candidates: ${error.message}`);
  const rows = (data as RestockCandidate[] | null) ?? [];
  if (!rows.length) return report;

  const history = await loadHistory(
    admin,
    storeId,
    rows.map((r) => r.order_id),
    [...new Set(rows.map((r) => (r.customer_phone ?? "").trim()).filter(Boolean))],
    [...new Set(rows.map((r) => r.product_key))],
    nowMs,
  );

  // Las filas de control no gastan llamadas, pero tampoco pueden crecer sin
  // tope en una sola corrida: el techo duro vale para las dos.
  for (const c of rows) {
    if (report.sent + report.failed >= budget) break;
    if (report.sent + report.failed + report.control >= THANKS_BATCH_CAP * 2) break;
    if (restockSkipReason(c, history)) {
      report.skipped += 1;
      continue;
    }
    const bodyParams = restockBodyParams(cfg.bodyTokens, c);
    if (cfg.bodyTokens.length && !bodyParams) {
      report.skipped += 1;
      continue;
    }
    const phone = (c.customer_phone ?? "").trim();
    const base = {
      store_id: storeId,
      order_id: c.order_id,
      phone,
      product_key: c.product_key,
      product_name: c.product_name,
      units: c.units,
      due_at: c.due_at,
      template_name: cfg.templateName,
    };

    if (isControlPhone(phone, cfg.controlPct)) {
      await admin.from("restock_sends").insert({ ...base, arm: "control", ok: true, error: null });
      report.control += 1;
      history.recentPhones.add(phone);
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
          // La foto del producto, en JPG: Meta no acepta el WebP de Shopify
          // (ver app/api/wa-image).
          headerImage: { link: waImageUrl(siteUrl, storeId, c.product_key) },
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

    await admin.from("restock_sends").insert({ ...base, arm: "enviado", ok, error: err });

    if (ok) {
      report.sent += 1;
      history.recentPhones.add(phone);
      continue;
    }
    report.failed += 1;
    history.failedAttempts.set(c.order_id, (history.failedAttempts.get(c.order_id) ?? 0) + 1);
    // Tope de mensajería de Meta: es de la tienda, no de este pedido.
    if (isTierLimitError(code, err)) break;
  }
  return report;
}

// ── La respuesta ────────────────────────────────────────────────────────────

/** Sin acentos, minúsculas y sin signos. La misma normalización que los
 *  botones de pago, para que «Sí, quiero» y «si quiero» sean lo mismo. */
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
 * Los «sí» escritos a mano que valen como el botón. Lista CERRADA: «sí, pero
 * ¿cuánto cuesta?» no está, y por eso sigue con el bot y la asesora.
 */
const YES_TEXTS = new Set([
  "si",
  "sii",
  "siii",
  "si quiero",
  "si deseo",
  "si por favor",
  "si porfa",
  "si porfavor",
  "si gracias",
  "si claro",
  "claro",
  "claro que si",
  "quiero",
  "lo quiero",
  "si lo quiero",
  "me interesa",
  "si me interesa",
  "dale",
  "ok si",
  "si ok",
]);

/** Pedir que no le escriban más. También lista cerrada. */
const OPT_OUT_TEXTS = new Set([
  "baja",
  "stop",
  "dar de baja",
  "darme de baja",
  "no me escriban",
  "no me escriban mas",
  "no quiero recibir mensajes",
  "no quiero mas mensajes",
]);

export type RestockReplyKind = "boton" | "si" | "baja";

/**
 * Qué es este mensaje para el recordatorio, o null si no es nada suyo. El botón
 * se compara con el rótulo que la tienda puso en su plantilla. Pura.
 */
export function matchRestockReply(
  msg: Pick<InboundMessage, "text" | "buttonText" | "buttonPayload">,
  buttonLabel: string | null | undefined,
): RestockReplyKind | null {
  const label = key(String(buttonLabel ?? "") || RESTOCK_DEFAULT_BUTTON);
  if (msg.buttonText || msg.buttonPayload) {
    for (const raw of [msg.buttonText, msg.buttonPayload]) {
      if (label && key(String(raw ?? "")) === label) return "boton";
    }
    return null;
  }
  const k = key(String(msg.text ?? ""));
  if (!k) return null;
  if (YES_TEXTS.has(k)) return "si";
  if (OPT_OUT_TEXTS.has(k)) return "baja";
  return null;
}

/** «12 de octubre». */
function dayLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "long", timeZone: tz }).format(new Date(iso));
}

/**
 * Lo que lee la asesora en «Atender ahora». Va SIN palabras de cobro: el
 * handoff que las lleva se va a la pestaña Yape/Shalom (`handoffStatus`), y
 * esta clienta no trae un pago sino ganas de comprar. Si el nombre corto del
 * producto las tuviera, se omite. Pura.
 */
export function restockHandoffContext(s: {
  product_name: string;
  units: number;
  order_name: string | null;
  delivered_at: string | null;
  tz: string;
}): string {
  const entrega = s.delivered_at ? `, entregado el ${dayLabel(s.delivered_at, s.tz)}` : "";
  const pedido = s.order_name ? ` Su pedido anterior: ${s.order_name} (${s.units} u.${entrega}).` : "";
  const full = `Quiere reponer ${s.product_name}: contestó SÍ al recordatorio de reposición.${pedido} Escríbele para armar el pedido.`;
  if (handoffStatus("recompra", full) === "casi_cierra") return full;
  return `Quiere reponer lo que compró: contestó SÍ al recordatorio de reposición. Escríbele para armar el pedido.`;
}

/** La confirmación que recibe la clienta. No promete minutos: puede contestar
 *  a las once de la noche. */
export function restockConfirmation(name: string | null | undefined, product: string): string {
  const nombre = firstName(name);
  return `¡Gracias${nombre ? `, ${nombre}` : ""}! 🙌 Ya le avisé a una asesora: te escribe por aquí para coordinar tu ${product}.`;
}

interface RecentSend {
  id: string;
  order_id: string;
  product_name: string;
  units: number;
  sent_at: string;
  replied_at: string | null;
}

/**
 * Atiende la respuesta a un recordatorio. Devuelve null cuando el mensaje no es
 * del recordatorio —no es un «sí», o no hubo recordatorio reciente a ese
 * celular—, y el llamador sigue con lo suyo. Nunca lanza.
 *
 * No mira si la tienda lo tiene encendido: quien recibió el recordatorio ayer
 * tiene que ser atendida aunque hoy se haya apagado.
 */
export async function handleRestockReply(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  msg: InboundMessage,
  opts: { sendText?: typeof sendWhatsappText; handoff?: typeof applyHandoff; nowIso?: string } = {},
): Promise<{ reason: string } | null> {
  const kind = matchRestockReply(msg, creds.restock_button_label);
  if (!kind) return null;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const windowHours = kind === "baja" ? RESTOCK_OPT_OUT_WINDOW_DAYS * 24 : RESTOCK_REPLY_WINDOW_HOURS;

  let last: RecentSend | null = null;
  try {
    const { data, error } = await admin
      .from("restock_sends")
      .select("id, order_id, product_name, units, sent_at, replied_at")
      .eq("store_id", storeId)
      .eq("phone", msg.from)
      .eq("arm", "enviado")
      .eq("ok", true)
      .gte("sent_at", new Date(nowMs - windowHours * 3_600_000).toISOString())
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Pre-0255 la tabla no existe: no hubo recordatorios que contestar.
    if (error) return null;
    last = (data as RecentSend | null) ?? null;
  } catch {
    return null;
  }
  if (!last) return null;

  if (kind === "baja") {
    // En silencio: no se le contesta con otro mensaje a quien pidió no recibir
    // más. La asesora lo ve en el chat como siempre.
    await admin
      .from("contact_opt_outs")
      .upsert({ store_id: storeId, phone: msg.from, source: "restock_baja" }, { onConflict: "store_id,phone" });
    return { reason: "restock:baja" };
  }
  if (last.replied_at) return null;

  // Reservar el mensaje ANTES de nada: Kapso reintenta los webhooks, y dos
  // entregas del mismo `wamid` subirían el lead y contestarían dos veces.
  const phoneNumberId = msg.phoneNumberId ?? creds.restock_phone_number_id ?? creds.whatsapp_phone_number_id;
  const { error: claimError } = await admin.from("wa_auto_replies").insert({
    store_id: storeId,
    inbound_message_id: msg.id,
    phone: msg.from,
    phone_number_id: phoneNumberId,
    trigger: "recompra",
    order_id: last.order_id,
  });
  if (claimError) {
    if (claimError.code === "23505") return { reason: "duplicate_inbound" };
    return { reason: `claim_failed:${claimError.message}` };
  }

  await admin
    .from("restock_sends")
    .update({ replied_at: nowIso, reply_kind: kind })
    .eq("id", last.id)
    .is("replied_at", null);

  const { data: order } = await admin
    .from("order_master")
    .select("order_name, customer_name, delivered_at")
    .eq("order_id", last.order_id)
    .maybeSingle();
  const o = (order as { order_name: string | null; customer_name: string | null; delivered_at: string | null } | null) ?? null;
  const tz = creds.timezone || "America/Lima";

  // El mismo camino que el bot cuando deriva: el lead sube a «Atender ahora».
  // Si ya compró antes, conserva su estado y solo se marca para atender.
  const handoff = opts.handoff ?? applyHandoff;
  const res = await handoff(admin, storeId, {
    phone_number: msg.from,
    conversation_id: msg.conversationId,
    reason: "recompra",
    context_summary: restockHandoffContext({
      product_name: last.product_name,
      units: last.units,
      order_name: o?.order_name ?? null,
      delivered_at: o?.delivered_at ?? null,
      tz,
    }),
    ...(o?.customer_name ? { conversation: { contact_name: o.customer_name } } : {}),
  });

  const send = opts.sendText ?? sendWhatsappText;
  if (!creds.kapso_api_key || !phoneNumberId) {
    await admin
      .from("wa_auto_replies")
      .update({ error: "la tienda no tiene API key de Kapso o número de WhatsApp" })
      .eq("store_id", storeId)
      .eq("inbound_message_id", msg.id);
    return { reason: `restock:${kind};handoff:${res.ok ? "ok" : res.reason};sin_respuesta` };
  }
  const text = restockConfirmation(o?.customer_name, last.product_name);
  let ok = false;
  let error: string | null = null;
  let providerId: string | null = null;
  try {
    const r = await send({ apiKey: creds.kapso_api_key }, { phoneNumberId, to: msg.from, body: text });
    ok = r.ok;
    if (r.ok) providerId = r.id;
    else error = r.error ?? "envío rechazado";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await admin
    .from("wa_auto_replies")
    .update({ body: text, ok, error, provider_message_id: providerId })
    .eq("store_id", storeId)
    .eq("inbound_message_id", msg.id);

  return { reason: `restock:${kind};handoff:${res.ok ? "ok" : res.reason}${ok ? "" : `;reply_failed:${error}`}` };
}
