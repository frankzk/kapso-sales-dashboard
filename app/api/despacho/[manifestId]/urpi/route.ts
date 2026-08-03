// El Excel de una ruta de Urpi, en el formato que ellos cargan en su sistema.
//
// Exporta lo que la ruta tiene EN ESTE MOMENTO, no lo que se planificó: un
// paquete retirado en el cotejo no puede seguir en la lista que Urpi carga, o
// quedarían esperando una caja que nunca sale.
//
// Lectura por RLS (cliente de sesión): una ruta de otra organización no aparece.

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/db";
import { courierKey } from "@/lib/dispatch";
import { buildUrpiWorkbook, type UrpiExportInput } from "@/lib/exports/urpi-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHIPMENT_COLUMNS =
  "id,store_id,order_id,order_name,customer_name,customer_phone," +
  "district,province,delivery_address,delivery_reference,product";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ manifestId: string }> },
) {
  const { manifestId } = await context.params;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const { data: manifest } = await sb
    .from("dispatch_manifests")
    .select("id,courier,route_date,route_label,driver_name")
    .eq("id", manifestId)
    .maybeSingle();
  if (!manifest) return NextResponse.json({ error: "Ruta no encontrada." }, { status: 404 });
  if (courierKey(manifest.courier) !== "urpi") {
    return NextResponse.json(
      { error: "Ese formato de Excel es de Urpi; esta ruta es de otro courier." },
      { status: 400 },
    );
  }

  const { data: items } = await sb
    .from("dispatch_manifest_items")
    .select("shipment_id,added_at")
    .eq("manifest_id", manifestId)
    .is("removed_at", null)
    .order("added_at", { ascending: true });
  const shipmentIds = (items ?? []).map((item) => item.shipment_id as string);
  if (!shipmentIds.length) {
    return NextResponse.json({ error: "La ruta todavía no tiene paquetes." }, { status: 400 });
  }

  const { data: shipmentRows } = await sb
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .in("id", shipmentIds);
  type ShipmentRow = {
    id: string;
    store_id: string;
    order_id: string | null;
    order_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    district: string | null;
    province: string | null;
    delivery_address: string | null;
    delivery_reference: string | null;
    product: string | null;
  };
  const byId = new Map(
    ((shipmentRows as ShipmentRow[] | null) ?? []).map((row) => [row.id, row]),
  );
  // Se respeta el orden en que se agregaron a la ruta: es el orden en que el
  // almacén las apiló, y con el que se coteja la caja.
  const shipments = shipmentIds.map((id) => byId.get(id)).filter(Boolean) as ShipmentRow[];

  const orderIds = Array.from(
    new Set(shipments.map((row) => row.order_id).filter(Boolean) as string[]),
  );
  const orders = new Map<
    string,
    { line_items: unknown; total_amount: number | null; shopify_note: string | null }
  >();
  if (orderIds.length) {
    const { data: orderRows } = await sb
      .from("orders")
      .select("id,line_items,total_amount,shopify_note")
      .in("id", orderIds);
    type OrderRow = {
      id: string;
      line_items: unknown;
      total_amount: number | null;
      shopify_note: string | null;
    };
    for (const order of (orderRows as OrderRow[] | null) ?? []) {
      orders.set(order.id, {
        line_items: order.line_items,
        total_amount: order.total_amount,
        shopify_note: order.shopify_note,
      });
    }
  }

  const storeNames = new Map<string, string>();
  const storeIds = Array.from(new Set(shipments.map((row) => row.store_id)));
  if (storeIds.length) {
    const { data: storeRows } = await sb.from("stores").select("id,name").in("id", storeIds);
    for (const store of (storeRows as { id: string; name: string | null }[] | null) ?? []) {
      if (store.name) storeNames.set(store.id, store.name);
    }
  }

  const rows: UrpiExportInput[] = shipments.map((row) => {
    const order = row.order_id ? orders.get(row.order_id) : undefined;
    return {
      routeDate: manifest.route_date as string,
      storeName: storeNames.get(row.store_id) ?? null,
      orderName: row.order_name,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      province: row.province,
      district: row.district,
      address: row.delivery_address,
      reference: row.delivery_reference,
      lineItems: order?.line_items ?? null,
      productText: row.product,
      collectAmount: order?.total_amount ?? null,
      note: order?.shopify_note ?? null,
    };
  });

  const file = await buildUrpiWorkbook(rows);
  const filename = `urpi-${manifest.route_date}-${rows.length}.xlsx`;

  return new NextResponse(new Uint8Array(file), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "-")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
