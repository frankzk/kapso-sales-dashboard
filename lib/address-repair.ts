// Recuperación en vivo de direcciones que faltan en la copia local del pedido.
//
// Durante meses la app sincronizó pedidos sin dirección: hasta que se habilitó
// el acceso a datos protegidos del cliente, Shopify devolvía el bloque de envío
// con SOLO el teléfono. El destino existe en Shopify, pero no en lo guardado.
// Este módulo es el único lugar que sabe reconsultarlo y reparar el pedido; lo
// usan el panel del envío (al abrirlo), el Excel de programación (al generarlo)
// y la reparación masiva de la cola.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { getStoreCreds } from "@/lib/ingest";
import { fetchOrderById } from "@/lib/shopify";
import { hasDeliverableAddress, shopifyShippingAddress } from "@/lib/shopify-address";

/** Cuántos pedidos se reconsultan en paralelo. Shopify tolera bien este ritmo y
 *  mantiene cada tanda dentro del maxDuration de la ruta. */
export const ADDRESS_REPAIR_CONCURRENCY = 8;

export type AddressRepairTarget = {
  orderId: string;
  storeId: string;
  shopifyOrderId: string;
};

export type AddressRepairOutcome = {
  /** Shopify devolvió calle y el pedido guardado quedó reparado. */
  repaired: number;
  /** Shopify tampoco tiene calle: no hay nada que recuperar para ese pedido. */
  stillMissing: number;
  /** Tienda sin token o API que no respondió. Se puede reintentar. */
  failed: number;
  /** Payload reparado por pedido, para que quien llame lo use sin releer. */
  rawByOrderId: Map<string, unknown>;
};

/** Las ventas manuales ("manual-…", "draft-…") no existen en Shopify: no tiene
 *  sentido reconsultarlas. Solo los ids numéricos son pedidos reales. */
export function isShopifyOrderId(id: string | null | undefined): id is string {
  return !!id && /^\d+$/.test(id);
}

/**
 * Reconsulta cada pedido a Shopify y persiste el payload cuando trae calle.
 *
 * Best-effort por diseño: si una tienda no responde, ese pedido queda como
 * estaba y el resto continúa — quien llama nunca falla entero por un pedido.
 * Solo se pisa lo guardado cuando lo vivo tiene dirección despachable, así una
 * respuesta pobre de Shopify no borra lo que ya había.
 */
export async function repairOrderAddresses(
  targets: AddressRepairTarget[],
  admin: SupabaseClient,
): Promise<AddressRepairOutcome> {
  const outcome: AddressRepairOutcome = {
    repaired: 0,
    stillMissing: 0,
    failed: 0,
    rawByOrderId: new Map(),
  };
  if (!targets.length) return outcome;

  // Las credenciales se resuelven una vez por tienda, no una vez por pedido.
  const credsByStore = new Map<string, Awaited<ReturnType<typeof getStoreCreds>>>();
  for (const storeId of new Set(targets.map((item) => item.storeId))) {
    try {
      credsByStore.set(storeId, await getStoreCreds(storeId, admin));
    } catch {
      credsByStore.set(storeId, null);
    }
  }

  for (const batch of chunk(targets, ADDRESS_REPAIR_CONCURRENCY)) {
    await Promise.all(
      batch.map(async ({ orderId, storeId, shopifyOrderId }) => {
        const creds = credsByStore.get(storeId);
        if (!creds?.shopify_token) {
          outcome.failed += 1;
          return;
        }
        try {
          const live = await fetchOrderById({
            domain: creds.shopify_domain,
            token: creds.shopify_token,
            storeId,
            orderGid: `gid://shopify/Order/${shopifyOrderId}`,
          });
          if (!live || !hasDeliverableAddress(shopifyShippingAddress(live.raw))) {
            outcome.stillMissing += 1;
            return;
          }
          // Persistir: el panel, el tablero y los próximos exports ya no
          // necesitan volver a consultarlo.
          const { error } = await admin
            .from("orders")
            .update({ raw: live.raw })
            .eq("id", orderId);
          if (error) {
            outcome.failed += 1;
            return;
          }
          outcome.rawByOrderId.set(orderId, live.raw);
          outcome.repaired += 1;
        } catch {
          outcome.failed += 1;
        }
      }),
    );
  }
  return outcome;
}
