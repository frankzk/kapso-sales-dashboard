// Escribir la confirmación expresa de agencia. La regla vive en
// `lib/confirmacion-agencia.ts`; esto solo la consulta contra la base y deja el
// hecho registrado.
//
// SE ESCRIBE UN EVENTO, no se deduce al vuelo. La confirmación se pregunta en
// dos sitios —`resolveMacroStage` para la macroetapa y `pendingOperational`
// para el estado operativo legado— y los dos leen `order_events`. Deducirlo en
// uno solo los haría divergir en silencio, que es el bug que
// `hasConfirmationSignal` documenta como ya ocurrido. Un evento los pone de
// acuerdo sin tocar ninguno de los dos.
//
// Y además queda la razón escrita. Un pedido que salta a Preparación sin que
// nadie lo marcara tiene que poder explicarse solo tres meses después.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hayConfirmacionExpresaDeAgencia,
  notaDeConfirmacionExpresa,
} from "@/lib/confirmacion-agencia";
import type { PaymentSnapshot } from "@/lib/pickup-key";

/**
 * Registra la confirmación si los hechos ya la sostienen. Idempotente: si el
 * pedido ya tiene una señal de confirmación —la palabra de la asesora, una guía
 * o un rótulo— no escribe nada.
 *
 * Devuelve si escribió, para que quien llama pueda decirlo en pantalla. Nunca
 * lanza: es un efecto secundario de guardar un pago o un borrador, y un fallo
 * suyo no puede tumbar la operación que sí pidió el usuario.
 */
export async function registrarConfirmacionExpresaDeAgencia(
  admin: SupabaseClient,
  orderId: string,
  storeId: string,
  actorId: string | null,
): Promise<boolean> {
  try {
    const [borradorRes, pagosRes, pedidoRes, yaRes] = await Promise.all([
      admin
        .from("shalom_order_drafts")
        .select("document,destiny_terminal_id,destiny_terminal_name")
        .eq("order_id", orderId)
        .maybeSingle(),
      admin
        .from("order_payments")
        .select("kind,validation_status,order_id,amount")
        .eq("order_id", orderId),
      // El total hace falta: el mínimo de adelanto se mide contra el pedido, y
      // un adelanto que ya lo cubre entero cuenta como pago completo.
      admin.from("orders").select("total_amount").eq("id", orderId).maybeSingle(),
      admin
        .from("order_events")
        .select("id")
        .eq("order_id", orderId)
        // Las mismas señales que `CONFIRMATION_SIGNAL_KINDS`: si cualquiera de
        // ellas ya existe, el pedido está confirmado y no hay nada que añadir.
        .in("kind", ["confirmed", "guide_registered", "label_generated"])
        .limit(1),
    ]);

    if (yaRes.data && yaRes.data.length > 0) return false;

    const borrador = (borradorRes.data ?? null) as {
      document: string | null;
      destiny_terminal_id: number | null;
      destiny_terminal_name: string | null;
    } | null;
    const pagos = ((pagosRes.data ?? []) as PaymentSnapshot[]) ?? [];
    const totalCrudo = (pedidoRes.data as { total_amount: number | string | null } | null)
      ?.total_amount;
    const total = totalCrudo == null ? null : Number(totalCrudo);

    if (!hayConfirmacionExpresaDeAgencia(borrador, pagos, Number.isFinite(total) ? total : null)) {
      return false;
    }

    const { error } = await admin.from("order_events").insert({
      store_id: storeId,
      order_id: orderId,
      kind: "confirmed",
      actor: actorId,
      // `automatico` y no `manual`: nadie pulsó «Confirmó el pedido». Lo dice la
      // evidencia, y la línea de tiempo no debe atribuirle a una persona una
      // declaración que no hizo.
      source: "automatico",
      new_status: "confirmado",
      note: notaDeConfirmacionExpresa(borrador?.destiny_terminal_name ?? null),
    });
    return !error;
  } catch {
    return false;
  }
}
