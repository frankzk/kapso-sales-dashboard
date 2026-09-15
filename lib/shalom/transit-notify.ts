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

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { getStoreCreds } from "@/lib/ingest";
import { sendWhatsappTemplate, type WhatsappSendResult } from "@/lib/kapso";
import { isSendablePhone, sanitizeTemplateParam } from "@/lib/leads-ingest";
import { parseLabelLineItems } from "@/lib/labels/line-items";
import { tzParts } from "@/lib/metrics";
import { loadStorePaymentMethods, yapeNumberParam } from "@/lib/payment-methods";
import { replyFirstName } from "@/lib/wa-reply-templates";
import { shalomVoucherPdf, signedDocUrl } from "@/lib/shalom/label-cache";
import { loadStoreShalom } from "@/lib/shalom/session";

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
] as const;
export type TransitToken = (typeof TRANSIT_TOKENS)[number];

/** El orden de `guias_shalom` tal como se aprobó en Meta. */
export const TRANSIT_DEFAULT_PARAMS = TRANSIT_TOKENS.join(",");

/** Cuántas veces se reintenta un envío antes de darlo por perdido. */
export const TRANSIT_MAX_ATTEMPTS = 5;
/** Tope de envíos por pasada del cron: cada uno puede costar una bajada del
 *  ticket, y el cron comparte sus 300 s con el rastreo. */
export const TRANSIT_BATCH_CAP = 20;
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
  templateName: string;
  language: string;
  tokens: TransitToken[];
  attachTicket: boolean;
  /** Número propio del aviso, o `null` para elegir por lead / tienda. */
  phoneNumberId: string | null;
  storePhoneNumberId: string | null;
  apiKey: string;
  hourStart: number;
  hourEnd: number;
  timezone: string;
}

export function transitConfig(creds: StoreCreds): { cfg: TransitConfig } | { cfg: null; reason: string } {
  if (!creds.shalom_transit_template_enabled) return { cfg: null, reason: "aviso apagado en la tienda" };
  if (!creds.shalom_transit_template_name) return { cfg: null, reason: "la tienda no tiene plantilla configurada" };
  if (!creds.kapso_api_key) return { cfg: null, reason: "la tienda no tiene API key de Kapso" };
  const tokens = parseTransitParams(creds.shalom_transit_params);
  if (!tokens.length) return { cfg: null, reason: "la tienda no tiene el orden de variables configurado" };
  return {
    cfg: {
      templateName: creds.shalom_transit_template_name,
      language: creds.shalom_transit_template_language ?? "es",
      tokens,
      attachTicket: Boolean(creds.shalom_transit_attach_ticket),
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
  input: { storeId: string; shipmentId: string; orderId: string | null },
): Promise<boolean> {
  const { error } = await admin
    .from("shalom_transit_notifications")
    .upsert(
      { store_id: input.storeId, shipment_id: input.shipmentId, order_id: input.orderId },
      { onConflict: "shipment_id", ignoreDuplicates: true },
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
  customer_name: string | null;
  customer_phone: string | null;
  agency_branch: string | null;
  province: string | null;
  district: string | null;
}

/** Lee todo lo que la plantilla necesita de un pedido. Ninguna lectura lanza:
 *  lo que falte sale como hueco y `transitBodyParams` lo nombra. */
async function gatherFacts(
  admin: SupabaseClient,
  storeId: string,
  shipment: ShipmentRow,
  orderId: string | null,
): Promise<{ facts: TransitFacts; phone: string | null; leadPhoneNumberId: string | null; orderName: string | null }> {
  const [master, order, draft, payments, methods] = await Promise.all([
    orderId
      ? admin
          .from("order_master")
          .select("order_name,customer_name,customer_phone,order_total")
          .eq("order_id", orderId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    orderId
      ? admin.from("orders").select("name,total_amount,customer_phone,line_items").eq("id", orderId).maybeSingle()
      : Promise.resolve({ data: null }),
    orderId
      ? admin.from("shalom_order_drafts").select("destiny_terminal_name").eq("order_id", orderId).maybeSingle()
      : Promise.resolve({ data: null }),
    orderId
      ? admin.from("order_payments").select("amount,validation_status").eq("order_id", orderId)
      : Promise.resolve({ data: [] as { amount: number | null; validation_status: string }[] }),
    loadStorePaymentMethods(admin, storeId),
  ]);

  const m = (master.data ?? null) as {
    order_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    order_total: number | null;
  } | null;
  const o = (order.data ?? null) as {
    name: string | null;
    total_amount: number | null;
    customer_phone: string | null;
    line_items: unknown;
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
      guideCode: shipment.guide_code,
      shalomCodigo: shipment.shalom_codigo,
      lineItems: o?.line_items ?? [],
      agencyName,
      orderTotal: m?.order_total ?? o?.total_amount ?? null,
      validatedAmount: validated,
      yapeNumber: yapeNumberParam(methods),
    },
    phone,
    leadPhoneNumberId,
    orderName: m?.order_name ?? o?.name ?? null,
  };
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
  } = {},
): Promise<TransitReport> {
  const report: TransitReport = { sent: 0, failed: 0, skipped: 0, deferred: 0, errors: [] };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const started = Date.now();
  const budget = opts.budgetMs ?? 150_000;
  const send = opts.sendTemplate ?? sendWhatsappTemplate;
  const loadCreds = opts.loadCreds ?? ((id: string) => getStoreCreds(id, admin));

  const { data, error } = await admin
    .from("shalom_transit_notifications")
    .select("id,store_id,shipment_id,order_id,attempts")
    .eq("status", "pending")
    .lte("next_attempt_at", nowIso)
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? TRANSIT_BATCH_CAP);
  if (error) {
    report.errors.push(`cola: ${error.message}`);
    return report;
  }
  const rows = (data ?? []) as TransitQueueRow[];
  if (!rows.length) return report;

  const credsByStore = new Map<string, StoreCreds | null>();
  const configByStore = new Map<string, ReturnType<typeof transitConfig>>();

  for (const row of rows) {
    if (Date.now() - started > budget) {
      report.deferred += 1;
      continue;
    }

    if (!credsByStore.has(row.store_id)) {
      const creds = await loadCreds(row.store_id);
      credsByStore.set(row.store_id, creds);
      configByStore.set(row.store_id, creds ? transitConfig(creds) : { cfg: null, reason: "tienda no encontrada" });
    }
    const resolved = configByStore.get(row.store_id)!;

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

    const outcome = await sendOne(admin, row, cfg, { nowIso, send });
    if (outcome === "sent") report.sent += 1;
    else if (outcome === "failed") report.failed += 1;
    else if (outcome === "retry") report.deferred += 1;
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
  ctx: { nowIso: string; send: SendTemplate },
): Promise<"sent" | "failed" | "retry"> {
  const attempts = (row.attempts ?? 0) + 1;

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
    .select("id,guide_code,shalom_codigo,shalom_ose_id,customer_name,customer_phone,agency_branch,province,district")
    .eq("id", row.shipment_id)
    .maybeSingle();
  const shipment = (sh ?? null) as ShipmentRow | null;
  if (!shipment) return fail("la guía ya no existe", { retryable: false });

  const { facts, phone, leadPhoneNumberId, orderName } = await gatherFacts(admin, row.store_id, shipment, row.order_id);

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

  // El ticket de Shalom en cabecera, si la tienda lo pide. Se baja (o se lee de
  // la caché) y se firma una URL que Meta pueda abrir. Sin ticket no se manda
  // una plantilla que lo exige: Meta la rechazaría igual y con menos contexto.
  let headerDocument: { link: string; filename: string } | undefined;
  if (cfg.attachTicket) {
    if (!shipment.shalom_ose_id) {
      return fail("la plantilla lleva el ticket pero la guía no tiene OSE ID (no se creó por API)", {
        retryable: false,
        patch: { phone, phone_number_id: phoneNumberId },
      });
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
      },
    );
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!res.ok) {
    // Una llamada ambigua —la petición pudo llegar a Meta y la respuesta no
    // volvió— NO se reintenta a ciegas: repetirla duplicaría el aviso. Se da
    // por perdida con el motivo escrito; alguien puede mandarla a mano.
    return fail(res.error ?? "envío rechazado", {
      retryable: !res.ambiguous,
      code: res.code,
      patch: { phone, phone_number_id: phoneNumberId, template_name: cfg.templateName, params: built.params },
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
    })
    .eq("id", row.id);

  if (row.order_id) {
    // Queda en la línea de tiempo del pedido, al lado del `courier_status` que
    // lo disparó: quien mire el pedido tiene que ver que se avisó y con qué.
    await admin.from("order_events").insert({
      store_id: row.store_id,
      order_id: row.order_id,
      kind: "whatsapp_template",
      occurred_at: ctx.nowIso,
      actor: null,
      source: "shalom_transit",
      courier: "shalom",
      guide_code: shipment.guide_code,
      note: `📤 Aviso de guía en tránsito: plantilla «${cfg.templateName}» enviada${
        orderName ? ` por ${orderName}` : ""
      }${headerDocument ? " con el ticket de Shalom" : ""}.`,
    });
  }
  return "sent";
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
