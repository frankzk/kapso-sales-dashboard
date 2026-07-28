import { NextResponse, type NextRequest } from "next/server";
import { getAccessibleStores, getCurrentUser, chunk } from "@/lib/access";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { fetchOrderById } from "@/lib/shopify";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import {
  buildFenixProgrammingRows,
  createFenixProgrammingWorkbook,
  type FenixProgrammingAddressFallback,
  type FenixProgrammingOrder,
  type FenixProgrammingShipment,
} from "@/lib/fenix-programming-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHIPMENTS = 5_000;
// Tope de pedidos que el export re-consulta en vivo a Shopify para recuperar
// una dirección faltante, y cuántos van en paralelo. Un despacho diario son
// decenas de guías, así que cubre el caso real sin arriesgar el maxDuration.
const MAX_ADDRESS_REPAIRS = 150;
const ADDRESS_REPAIR_CONCURRENCY = 8;

type ExportBody = {
  date?: unknown;
  shipmentIds?: unknown;
};

type ShipmentCallNote = {
  shipment_id: string;
  note: string | null;
  occurred_at: string;
};

/**
 * Dirección de respaldo por pedido, para las guías cuya dirección no viajó en el
 * reporte Aliclik ni en el pedido de Shopify: el formulario COD (Releasit) la
 * guarda en el carrito, y las ventas por llamada en el lead. Es la misma cadena
 * de respaldo que ya usa el panel del envío. Best-effort: si una consulta falla,
 * el Excel sale igual con las direcciones que sí tenía.
 */
async function loadAddressFallbacks(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  shopifyOrderIdByOrderId: Map<string, string>,
): Promise<Map<string, FenixProgrammingAddressFallback>> {
  const byOrderId = new Map<string, FenixProgrammingAddressFallback>();
  const orderIds = [...shopifyOrderIdByOrderId.keys()];
  if (!orderIds.length) return byOrderId;

  const orderIdByGid = new Map<string, string>();
  for (const [orderId, shopifyOrderId] of shopifyOrderIdByOrderId) {
    orderIdByGid.set(`gid://shopify/Order/${shopifyOrderId}`, orderId);
  }
  const gids = [...orderIdByGid.keys()];

  const [draftPages, leadPages] = await Promise.all([
    Promise.all(
      chunk(gids, 300).map((batch) =>
        sb.from("draft_orders").select("order_gid,address1,referencia").in("order_gid", batch),
      ),
    ),
    Promise.all(
      chunk(orderIds, 300).map((batch) =>
        sb.from("leads").select("order_id,address1,referencia").in("order_id", batch),
      ),
    ),
  ]);

  // El carrito COD manda; el lead completa lo que falte.
  for (const page of leadPages) {
    for (const lead of (page.data as { order_id: string | null; address1: string | null; referencia: string | null }[] | null) ?? []) {
      if (!lead.order_id || (!lead.address1 && !lead.referencia)) continue;
      byOrderId.set(lead.order_id, { address1: lead.address1, reference: lead.referencia });
    }
  }
  for (const page of draftPages) {
    for (const draft of (page.data as { order_gid: string | null; address1: string | null; referencia: string | null }[] | null) ?? []) {
      const orderId = draft.order_gid ? orderIdByGid.get(draft.order_gid) : undefined;
      if (!orderId || (!draft.address1 && !draft.referencia)) continue;
      const current = byOrderId.get(orderId);
      byOrderId.set(orderId, {
        address1: draft.address1 ?? current?.address1 ?? null,
        reference: draft.referencia ?? current?.reference ?? null,
      });
    }
  }
  return byOrderId;
}

/**
 * Recupera en vivo desde Shopify las direcciones que faltan y repara el pedido
 * guardado. Durante meses la app sincronizó pedidos sin dirección (Shopify
 * devolvía shippingAddress solo con el teléfono hasta que se habilitó el acceso
 * a datos protegidos del cliente), así que el destino existe en Shopify pero no
 * en la copia local. Es la misma reparación que ya hace el panel del envío al
 * abrirlo, aplicada a las guías que se van a despachar. Best-effort y acotada:
 * si una tienda no responde, esa fila sale como antes y el Excel se genera igual.
 */
async function repairMissingAddresses(
  shipments: FenixProgrammingShipment[],
  ordersById: Map<string, FenixProgrammingOrder>,
  addressFallbackByOrderId: Map<string, FenixProgrammingAddressFallback>,
): Promise<void> {
  const pending: { orderId: string; storeId: string; shopifyOrderId: string }[] = [];
  const seen = new Set<string>();
  for (const shipment of shipments) {
    if (shipment.delivery_address?.trim() || !shipment.order_id || seen.has(shipment.order_id)) continue;
    const order = ordersById.get(shipment.order_id);
    if (!order) continue;
    if (shopifyShippingAddress(order.raw)?.address1?.trim()) continue;
    if (addressFallbackByOrderId.get(shipment.order_id)?.address1?.trim()) continue;
    const shopifyOrderId = (order as { shopify_order_id?: string | null }).shopify_order_id;
    // Las ventas manuales ("manual-…"/"draft-…") no existen en Shopify.
    if (!shopifyOrderId || !/^\d+$/.test(shopifyOrderId)) continue;
    seen.add(shipment.order_id);
    pending.push({ orderId: shipment.order_id, storeId: shipment.store_id, shopifyOrderId });
    if (pending.length >= MAX_ADDRESS_REPAIRS) break;
  }
  if (!pending.length) return;

  const admin = createAdminSupabase();
  const credsByStore = new Map<string, Awaited<ReturnType<typeof getStoreCreds>>>();
  for (const storeId of new Set(pending.map((item) => item.storeId))) {
    try {
      credsByStore.set(storeId, await getStoreCreds(storeId, admin));
    } catch {
      credsByStore.set(storeId, null);
    }
  }

  for (const batch of chunk(pending, ADDRESS_REPAIR_CONCURRENCY)) {
    await Promise.all(
      batch.map(async ({ orderId, storeId, shopifyOrderId }) => {
        const creds = credsByStore.get(storeId);
        if (!creds?.shopify_token) return;
        try {
          const live = await fetchOrderById({
            domain: creds.shopify_domain,
            token: creds.shopify_token,
            storeId,
            orderGid: `gid://shopify/Order/${shopifyOrderId}`,
          });
          if (!shopifyShippingAddress(live?.raw)?.address1?.trim()) return;
          const order = ordersById.get(orderId);
          if (order) ordersById.set(orderId, { ...order, raw: live!.raw });
          // Persistir la reparación: el panel, el tablero y los próximos
          // exports ya no necesitan volver a consultarlo.
          await admin.from("orders").update({ raw: live!.raw }).eq("id", orderId);
        } catch {
          // Tienda sin permiso o API caída: la fila sale sin dirección, como antes.
        }
      }),
    );
  }
}

/**
 * Generate the Fenix programming workbook from an explicit, client-visible
 * shipment selection. Every id is re-authorized and revalidated server-side so
 * a stale screen cannot export another store, another date or a non-Fenix row.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

  const stores = await getAccessibleStores();
  const accessibleStoreIds = stores.map((store) => store.id);
  if (!accessibleStoreIds.length) {
    return NextResponse.json({ error: "Sin tiendas accesibles." }, { status: 403 });
  }

  let body: ExportBody;
  try {
    body = await req.json() as ExportBody;
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "Elige una fecha de programación válida." }, { status: 400 });
  }

  const requestedIds = Array.isArray(body.shipmentIds)
    ? body.shipmentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const shipmentIds = Array.from(new Set(requestedIds));
  if (!shipmentIds.length) {
    return NextResponse.json({ error: "No hay guías para exportar." }, { status: 400 });
  }
  if (shipmentIds.length > MAX_SHIPMENTS) {
    return NextResponse.json(
      { error: `La selección supera el máximo de ${MAX_SHIPMENTS} guías.` },
      { status: 413 },
    );
  }

  const sb = await createServerSupabase();
  const shipmentPages = await Promise.all(
    chunk(shipmentIds, 300).map((ids) =>
      sb
        .from("shipments")
        .select(
          "id,store_id,guide_code,courier,status_category,order_id,order_name,customer_name,customer_phone,product,city,district,delivery_address,delivery_reference,latitude,longitude,next_followup_at",
        )
        .in("id", ids)
        .in("store_id", accessibleStoreIds)
        .eq("courier", "fenix")
        .eq("status_category", "in_route"),
    ),
  );
  const shipmentError = shipmentPages.find((page) => page.error)?.error;
  if (shipmentError) {
    return NextResponse.json(
      { error: `No se pudieron cargar las guías: ${shipmentError.message}` },
      { status: 500 },
    );
  }

  const eligibleById = new Map<string, FenixProgrammingShipment>();
  for (const page of shipmentPages) {
    for (const shipment of (page.data as FenixProgrammingShipment[] | null) ?? []) {
      if (shipment.next_followup_at?.slice(0, 10) === date) {
        eligibleById.set(shipment.id, shipment);
      }
    }
  }
  // Keep the same stable order the user sees in the current filtered list.
  const shipments = shipmentIds
    .map((id) => eligibleById.get(id))
    .filter((shipment): shipment is FenixProgrammingShipment => !!shipment);
  if (!shipments.length) {
    return NextResponse.json(
      { error: "No quedan guías Fenix en ruta para esa fecha." },
      { status: 400 },
    );
  }

  const orderIds = Array.from(
    new Set(shipments.map((shipment) => shipment.order_id).filter((id): id is string => !!id)),
  );
  const [orderPages, callPages] = await Promise.all([
    Promise.all(
      chunk(orderIds, 300).map((ids) =>
        sb.from("orders").select("id,name,shopify_order_id,total_amount,line_items,raw").in("id", ids),
      ),
    ),
    Promise.all(
      chunk(shipments.map((shipment) => shipment.id), 100).map((ids) =>
        sb
          .from("shipment_calls")
          .select("shipment_id,note,occurred_at")
          .in("shipment_id", ids)
          .not("note", "is", null)
          .order("occurred_at", { ascending: false })
          .limit(1_000),
      ),
    ),
  ]);

  const orderError = orderPages.find((page) => page.error)?.error;
  const callError = callPages.find((page) => page.error)?.error;
  if (orderError || callError) {
    return NextResponse.json(
      { error: `No se pudo completar la información del Excel: ${(orderError ?? callError)?.message}` },
      { status: 500 },
    );
  }

  const ordersById = new Map<string, FenixProgrammingOrder>();
  const shopifyOrderIdByOrderId = new Map<string, string>();
  for (const page of orderPages) {
    for (const order of (page.data as (FenixProgrammingOrder & { shopify_order_id?: string | null })[] | null) ?? []) {
      ordersById.set(order.id, order);
      if (order.shopify_order_id) shopifyOrderIdByOrderId.set(order.id, order.shopify_order_id);
    }
  }

  const addressFallbackByOrderId = await loadAddressFallbacks(sb, shopifyOrderIdByOrderId);
  await repairMissingAddresses(shipments, ordersById, addressFallbackByOrderId);

  const latestNoteByShipment = new Map<string, string>();
  for (const page of callPages) {
    for (const call of (page.data as ShipmentCallNote[] | null) ?? []) {
      const note = call.note?.trim();
      if (note && !latestNoteByShipment.has(call.shipment_id)) {
        latestNoteByShipment.set(call.shipment_id, note);
      }
    }
  }

  const rows = buildFenixProgrammingRows(
    shipments,
    ordersById,
    latestNoteByShipment,
    addressFallbackByOrderId,
  );
  if (!rows.length) {
    return NextResponse.json({ error: "No se pudo construir ninguna fila para el Excel." }, { status: 400 });
  }

  const workbook = await createFenixProgrammingWorkbook(rows);
  return new NextResponse(new Uint8Array(workbook), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="fenix_programacion_${date}.xlsx"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
