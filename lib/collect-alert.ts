// Aviso por Telegram cuando una guía va a cobrar lo que no toca.
//
// POR QUÉ EXISTE. La 0060 guarda desde hace meses `reported_collect_amount` —lo
// que el courier DECLARA que cobrará, refrescado cada 20 minutos— y
// `collectAmountMismatch` sabe decidir si eso está mal. Pero nadie las unía: la
// función solo la llamaba su propio test. El dato se recogía y no lo miraba
// nadie, así que el fallo que la motivó (una guía cobrando S/ 447 cuando la
// clienta debía S/ 298) se habría repetido igual de invisible.
//
// Esto las conecta y añade el caso nuevo: un pedido PAGADO EN EL CHECKOUT cuya
// guía sigue cobrando en la puerta. Ahí el detector es la única defensa, porque
// Aliclik calcula su importe desde los precios de línea y no pasa por
// `defaultCollectionAmount` — cambiar lo que se le manda sin conocer su contrato
// es justamente el error que documenta la 0060.
//
// POR TELEGRAM Y NO EN PANTALLA. Esto caduca: sirve mientras el paquete no se
// haya entregado. Un aviso que hay que ir a buscar llega tarde por definición, y
// ya existe el canal —el mismo del resumen de las 8 y de los Yape sin atender—.
// Hermano de lib/yape-alert-telegram.ts, con la misma forma: selección pura,
// envío best-effort, y marca solo si alguien lo recibió.

import type { SupabaseClient } from "@supabase/supabase-js";
import { collectAmountMismatch } from "@/lib/aliclik-money";
import { getStoreCreds } from "@/lib/ingest";
import { orderFullyPaid, type OrderPaymentFacts } from "@/lib/order-paid";
import { sendTelegramToAll } from "@/lib/telegram";

/** Re-aviso como mucho cada 3h mientras el descuadre siga vivo. */
export const COLLECT_REALERT_MIN = 180;

/**
 * Estados en los que ya no hay nada que evitar. Avisar de un pedido entregado no
 * es una alerta, es un reproche: el dinero ya se cobró y lo único que queda es
 * devolverlo, que no se hace desde el panel del courier.
 */
const TERMINAL = new Set(["entregado", "devuelto", "anulado", "transferido"]);

export interface CollectAlertRow {
  id: string;
  orderName: string | null;
  guideCode: string | null;
  courier: string | null;
  deliveryStatus: string;
  /** Lo que el courier dice que cobrará. */
  reported: number | null;
  /** El total del pedido, para el caso clásico de cobrar de más. */
  orderTotal: number | null;
  /** Cómo se pagó: decide si lo esperado es el total o cero. */
  facts: OrderPaymentFacts;
  alertSentAtMs: number | null;
}

export interface DueCollectAlert {
  row: CollectAlertRow;
  kind: "cobra_de_mas" | "cobra_de_menos";
  gap: number;
  message: string;
}

/**
 * Cuáles hay que avisar AHORA. Pura: la decisión no depende de la base ni del
 * reloj del sistema.
 */
export function selectCollectMismatches(
  rows: readonly CollectAlertRow[],
  nowMs: number,
  realertMin: number = COLLECT_REALERT_MIN,
): DueCollectAlert[] {
  const realertMs = realertMin * 60_000;
  const due: DueCollectAlert[] = [];
  for (const row of rows) {
    // Terminal: ya no se puede evitar nada.
    if (TERMINAL.has(row.deliveryStatus)) continue;
    // Avisado hace poco: el descuadre sigue, pero repetirlo cada 20 minutos
    // convierte el canal en ruido y deja de leerse justo cuando importa.
    if (row.alertSentAtMs != null && nowMs - row.alertSentAtMs < realertMs) continue;

    const mismatch = collectAmountMismatch(row.reported, row.orderTotal, undefined, row.facts);
    if (!mismatch) continue;
    due.push({ row, kind: mismatch.kind, gap: mismatch.gap, message: mismatch.message });
  }
  return due;
}

/**
 * Cuántas guías caben en un aviso.
 *
 * TELEGRAM RECHAZA LOS MENSAJES DE MÁS DE 4096 CARACTERES, y `lib/telegram.ts`
 * no trunca ni parte. Cada línea acá ronda los 150, así que a partir de unas
 * veintisiete el envío devuelve 400 — y entonces no se marca ninguna, el
 * siguiente ciclo reconstruye el MISMO mensaje gigante, y falla igual cada 20
 * minutos para siempre. El aviso se rompería justo cuando más hay que contar.
 *
 * Con tope, se nombran las primeras y solo ESAS se marcan: las demás salen en el
 * siguiente ciclo. El atraso se drena en tandas y ningún pedido se queda sin
 * nombrar, que es lo que haría marcarlas todas para callarlas.
 */
export const MAX_PER_ALERT = 20;

/** El mensaje. Cada línea nombra el pedido, porque hay que ir a buscarlo. */
export function formatCollectAlert(
  storeName: string | null,
  shown: readonly DueCollectAlert[],
  totalDue: number = shown.length,
): string {
  const head =
    totalDue === 1
      ? `⚠️ ${storeName ?? "Tienda"} · 1 guía va a cobrar lo que no toca`
      : `⚠️ ${storeName ?? "Tienda"} · ${totalDue} guías van a cobrar lo que no toca`;
  const lines = shown.map((d) => {
    const pedido = d.row.orderName ?? "(sin nº)";
    const guia = d.row.guideCode ? ` · guía ${d.row.guideCode}` : "";
    const courier = d.row.courier ? ` · ${d.row.courier}` : "";
    return `• ${pedido}${guia}${courier}\n  ${d.message}`;
  });
  const rest = totalDue - shown.length;
  // Decirlo importa: sin esta línea, un aviso de 20 sobre 60 se lee como si
  // fueran 20 y las otras 40 no existieran hasta dentro de 20 minutos.
  const tail = rest > 0 ? [``, `…y ${rest} más. Salen en el próximo aviso.`] : [];
  return [head, "", ...lines, ...tail].join("\n");
}

/** Columnas mínimas para decidir. `orders` aporta cómo se pagó. */
const SELECT =
  "id, order_name, guide_code, courier, delivery_status, reported_collect_amount, " +
  "collect_alert_sent_at, order:orders(total_amount, financial_status, total_refunded), " +
  "master:order_master(payment_state)";

/**
 * Barre las guías de una tienda, avisa de las que cobran mal y las marca.
 *
 * Best-effort en todo: sin Telegram configurado no hace nada, y si el envío no
 * llega a nadie NO se marca — así el próximo ciclo lo reintenta en vez de dar
 * por avisado algo que nadie leyó.
 */
export async function alertCollectMismatches(
  storeId: string,
  admin: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<{ alerted: number; skipped?: string }> {
  const creds = await getStoreCreds(storeId, admin);
  if (!creds?.telegram_bot_token || !creds.telegram_chat_id) {
    return { alerted: 0, skipped: "sin Telegram" };
  }

  const { data, error } = await admin
    .from("shipments")
    .select(SELECT)
    .eq("store_id", storeId)
    .not("reported_collect_amount", "is", null);
  if (error) return { alerted: 0, skipped: error.message };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rows: CollectAlertRow[] = ((data as any[]) ?? []).map((r) => {
    // PostgREST devuelve la relación como objeto o como lista de uno según la
    // forma de la clave ajena; se tolera lo que venga en vez de asumir una.
    const order = Array.isArray(r.order) ? r.order[0] : r.order;
    const master = Array.isArray(r.master) ? r.master[0] : r.master;
    return {
      id: r.id as string,
      orderName: (r.order_name as string | null) ?? null,
      guideCode: (r.guide_code as string | null) ?? null,
      courier: (r.courier as string | null) ?? null,
      deliveryStatus: (r.delivery_status as string) ?? "",
      reported: numOrNull(r.reported_collect_amount),
      orderTotal: numOrNull(order?.total_amount),
      facts: {
        financialStatus: (order?.financial_status as string | null) ?? null,
        totalRefunded: numOrNull(order?.total_refunded) ?? 0,
        paymentState: (master?.payment_state as string | null) ?? null,
      },
      alertSentAtMs: r.collect_alert_sent_at
        ? new Date(r.collect_alert_sent_at as string).getTime()
        : null,
    };
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const due = selectCollectMismatches(rows, nowMs);
  if (!due.length) return { alerted: 0 };

  // Tope por mensaje: ver MAX_PER_ALERT. Se marcan SOLO las nombradas, así que
  // el resto vuelve en el siguiente ciclo en vez de callarse sin haberse dicho.
  const shown = due.slice(0, MAX_PER_ALERT);

  const res = await sendTelegramToAll(
    creds.telegram_bot_token,
    creds.telegram_chat_id,
    formatCollectAlert(creds.name, shown, due.length),
  );
  if (!res.sent) return { alerted: 0, skipped: res.results[0]?.error ?? "sin destinatarios" };

  await admin
    .from("shipments")
    .update({ collect_alert_sent_at: new Date(nowMs).toISOString() })
    .in(
      "id",
      shown.map((d) => d.row.id),
    );
  return { alerted: shown.length };
}

/** Supabase devuelve los `numeric` como string. */
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
