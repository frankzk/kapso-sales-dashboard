// Lo que Envíos le pide a Shopify, con la fila de Kapta como respaldo
// (23-10-2026, salida de Kenku y Aurela de Shopify el 28-10-2026).
//
// Vincular una guía con un pedido encontrado en Shopify, armar una guía directa
// desde un pedido de Shopify y corregir la dirección de un envío llamaban a
// Shopify y, si la tienda no tenía token, contestaban «La tienda no tiene
// Shopify conectado» aunque el pedido ya estuviera en Kapta. Kapta guarda cada
// pedido de la tienda (`orders`, pasada `shopify_all`), así que eso no hace
// falta: aquí, si Shopify no está o no contesta, se usa la fila de Kapta.
//
// CON SHOPIFY FUNCIONANDO NADA CAMBIA: se lee (o se escribe) en Shopify como
// siempre y la fila se actualiza con lo que dijo. El respaldo solo entra cuando
// la llamada no se puede hacer o falla.

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds, type StoreCreds } from "@/lib/ingest";
import {
  fetchOrderById,
  isShopifyShopGone,
  shopifyHttpStatusOf,
  updateOrderShippingAddress,
  type OrderAddressInput,
} from "@/lib/shopify";
import type { OrderPlatform } from "@/lib/types";

/** Lo que estas funciones usan de afuera. Las pruebas lo reemplazan. */
export interface ShipmentShopifyDeps {
  getCreds: (storeId: string) => Promise<Pick<StoreCreds, "shopify_domain" | "shopify_token"> | null>;
  fetchOrder: typeof fetchOrderById;
  updateAddress: typeof updateOrderShippingAddress;
}

const defaultDeps: ShipmentShopifyDeps = {
  getCreds: (storeId) => getStoreCreds(storeId),
  fetchOrder: fetchOrderById,
  updateAddress: updateOrderShippingAddress,
};

/** Un gid de pedido de Shopify (o su número) → el número, o null si no lo es. */
function shopifyOrderNumber(gidOrId: string): string | null {
  const m = /^(?:gid:\/\/shopify\/Order\/)?(\d+)$/.exec(gidOrId.trim());
  return m ? m[1]! : null;
}

// ── Capturar el pedido para vincularlo ───────────────────────────────────────

export type OrderCapture =
  /** `from`: de dónde salió el pedido. `kapta` es la fila que ya estaba guardada. */
  | { ok: true; orderId: string; from: "shopify" | "kapta" }
  /** La tienda no tiene token y el pedido no está en Kapta. */
  | { ok: false; why: "sin_shopify" }
  /** Shopify falló y el pedido no está en Kapta. */
  | { ok: false; why: "shopify_fallo" }
  /** Shopify no lo devolvió y no está en Kapta. */
  | { ok: false; why: "no_encontrado" }
  /** No se pudo guardar lo que dijo Shopify. */
  | { ok: false; why: "base"; error: PostgrestError }
  /** Se guardó, pero no se pudo leer su id. */
  | { ok: false; why: "sin_fila" };

/** El id del pedido en Kapta por su número de Shopify, o null. */
async function localOrderId(admin: SupabaseClient, storeId: string, gidOrId: string): Promise<string | null> {
  const number = shopifyOrderNumber(gidOrId);
  if (!number) return null;
  const { data, error } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", storeId)
    .eq("shopify_order_id", number)
    .maybeSingle();
  if (error) return null;
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

/**
 * El pedido de Shopify `orderGid` de la tienda, guardado en Kapta y listo para
 * vincular. Con Shopify, como siempre: se lee, se guarda (upsert) y se devuelve
 * su id. Si la tienda no tiene token, Shopify falla o no lo devuelve, y el
 * pedido ya está en Kapta, se devuelve esa fila tal cual (`from: "kapta"`).
 * Quien llama ya comprobó que el usuario ve la tienda.
 */
export async function captureShopifyOrderForLink(
  admin: SupabaseClient,
  input: { storeId: string; orderGid: string },
  deps: ShipmentShopifyDeps = defaultDeps,
): Promise<OrderCapture> {
  const local = async (): Promise<OrderCapture | null> => {
    const id = await localOrderId(admin, input.storeId, input.orderGid);
    return id ? { ok: true, orderId: id, from: "kapta" } : null;
  };

  const creds = await deps.getCreds(input.storeId);
  if (!creds?.shopify_token) return (await local()) ?? { ok: false, why: "sin_shopify" };

  let order;
  try {
    order = await deps.fetchOrder({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      storeId: input.storeId,
      orderGid: input.orderGid,
    });
  } catch {
    return (await local()) ?? { ok: false, why: "shopify_fallo" };
  }
  if (!order) return (await local()) ?? { ok: false, why: "no_encontrado" };

  const { error: upsertErr } = await admin.from("orders").upsert([order], { onConflict: "store_id,shopify_order_id" });
  if (upsertErr) return { ok: false, why: "base", error: upsertErr };
  const { data: row } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", input.storeId)
    .eq("shopify_order_id", order.shopify_order_id)
    .maybeSingle();
  const orderId = (row as { id: string } | null)?.id ?? null;
  if (!orderId) return { ok: false, why: "sin_fila" };
  return { ok: true, orderId, from: "shopify" };
}

// ── La plataforma del pedido ─────────────────────────────────────────────────

/**
 * De qué plataforma es un pedido de Kapta (`orders.platform`, 0274, MOM §38.1).
 * Lo que depende de la plataforma se decide con esto, nunca por la forma del
 * id: `wc-kp-1532` también tiene un número. Antes de la 0274 todos los pedidos
 * son de Shopify, y si la columna no se puede leer se responde `shopify`: es lo
 * que se hacía siempre.
 */
export async function orderPlatformOf(admin: SupabaseClient, orderId: string): Promise<OrderPlatform> {
  const { data, error } = await admin.from("orders").select("platform").eq("id", orderId).maybeSingle();
  if (error) return "shopify";
  return (data as { platform?: unknown } | null)?.platform === "woocommerce" ? "woocommerce" : "shopify";
}

// ── Escribir la dirección en Shopify ─────────────────────────────────────────

export type ShopifyAddressPush =
  /** Shopify la guardó. */
  | { ok: true; wrote: true }
  /**
   * No se escribió en Shopify y se sigue con el envío: la tienda no tiene token
   * (`sin_shopify`), Shopify contestó por ella que ya no está (`tienda_caida`,
   * con su HTTP) o el pedido es de WooCommerce (`woocommerce`, MOM §38.12), que
   * nunca se manda a Shopify.
   */
  | { ok: true; wrote: false; why: "sin_shopify" }
  | { ok: true; wrote: false; why: "tienda_caida"; status: number }
  | { ok: true; wrote: false; why: "woocommerce" }
  /** Shopify rechazó el cambio: no se guarda nada, como siempre. */
  | { ok: false; error: string };

/**
 * Escribe la dirección del pedido en Shopify antes de guardarla en el envío.
 * Con Shopify funcionando, igual que siempre: si Shopify la rechaza, el error
 * corta el cambio. Si la tienda ya no tiene token, o Shopify contesta que la
 * tienda ya no está (401, 402, 403, 404, 423), el cambio sigue solo en Kapta.
 * Un pedido de WooCommerce (`platform`, de `orderPlatformOf`) no se manda a
 * Shopify: su id no es de Shopify aunque tenga un número.
 */
export async function pushShippingAddressToShopify(
  input: { storeId: string; shopifyOrderId: string; address: OrderAddressInput; platform?: OrderPlatform },
  deps: ShipmentShopifyDeps = defaultDeps,
): Promise<ShopifyAddressPush> {
  if (input.platform === "woocommerce") return { ok: true, wrote: false, why: "woocommerce" };
  const creds = await deps.getCreds(input.storeId);
  if (!creds?.shopify_token) return { ok: true, wrote: false, why: "sin_shopify" };
  try {
    await deps.updateAddress({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      orderGid: `gid://shopify/Order/${input.shopifyOrderId}`,
      address: input.address,
    });
    return { ok: true, wrote: true };
  } catch (error) {
    if (isShopifyShopGone(error)) {
      return { ok: true, wrote: false, why: "tienda_caida", status: shopifyHttpStatusOf(error)! };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error:
        message.includes("Access denied") || message.includes("write_orders")
          ? "Shopify no autorizó el cambio. La tienda necesita el permiso write_orders."
          : `Shopify rechazó la dirección: ${message}`,
    };
  }
}
