// Secuencia de WhatsApp para CARRITOS ABANDONADOS (drafts COD de Shopify):
// dos plantillas aprobadas por Meta ancladas a la CREACIÓN del carrito
// (default +3h y +24h, configurables por tienda), enviadas desde el cron de
// sync solo en horario local configurable. Espejo del drip de seguimiento
// (lib/leads-ingest.ts → sendSeguimientoDrip) con dos diferencias de fondo:
// el reloj se ancla al carrito (no a la última gestión) y el público es
// cualquier lead con carrito ABIERTO aún trabajable (open/hot), no solo los
// "no contesta".
//
// DISEÑO ANTI-CRUCE: la secuencia es solo-envío. Escribe únicamente en sus
// columnas propias (cart_seq_touches / last_cart_seq_at / cart_seq_gid), en
// cart_seq_sends y en el timeline (lead_calls kind=system). NUNCA toca
// status / category / needs_attention / next_followup_at, así corre en
// paralelo con la gestión de la asesora, el reencolado a "sin llamar"
// (reopen) y las olas de atención sin pisarse con ninguno.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { isTierLimitError } from "@/lib/leads-ingest";
import { sendWhatsappTemplate } from "@/lib/kapso";
import { tzParts } from "@/lib/metrics";

/** Toques máximos de la secuencia (plantilla 1 y plantilla 2). */
export const CART_SEQ_MAX_TOUCHES = 2;
/** Espaciado mínimo entre toque 1 y 2 aunque la config diga otra cosa (p.ej.
 *  horas_2 ≤ horas_1 por error, o un backlog que venció ambos pasos a la vez). */
export const CART_SEQ_MIN_GAP_HOURS = 1;
/** Tope de envíos por tienda por corrida del cron (drena de a pocos). */
export const CART_SEQ_BATCH_CAP = 25;
/** Defaults de config (espejados en la migración 0040). */
export const CART_SEQ_DEFAULT_HOURS_1 = 3;
export const CART_SEQ_DEFAULT_HOURS_2 = 24;
export const CART_SEQ_DEFAULT_HOUR_START = 8;
export const CART_SEQ_DEFAULT_HOUR_END = 21;

export interface CartSeqConfig {
  hours1: number; // horas desde la creación del carrito → toque 1
  hours2: number; // horas desde la creación del carrito → toque 2
}

export interface CartSeqLead {
  id: string;
  phone: string;
  /** Número por el que escribió el cliente (multinúmero) — se envía por ESE
   *  número; fallback: el default de la tienda. Mismo criterio que el drip. */
  wa_phone_number_id?: string | null;
  name: string | null;
  category: string; // open | hot | won | lost
  has_order: boolean;
  draft_order_gid: string | null;
  draft_order_status: string | null; // open | invoice_sent | completed
  last_inbound_at: string | null;
  cart_seq_touches: number | null;
  last_cart_seq_at: string | null;
  cart_seq_gid: string | null;
  cart_summary?: string | null;
}

/** Toques que cuentan para el carrito ACTUAL: un gid distinto = carrito nuevo
 *  (recompra o re-checkout) ⇒ la secuencia arranca de cero. */
export function cartSeqTouchesFor(
  l: Pick<CartSeqLead, "cart_seq_touches" | "cart_seq_gid" | "draft_order_gid">,
): number {
  if (l.cart_seq_gid && l.cart_seq_gid !== l.draft_order_gid) return 0;
  return l.cart_seq_touches ?? 0;
}

/**
 * Por qué un lead NO recibe el siguiente toque ahora (null = elegible).
 * Pure — es LA regla de la secuencia; el fetch solo pre-filtra lo barato.
 * Paradas acordadas: ya tiene pedido / quedó won (ganado) o lost (perdido,
 * lista negra, número inválido…) / el carrito se completó o borró / el
 * cliente escribió DESPUÉS de crear el carrito (lo lleva el bot o la
 * asesora). Además: sin nombre no hay {{1}}; y el toque respeta su hora
 * ancla + el espaciado mínimo entre toques.
 */
export function cartSeqSkipReason(
  l: CartSeqLead,
  cartCreatedAtIso: string | null | undefined,
  nowMs: number,
  cfg: CartSeqConfig,
): string | null {
  if (!l.draft_order_gid) return "sin_carrito";
  if (l.draft_order_status !== "open" && l.draft_order_status !== "invoice_sent") {
    return "carrito_cerrado";
  }
  if (l.has_order) return "con_pedido";
  if (l.category === "won") return "ganado";
  if (l.category === "lost") return "perdido";
  if (!l.name) return "sin_nombre";
  const cartMs = cartCreatedAtIso ? Date.parse(cartCreatedAtIso) : NaN;
  if (!Number.isFinite(cartMs)) return "sin_fecha_carrito";
  if (l.last_inbound_at && Date.parse(l.last_inbound_at) > cartMs) return "respondio";
  const touches = cartSeqTouchesFor(l);
  if (touches >= CART_SEQ_MAX_TOUCHES) return "tope";
  const dueMs = cartMs + (touches === 0 ? cfg.hours1 : cfg.hours2) * 3_600_000;
  if (nowMs < dueMs) return "aun_no";
  if (touches > 0 && l.last_cart_seq_at && l.cart_seq_gid === l.draft_order_gid) {
    if (nowMs - Date.parse(l.last_cart_seq_at) < CART_SEQ_MIN_GAP_HOURS * 3_600_000) {
      return "espera_toque2";
    }
  }
  return null;
}

/** ¿Estamos dentro de la ventana de envío [start, end) en la zona de la
 *  tienda? Una config sin sentido (end ≤ start) cae a los defaults 8–21. */
export function cartSeqWithinHours(
  nowIso: string,
  tz: string,
  startHour: number,
  endHour: number,
): boolean {
  let start = Math.trunc(startHour);
  let end = Math.trunc(endHour);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 24 || end <= start) {
    start = CART_SEQ_DEFAULT_HOUR_START;
    end = CART_SEQ_DEFAULT_HOUR_END;
  }
  const h = tzParts(nowIso, tz).hour;
  return h >= start && h < end;
}

export interface CartSeqReport {
  sent: number;
  failed: number;
  skipped: number; // candidatos SQL descartados por la regla fina
}

/**
 * Un pase de la secuencia para una tienda: selecciona leads con carrito
 * abierto (SQL grueso + `cartSeqSkipReason` fino, con la fecha de creación
 * del carrito traída de draft_orders), envía la plantilla del toque que toca
 * y registra el envío. El toque se CONSUME aunque el envío falle (para no
 * re-martillar cada 5 min un número que Meta rechaza), salvo tope de
 * mensajería de la tienda (`isTierLimitError`), que corta el lote sin
 * consumir. No toca status/last_interaction_at (ver cabecera). Pre-0040
 * nunca llega aquí: getStoreCreds devuelve cart_seq_enabled=false.
 */
export async function runCartSequence(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
  nowIso = new Date().toISOString(),
): Promise<CartSeqReport> {
  const report: CartSeqReport = { sent: 0, failed: 0, skipped: 0 };
  if (!creds.cart_seq_enabled) return report;
  if (!creds.kapso_api_key) return report;
  if (
    !cartSeqWithinHours(
      nowIso,
      creds.timezone || "America/Lima",
      creds.cart_seq_hour_start,
      creds.cart_seq_hour_end,
    )
  ) {
    return report;
  }

  const nowMs = Date.parse(nowIso);
  const cfg: CartSeqConfig = { hours1: creds.cart_seq_hours_1, hours2: creds.cart_seq_hours_2 };

  // SQL grueso: leads de la tienda con carrito ABIERTO aún trabajables. El
  // filtro de toques NO va en SQL porque un carrito nuevo (gid distinto)
  // reinicia el contador — lo decide la regla pura. El volumen está acotado
  // por la ventana de ingesta de drafts (2 días), así que es barato.
  const { data, error } = await admin
    .from("leads")
    .select(
      "id, phone, name, category, has_order, draft_order_gid, draft_order_status, last_inbound_at, cart_seq_touches, last_cart_seq_at, cart_seq_gid, cart_summary, wa_phone_number_id",
    )
    .eq("store_id", storeId)
    .eq("has_order", false)
    .in("category", ["open", "hot"])
    .not("draft_order_gid", "is", null)
    .in("draft_order_status", ["open", "invoice_sent"])
    .order("last_interaction_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`cart_seq select: ${error.message}`);
  const rows = (data as CartSeqLead[] | null) ?? [];
  if (!rows.length) return report;

  // Fecha de creación (Shopify) de cada carrito — el ancla del reloj.
  const gids = Array.from(new Set(rows.map((l) => l.draft_order_gid).filter(Boolean))) as string[];
  const createdByGid = new Map<string, string | null>();
  for (let i = 0; i < gids.length; i += 200) {
    const { data: drafts } = await admin
      .from("draft_orders")
      .select("draft_order_gid, created_at")
      .eq("store_id", storeId)
      .in("draft_order_gid", gids.slice(i, i + 200));
    for (const d of (drafts as { draft_order_gid: string | null; created_at: string | null }[]) ?? []) {
      if (d.draft_order_gid) createdByGid.set(d.draft_order_gid, d.created_at);
    }
  }

  const eligible = rows.filter(
    (l) => cartSeqSkipReason(l, createdByGid.get(l.draft_order_gid!) ?? null, nowMs, cfg) === null,
  );
  // La plantilla del toque debe estar configurada; sin número desde dónde
  // enviar tampoco hay envío. Fuera del lote SIN consumir toque.
  const sendable = eligible.filter((l) => {
    const touch = cartSeqTouchesFor(l) + 1;
    const template = touch === 1 ? creds.cart_seq_template_1_name : creds.cart_seq_template_2_name;
    return !!template && !!(l.wa_phone_number_id || creds.whatsapp_phone_number_id);
  });
  report.skipped = rows.length - sendable.length;
  const batch = sendable.slice(0, CART_SEQ_BATCH_CAP);

  for (const l of batch) {
    const touch = cartSeqTouchesFor(l) + 1;
    const templateName =
      touch === 1 ? creds.cart_seq_template_1_name! : creds.cart_seq_template_2_name!;
    const language =
      (touch === 1 ? creds.cart_seq_template_1_language : creds.cart_seq_template_2_language) ??
      "es";
    const pnId = (l.wa_phone_number_id ?? creds.whatsapp_phone_number_id)!;
    const cartLabel = (l.cart_summary ?? "").trim() || "tu pedido pendiente";

    let ok = false;
    let err: string | null = null;
    let errCode: number | undefined;
    try {
      const send = await sendTemplate(
        { apiKey: creds.kapso_api_key },
        {
          phoneNumberId: pnId,
          to: l.phone,
          templateName,
          language,
          bodyParams: [l.name!, cartLabel],
        },
      );
      ok = send.ok;
      if (!send.ok) {
        err = send.error ?? "envío rechazado";
        errCode = send.code;
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    // Tope de mensajería de Meta: audita el intento pero NO consume el toque
    // (el límite es de la tienda, no del lead) y corta el resto del lote.
    if (!ok && isTierLimitError(errCode, err)) {
      await admin.from("cart_seq_sends").insert({
        store_id: storeId,
        lead_id: l.id,
        phone: l.phone,
        draft_order_gid: l.draft_order_gid,
        template_name: templateName,
        touch,
        ok: false,
        error: err,
      });
      report.failed += 1;
      break;
    }

    await admin
      .from("leads")
      .update({
        cart_seq_touches: touch,
        last_cart_seq_at: nowIso,
        cart_seq_gid: l.draft_order_gid,
      })
      .eq("id", l.id);
    await admin.from("cart_seq_sends").insert({
      store_id: storeId,
      lead_id: l.id,
      phone: l.phone,
      draft_order_gid: l.draft_order_gid,
      template_name: templateName,
      touch,
      ok,
      error: err,
    });
    await admin.from("lead_calls").insert({
      lead_id: l.id,
      store_id: storeId,
      kind: "system",
      vendedora: null,
      note: ok
        ? `📤 Carrito: plantilla «${templateName}» enviada (toque ${touch}/${CART_SEQ_MAX_TOUCHES})`
        : `⚠️ Carrito: falló envío de «${templateName}» (${err})`,
    });
    if (ok) report.sent += 1;
    else report.failed += 1;
  }
  return report;
}
