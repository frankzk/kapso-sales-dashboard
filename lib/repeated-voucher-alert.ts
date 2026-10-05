// Alerta urgente: un mismo comprobante en más de un pedido (0226).
//
// LA REGLA (owner, 05-10-2026): un mismo comprobante no puede estar en más de un
// pedido, y cuando pase lo tienen que ver Frank, Yohalis, Akemi y Daysi.
//
// EL CASO. Un solo Lemon de S/ 89 era el comprobante de cuatro pedidos Tanders
// (#KP124940, #KP126075, #KP126468, #KP126871): el mismo archivo subido cuatro
// veces. El lector no pudo leer el nº de operación —sale cortado— y la huella
// del archivo, que sí lo habría cazado, bloqueaba el cobro EN SILENCIO. Detectar
// sin avisar es casi lo mismo que no detectar: el bloqueo protege la plata de
// HOY, pero el pedido cobrado con el papel de otro sigue ahí sin que nadie lo
// mire.
//
// UNA SOLA PUERTA. Todo camino que encuentra un comprobante repetido —el barrido
// de Tanders, el alta del cobro del courier, la subida manual, el que llega por
// WhatsApp— llama a `raiseRepeatedVoucherAlert`. Así el aviso dice lo mismo
// venga de donde venga, y ninguno se queda callado por olvido.
//
// DOS VÍAS, A PROPÓSITO:
//   1. En Kapta, la alerta flotante con sonido para quien tenga el permiso
//      `alerts.repeated_voucher` (se concede persona por persona en Equipo). Sin
//      escalera: es urgente y la ven todos a la vez. Queda abierta hasta que
//      alguien diga qué hizo.
//   2. Por Telegram al grupo de alertas urgentes de la tienda, porque quien no
//      está conectado a Kapta también tiene que enterarse. Si la tienda no lo
//      configuró, va al canal de siempre: avisar a otros es mejor que callar.
//
// UNA VEZ POR COMPROBANTE. La huella (`dedupe_key`) es el archivo si se conoce,
// si no el nº de operación: el barrido relee cada hora, y una alerta que se
// repite sola deja de leerse justo el día que llega una nueva.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds } from "@/lib/ingest";
import { sendTelegramToAll } from "@/lib/telegram";

export type RepeatedVoucherSource = "barrido_tanders" | "cobro_courier" | "subida_manual" | "whatsapp";

export interface RepeatedVoucher {
  storeId: string;
  /** El pedido donde se intentó usar ahora. */
  orderId?: string | null;
  orderName?: string | null;
  /** Donde YA estaba: pedido o guía, por su nombre. */
  alsoIn: string[];
  operation?: string | null;
  /** sha256 del archivo, si se conoce. */
  fileSha256?: string | null;
  amount?: number | null;
  source: RepeatedVoucherSource;
  /** Lo que ya se hizo solo: «bloqueado», «#X dejó de estar cobrado»… */
  actions?: string[];
}

const SOURCE_LABEL: Record<RepeatedVoucherSource, string> = {
  barrido_tanders: "constancia de Tanders",
  cobro_courier: "cobro de courier",
  subida_manual: "comprobante subido a mano",
  whatsapp: "comprobante llegado por WhatsApp",
};

/** La huella: una alerta abierta por comprobante y tienda. */
export function repeatedVoucherKey(v: Pick<RepeatedVoucher, "fileSha256" | "operation" | "orderId" | "alsoIn">): string {
  if (v.fileSha256) return `sha:${v.fileSha256}`;
  if (v.operation) return `op:${v.operation}`;
  return `pedidos:${[v.orderId ?? "", ...v.alsoIn].sort().join("|")}`;
}

/** Los pedidos implicados, sin repetir, el actual primero. */
export function involvedOrders(v: Pick<RepeatedVoucher, "orderName" | "alsoIn">): string[] {
  return [...new Set([v.orderName, ...v.alsoIn].filter((x): x is string => Boolean(x)))];
}

/** El renglón de la alerta en Kapta. Puro. */
export function repeatedVoucherDetail(v: RepeatedVoucher): string {
  const pedidos = involvedOrders(v);
  const partes = [
    `El mismo ${SOURCE_LABEL[v.source]} aparece en ${pedidos.length} pedidos: ${pedidos.join(", ")}.`,
    v.operation ? `Operación ${v.operation}.` : v.fileSha256 ? "Es el mismo archivo de imagen." : "",
    ...(v.actions ?? []),
    "Al menos uno no está pagado: revisa cuál es cuál.",
  ];
  return partes.filter(Boolean).join(" ");
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** El mensaje de Telegram. Puro. */
export function repeatedVoucherTelegram(storeName: string, v: RepeatedVoucher): string {
  const pedidos = involvedOrders(v);
  const lines = [
    `🚨 <b>COMPROBANTE REPETIDO</b> — ${esc(storeName)}`,
    "",
    `El mismo ${SOURCE_LABEL[v.source]} está en <b>${pedidos.length} pedidos</b>:`,
    ...pedidos.map((p) => `• <b>${esc(p)}</b>`),
  ];
  if (v.amount != null) lines.push(`Monto: S/ ${v.amount.toFixed(2)}`);
  if (v.operation) lines.push(`Operación: <code>${esc(v.operation)}</code>`);
  else if (v.fileSha256) lines.push("Es el mismo archivo de imagen, byte a byte.");
  for (const a of v.actions ?? []) lines.push(`⚠️ ${esc(a)}`);
  lines.push("");
  lines.push(
    "Un mismo comprobante no puede pagar más de un pedido: al menos uno NO está pagado. " +
      "Ninguno se da por cobrado hasta que alguien revise cuál es cuál.",
  );
  return lines.join("\n");
}

/**
 * Levanta la alerta (una por comprobante abierta) y, si es nueva, avisa por
 * Telegram. Nunca lanza: el bloqueo del cobro ya está puesto y es lo que
 * protege; esto acorta el tiempo hasta que una persona lo ve.
 */
export async function raiseRepeatedVoucherAlert(
  admin: SupabaseClient,
  v: RepeatedVoucher,
): Promise<{ alertId: string | null; telegram: boolean }> {
  if (!involvedOrders(v).length || !v.alsoIn.length) return { alertId: null, telegram: false };
  let alertId: string | null = null;
  try {
    const { data, error } = await admin
      .from("collection_alerts")
      .insert({
        store_id: v.storeId,
        kind: "comprobante_repetido",
        order_id: v.orderId ?? null,
        amount: v.amount ?? null,
        detail: repeatedVoucherDetail(v),
        dedupe_key: repeatedVoucherKey(v),
        // Sin dueño ni escalera: la ven todos los que tienen el permiso.
        offered_to: null,
        offered_at: null,
      })
      .select("id")
      .single();
    // 23505 = ya hay una abierta por este comprobante: ni otra alerta ni otro Telegram.
    if (error) return { alertId: null, telegram: false };
    alertId = (data as { id: string } | null)?.id ?? null;
  } catch {
    return { alertId: null, telegram: false };
  }

  let telegram = false;
  try {
    const [creds, { data: store }] = await Promise.all([
      getStoreCreds(v.storeId, admin),
      admin.from("stores").select("urgent_telegram_chat_id").eq("id", v.storeId).maybeSingle(),
    ]);
    const destino =
      (store as { urgent_telegram_chat_id?: string | null } | null)?.urgent_telegram_chat_id?.trim() ||
      creds?.telegram_chat_id ||
      null;
    if (creds?.telegram_bot_token && destino) {
      const res = await sendTelegramToAll(creds.telegram_bot_token, destino, repeatedVoucherTelegram(creds.name, v));
      telegram = res.sent > 0;
    }
  } catch {
    /* la alerta en Kapta ya quedó; el Telegram es la segunda vía */
  }
  return { alertId, telegram };
}
