// Aplicación de un estado de Aliclik a nuestra guía. Única vía de escritura,
// compartida por el webhook y por el cron de reconciliación.
//
// POR QUÉ UNA SOLA VÍA. Son dos disparadores (una notificación que llega y un
// barrido periódico) pero un solo efecto. Si cada uno escribiera a su manera,
// tarde o temprano diferirían — y la diferencia solo se vería en producción, en
// un pedido concreto, a las once de la noche.
//
// EL PAYLOAD DEL WEBHOOK NO SE ESCRIBE. Aliclik avisa de que "los estados pueden
// llegar en desorden" y su notificación no trae timestamp, así que no hay forma
// de saber si lo que llega es más nuevo que lo que tenemos. La notificación es
// solo un disparador: lo que se escribe es la respuesta de
// `GET /integration/order`, que sí trae `updatedAt` y sirve de guarda monotónica.
// Efecto lateral bienvenido: como el webhook no viene firmado, una notificación
// falsificada, como mucho, nos hace releer la verdad desde Aliclik.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getOrder, type AliclikClientOpts, type AliclikOrder } from "@/lib/aliclik";
import { mapAliclikStatus, aliclikStatusLabel } from "@/lib/aliclik-status";
import { categoryOf, reconcileDeliveryStatus } from "@/lib/shipments";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

/**
 * Huella del estado, para la idempotencia que pide la documentación. El mismo
 * trío reenviado produce la misma huella y choca contra el único de
 * `aliclik_webhook_events`, así que no se vuelve a consultar la API.
 */
export function statusFingerprint(p: {
  orderNumber: string;
  status?: string | null;
  callStatus?: string | null;
  dispatchStatus?: string | null;
}): string {
  const raw = [p.orderNumber, p.status ?? "", p.callStatus ?? "", p.dispatchStatus ?? ""]
    .map((v) => String(v).trim().toUpperCase())
    .join("|");
  return createHash("sha256").update(raw).digest("hex");
}

export interface ApplySnapshotResult {
  ok: boolean;
  outcome: "applied" | "unchanged" | "unknown_order" | "error";
  shipmentId?: string;
  orderId?: string | null;
  from?: string;
  to?: string;
  error?: string;
}

/** La fila de `shipments` que necesita el aplicador. */
interface TrackedShipment {
  id: string;
  store_id: string;
  order_id: string | null;
  delivery_status: string;
  last_report_at: string | null;
  external_order_number: string | null;
}

/**
 * Escribe en nuestra guía el estado que Aliclik reporta para `orderNumber`.
 *
 * Tres guardas, en este orden:
 *   1. Si no conocemos el orderNumber, no se inventa una guía: se informa
 *      `unknown_order`. Crear filas a partir de un webhook sin firma sería
 *      dejar que cualquiera nos llene la base.
 *   2. `updatedAt` de Aliclik contra `last_report_at`: un snapshot más viejo que
 *      el último que aplicamos se descarta. Es la protección real contra el
 *      desorden que la propia documentación anuncia.
 *   3. `reconcileDeliveryStatus` (lib/shipments.ts): un estado solo avanza. Un
 *      `entregado` no se reabre y el trabajo del equipo no se pisa.
 */
export async function applyAliclikSnapshot(
  order: AliclikOrder,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<ApplySnapshotResult> {
  const orderNumber = (order.orderNumber ?? "").trim();
  if (!orderNumber) return { ok: false, outcome: "error", error: "Snapshot sin orderNumber." };

  const { data, error } = await admin
    .from("shipments")
    .select("id,store_id,order_id,delivery_status,last_report_at,external_order_number")
    .eq("external_order_number", orderNumber)
    .limit(1)
    .maybeSingle();

  if (error) return { ok: false, outcome: "error", error: error.message };
  const shipment = data as TrackedShipment | null;
  if (!shipment) return { ok: false, outcome: "unknown_order" };

  // Guarda monotónica. Sin `updatedAt` se aplica igual: no tener el dato no debe
  // congelar la guía, y la precedencia de estados sigue protegiendo el resultado.
  const updatedAt = order.updatedAt ? new Date(order.updatedAt).toISOString() : null;
  if (updatedAt && shipment.last_report_at && updatedAt < shipment.last_report_at) {
    return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };
  }

  const isAgency = Boolean(order.shipping?.reference?.toLowerCase().includes("agencia"));
  const mapped = mapAliclikStatus({
    callStatus: order.callStatus,
    status: order.status,
    dispatchStatus: order.dispatchStatus,
    isAgency,
  });

  // Un estado que no supimos traducir NO toca la guía. Se registra el valor en
  // `reported_status` para poder verlo y ampliar el mapeo, pero el estado
  // operativo se queda como está.
  if (!mapped.deliveryStatus) {
    await admin
      .from("shipments")
      .update({
        reported_status: aliclikStatusLabel(order),
        last_report_at: updatedAt ?? new Date().toISOString(),
        ...collectAmountPatch(order),
      })
      .eq("id", shipment.id);
    return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };
  }

  const next = reconcileDeliveryStatus(shipment.delivery_status, mapped.deliveryStatus);
  const nowIso = new Date().toISOString();

  const patch: Record<string, unknown> = {
    delivery_status: next,
    status_category: categoryOf(next),
    reported_status: aliclikStatusLabel(order),
    last_report_at: updatedAt ?? nowIso,
    ...collectAmountPatch(order),
  };
  if (mapped.pickupState) patch.pickup_state = mapped.pickupState;
  if (mapped.returned) patch.returned_at = updatedAt ?? nowIso;
  if (next === "entregado") {
    patch.closed_at = updatedAt ?? nowIso;
    patch.delivered_source = "aliclik_api";
  }
  if (next === "en_ruta" && shipment.delivery_status === "pendiente") {
    patch.dispatched_at = updatedAt ?? nowIso;
  }

  const { error: upErr } = await admin.from("shipments").update(patch).eq("id", shipment.id);
  if (upErr) return { ok: false, outcome: "error", error: upErr.message };

  // El Master se recalcula desde las guías; sin esto el cambio no se vería en
  // /dashboard/pedidos. `Safe` no lanza: un fallo de recálculo no debe deshacer
  // un estado ya escrito.
  if (shipment.order_id) {
    await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  }

  return {
    ok: true,
    outcome: "applied",
    shipmentId: shipment.id,
    orderId: shipment.order_id,
    from: shipment.delivery_status,
    to: next,
  };
}

/**
 * Relee un pedido de Aliclik y aplica lo que diga. Es lo que hacen tanto el
 * webhook (tras registrar el aviso) como el cron.
 */
/**
 * Lo que Aliclik declara que cobrará en la puerta.
 *
 * Se guarda en CADA pasada, gane o no el mapeo de estados, porque el importe
 * puede cambiar sin que cambie el estado — es justo lo que pasa cuando alguien
 * lo corrige a mano en el panel de Aliclik. Si no viene el dato, no se toca la
 * columna: un `null` accidental borraría la última lectura buena.
 */
function collectAmountPatch(order: AliclikOrder): Record<string, unknown> {
  const total = order.total;
  if (total == null || !Number.isFinite(total) || total <= 0) return {};
  return { reported_collect_amount: total };
}

export async function refreshAliclikOrder(
  orderNumber: string,
  opts: AliclikClientOpts,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<ApplySnapshotResult> {
  const res = await getOrder(opts, orderNumber);
  if (!res.ok) return { ok: false, outcome: "error", error: res.error };
  if (!res.data) return { ok: false, outcome: "unknown_order", error: "Aliclik no devolvió el pedido." };
  return applyAliclikSnapshot(res.data, admin);
}
