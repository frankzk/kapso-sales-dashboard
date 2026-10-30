"use server";
// «Último destino conocido de esta clienta» (MOM §37.8). Solo LEE: con la
// sesión de quien mira (RLS por tienda), para el pedido abierto en el cajón y
// nunca para una lista. No escribe en `orders`, en `order_master` ni en el
// historial de Shopify: la dirección entra al pedido solo cuando una persona la
// guarda por «Corregir ubicación» (`updateOrderGeo`, con su auditoría).
//
// Sin registros con datos de la clienta: si algo falla, no hay sugerencia.

import { createServerSupabase } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import {
  LAST_DESTINATION_SCAN,
  needsDestinationSuggestion,
  phoneLookupVariants,
  pickLastKnownDestinations,
  type KaptaDestinationRow,
  type LastKnownDestination,
  type ShopifyCustomerDestinationRow,
  type ShopifyHistoryDestinationRow,
} from "@/lib/last-known-destination";

const KAPTA_COLUMNS =
  "order_id,order_name,store_id,order_created_at,general_status,address,reference,district,province,region,latitude,longitude";
const HISTORY_COLUMNS =
  "order_name,store_id,created_at,cancelled_at,fulfilled_at,shipping_address1,shipping_address2,shipping_city,shipping_province";
const CUSTOMER_COLUMNS = "store_id,address1,address2,city,province";

export async function loadLastKnownDestinations(orderId: string): Promise<LastKnownDestination[]> {
  try {
    const sb = await createServerSupabase();
    const { data: own, error } = await sb
      .from("order_master")
      .select("order_id,order_name,store_id,customer_phone,coverage,region,district,address")
      .eq("order_id", orderId)
      .maybeSingle();
    if (error || !own) return [];
    const row = own as {
      order_id: string;
      order_name: string | null;
      store_id: string;
      customer_phone: string | null;
      coverage: string | null;
      region: string | null;
      district: string | null;
      address: string | null;
    };
    if (!needsDestinationSuggestion(row)) return [];
    const phones = phoneLookupVariants(row.customer_phone);
    const phoneNorm = normalizePhone(row.customer_phone);
    if (!phones.length) return [];

    // Las tiendas de la organización del pedido que quien mira puede ver
    // (Kenku y Aurela): la misma clienta compra en las dos.
    const storeNames: Record<string, string> = {};
    const { data: store } = await sb.from("stores").select("org_id,name").eq("id", row.store_id).maybeSingle();
    const orgId = (store as { org_id?: string | null } | null)?.org_id ?? null;
    if (orgId) {
      const { data: stores } = await sb.from("stores").select("id,name").eq("org_id", orgId);
      for (const s of (stores ?? []) as { id: string; name: string | null }[]) storeNames[s.id] = s.name ?? "";
    }
    if (!storeNames[row.store_id]) storeNames[row.store_id] = (store as { name?: string } | null)?.name ?? "";
    const storeIds = Object.keys(storeNames);

    // 1. Kapta, por el índice de teléfono de `order_master`.
    const kaptaRes = await sb
      .from("order_master")
      .select(KAPTA_COLUMNS)
      .in("customer_phone", phones)
      .in("store_id", storeIds)
      .neq("order_id", orderId)
      .order("order_created_at", { ascending: false })
      .limit(LAST_DESTINATION_SCAN);
    const kapta = kaptaRes.error ? [] : ((kaptaRes.data ?? []) as unknown as KaptaDestinationRow[]);
    const base = { kapta, storeNames, excludeOrderId: orderId, excludeOrderName: row.order_name };
    const fromKapta = pickLastKnownDestinations(base);
    if (fromKapta.length || !phoneNorm) return fromKapta;

    // 2. El historial de Shopify (MOM §37), por su índice (store_id, phone_norm).
    const historyRes = await sb
      .from("shopify_history_orders")
      .select(HISTORY_COLUMNS)
      .in("store_id", storeIds)
      .eq("phone_norm", phoneNorm)
      .order("created_at", { ascending: false })
      .limit(LAST_DESTINATION_SCAN);
    const shopifyOrders = historyRes.error
      ? []
      : ((historyRes.data ?? []) as unknown as ShopifyHistoryDestinationRow[]);
    const fromHistory = pickLastKnownDestinations({ ...base, shopifyOrders });
    if (fromHistory.length) return fromHistory;

    // 3. La ficha de clienta del historial (su dirección por defecto).
    const customersRes = await sb
      .from("shopify_history_customers")
      .select(CUSTOMER_COLUMNS)
      .in("store_id", storeIds)
      .eq("phone_norm", phoneNorm)
      .limit(10);
    const shopifyCustomers = customersRes.error
      ? []
      : ((customersRes.data ?? []) as unknown as ShopifyCustomerDestinationRow[]);
    return pickLastKnownDestinations({ ...base, shopifyOrders, shopifyCustomers });
  } catch {
    return [];
  }
}
