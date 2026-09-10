// Aviso de comprobante reusado en cobros Tanders.
//
// POR QUÉ SOLO ESTE MOTIVO AVISA. Los otros rechazos son un cobro mal hecho:
// el monto no cuadra, el medio no es de los acordados, el nombre no es el
// nuestro. Se corrigen y no corren prisa. Un nº de operación que ya apareció
// en otra guía es distinto — es el MISMO dinero acreditando dos pedidos, o sea
// un pedido cobrado con el comprobante de otro. Eso hay que mirarlo hoy, y
// nadie mira el JSON que devuelve el cron.
//
// Va al mismo canal de Telegram de la tienda que el resumen diario y los Yapes
// sin atender. Best-effort: si la tienda no tiene Telegram, no pasa nada — el
// veredicto YA bloqueó el cobro, que es la protección de verdad. El aviso solo
// acorta el tiempo hasta que un humano lo ve.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds } from "@/lib/ingest";
import { sendTelegramToAll } from "@/lib/telegram";
import type { SweepDuplicate } from "@/lib/tanders/payment-sweep";

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** El mensaje de una tienda. Público para poder probar el texto sin red. */
export function formatDuplicateAlert(storeName: string, dups: SweepDuplicate[]): string {
  const lines = [
    `🚨 <b>${esc(storeName)}</b> — ${dups.length} comprobante${dups.length === 1 ? "" : "s"} de pago repetido${dups.length === 1 ? "" : "s"}`,
    "",
  ];
  for (const d of dups) {
    const monto = d.monto != null ? ` · S/ ${d.monto.toFixed(2)}` : "";
    lines.push(`• <b>${esc(d.pedido ?? d.guia)}</b>${monto}`);
    lines.push(`  operación <code>${esc(d.operacion)}</code>`);
    lines.push(`  ya estaba en: ${esc(d.otras.join(", "))}`);
  }
  lines.push("");
  lines.push(
    "El mismo pago no puede cobrar dos pedidos. Estas guías NO se dieron por cobradas: revísalas en Cobros Tanders.",
  );
  return lines.join("\n");
}

/**
 * Avisa por tienda. Nunca lanza: un fallo del aviso no puede tumbar el barrido
 * —el cobro ya quedó bloqueado— y perder el resto de la pasada por un timeout
 * de Telegram sería mucho peor que perder el mensaje.
 */
export async function alertDuplicatePayments(
  admin: SupabaseClient,
  duplicados: SweepDuplicate[],
): Promise<{ avisadas: number }> {
  if (!duplicados.length) return { avisadas: 0 };

  const porTienda = new Map<string, SweepDuplicate[]>();
  for (const d of duplicados) {
    const lista = porTienda.get(d.storeId);
    if (lista) lista.push(d);
    else porTienda.set(d.storeId, [d]);
  }

  let avisadas = 0;
  for (const [storeId, dups] of porTienda) {
    try {
      const creds = await getStoreCreds(storeId, admin);
      if (!creds?.telegram_bot_token || !creds.telegram_chat_id) continue;
      const res = await sendTelegramToAll(
        creds.telegram_bot_token,
        creds.telegram_chat_id,
        formatDuplicateAlert(creds.name, dups),
      );
      if (res.sent) avisadas += dups.length;
    } catch {
      /* el bloqueo del cobro ya está puesto; el aviso es lo accesorio */
    }
  }
  return { avisadas };
}
