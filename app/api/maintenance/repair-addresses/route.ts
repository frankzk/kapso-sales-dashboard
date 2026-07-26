// Reparación masiva de direcciones para la cola de Envíos.
//
// El panel repara el pedido al abrirlo y el Excel al generarlo, pero eso deja
// sin dirección a todo lo que nadie toca. Esta ruta recorre las guías en
// Pendiente y En ruta y recupera de Shopify las que quedaron guardadas sin
// calle (el bloque de envío con solo el teléfono que devolvía Shopify antes de
// habilitar el acceso a datos protegidos del cliente).
//
// Va por tandas con cursor en vez de una pasada larga: así ninguna petición se
// acerca al maxDuration y el trabajo se puede retomar donde quedó. El cliente
// vuelve a llamar con el `cursor` devuelto hasta que `remaining` llega a 0.

import { NextResponse, type NextRequest } from "next/server";
import { getAccessibleStores, getCurrentUser, chunk } from "@/lib/access";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import {
  repairOrderAddresses,
  isShopifyOrderId,
  type AddressRepairTarget,
} from "@/lib/address-repair";
import { hasDeliverableAddress, shopifyShippingAddress } from "@/lib/shopify-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Las guías que aún se pueden despachar. Entregado/anulado/transferido ya no
// necesitan dirección, y reconsultarlas sería gastar cuota de Shopify.
const REPAIRABLE_CATEGORIES = ["pending", "in_route"];
const PAGE = 1_000;
// Pedidos por tanda. A 8 en paralelo son unos segundos por petición, muy lejos
// del maxDuration incluso si Shopify responde lento.
const ORDERS_PER_PASS = 150;

type RepairBody = { cursor?: unknown };

/** Ids de pedido (únicos, ordenados) de las guías despachables sin dirección
 *  propia. El orden estable es lo que permite retomar con cursor. */
async function candidateOrderIds(storeIds: string[]): Promise<Map<string, string>> {
  const sb = await createServerSupabase();
  const storeByOrder = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("shipments")
      .select("order_id,store_id,delivery_address")
      .in("store_id", storeIds)
      .in("status_category", REPAIRABLE_CATEGORIES)
      .not("order_id", "is", null)
      .order("order_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows =
      (data as { order_id: string; store_id: string; delivery_address: string | null }[]) ?? [];
    for (const row of rows) {
      // Una dirección propia (importada de Aliclik o corregida a mano) manda
      // sobre Shopify: esa guía no necesita reparación.
      if (row.delivery_address?.trim()) continue;
      if (!storeByOrder.has(row.order_id)) storeByOrder.set(row.order_id, row.store_id);
    }
    if (rows.length < PAGE) break;
  }
  return new Map([...storeByOrder].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

  const stores = await getAccessibleStores();
  const storeIds = stores.map((store) => store.id);
  if (!storeIds.length) {
    return NextResponse.json({ error: "Sin tiendas accesibles." }, { status: 403 });
  }

  let body: RepairBody = {};
  try {
    body = (await req.json()) as RepairBody;
  } catch {
    // Sin cuerpo: se empieza desde el principio.
  }
  const cursor = typeof body.cursor === "string" ? body.cursor : null;

  const storeByOrder = await candidateOrderIds(storeIds);
  const pendingIds = [...storeByOrder.keys()].filter((id) => !cursor || id > cursor);
  const passIds = pendingIds.slice(0, ORDERS_PER_PASS);
  if (!passIds.length) {
    return NextResponse.json({
      revisados: 0,
      reparados: 0,
      sinDireccionEnShopify: 0,
      fallidos: 0,
      restantes: 0,
      cursor: null,
    });
  }

  // Solo se traen los pedidos de esta tanda: el payload de Shopify es pesado y
  // leer los 700 de golpe no aporta nada.
  const admin = createAdminSupabase();
  const targets: AddressRepairTarget[] = [];
  let alreadyFine = 0;
  for (const part of chunk(passIds, 200)) {
    const { data } = await admin.from("orders").select("id,shopify_order_id,raw").in("id", part);
    for (const order of (data as { id: string; shopify_order_id: string | null; raw: unknown }[]) ?? []) {
      // Ya tiene calle guardada: al panel solo le faltaba leerla.
      if (hasDeliverableAddress(shopifyShippingAddress(order.raw))) {
        alreadyFine += 1;
        continue;
      }
      if (!isShopifyOrderId(order.shopify_order_id)) continue;
      const storeId = storeByOrder.get(order.id);
      if (!storeId) continue;
      targets.push({ orderId: order.id, storeId, shopifyOrderId: order.shopify_order_id });
    }
  }

  const outcome = await repairOrderAddresses(targets, admin);
  const lastId = passIds[passIds.length - 1] ?? null;

  return NextResponse.json({
    revisados: passIds.length,
    yaTenian: alreadyFine,
    reparados: outcome.repaired,
    sinDireccionEnShopify: outcome.stillMissing,
    fallidos: outcome.failed,
    restantes: Math.max(0, pendingIds.length - passIds.length),
    cursor: lastId,
  });
}
