// Aviso de comprobante reusado en cobros Tanders.
//
// POR QUÉ SOLO ESTE MOTIVO AVISA. Los otros rechazos son un cobro mal hecho:
// el monto no cuadra, el medio no es de los acordados, el nombre no es el
// nuestro. Se corrigen y no corren prisa. Un nº de operación que ya apareció
// en otra guía es distinto — es el MISMO dinero acreditando dos pedidos, o sea
// un pedido cobrado con el comprobante de otro. Eso hay que mirarlo hoy, y
// nadie mira el JSON que devuelve el cron.
//
// Desde la 0226 sale por la puerta única de «comprobante repetido»
// (lib/repeated-voucher-alert.ts): la alerta en Kapta para quien tenga el
// permiso y el Telegram de alertas urgentes de la tienda. Best-effort: el
// veredicto YA bloqueó el cobro, que es la protección de verdad.

import type { SupabaseClient } from "@supabase/supabase-js";
import { raiseRepeatedVoucherAlert } from "@/lib/repeated-voucher-alert";
import type { SweepDuplicate } from "@/lib/tanders/payment-sweep";

/** Nunca lanza: un fallo del aviso no puede tumbar el barrido. */
export async function alertDuplicatePayments(
  admin: SupabaseClient,
  duplicados: SweepDuplicate[],
): Promise<{ avisadas: number }> {
  let avisadas = 0;
  for (const d of duplicados) {
    try {
      const res = await raiseRepeatedVoucherAlert(admin, {
        storeId: d.storeId,
        orderName: d.pedido ?? d.guia,
        alsoIn: d.otras,
        operation: d.operacion === "?" ? null : d.operacion,
        amount: d.monto,
        source: "barrido_tanders",
        actions: [
          "El cobro quedó bloqueado.",
          // Lo más urgente: esas ya se habían contado como plata entrada, y
          // han dejado de estarlo.
          ...d.desandadas.map((p) => `${p} estaba dado por COBRADO y ya no lo está.`),
        ],
      });
      if (res.alertId) avisadas += 1;
    } catch {
      /* el bloqueo del cobro ya está puesto; el aviso es lo accesorio */
    }
  }
  return { avisadas };
}
