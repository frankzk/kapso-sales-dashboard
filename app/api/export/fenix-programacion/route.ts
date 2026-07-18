import { NextResponse, type NextRequest } from "next/server";
import { getAccessibleStores, getCurrentUser, chunk } from "@/lib/access";
import { createServerSupabase } from "@/lib/db";
import {
  buildFenixProgrammingRows,
  createFenixProgrammingWorkbook,
  type FenixProgrammingOrder,
  type FenixProgrammingShipment,
} from "@/lib/fenix-programming-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHIPMENTS = 5_000;

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
          "id,store_id,courier,status_category,order_id,order_name,customer_name,customer_phone,product,city,district,delivery_address,delivery_reference,latitude,longitude,next_followup_at",
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
        sb.from("orders").select("id,name,total_amount,line_items,raw").in("id", ids),
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
  for (const page of orderPages) {
    for (const order of (page.data as FenixProgrammingOrder[] | null) ?? []) {
      ordersById.set(order.id, order);
    }
  }

  const latestNoteByShipment = new Map<string, string>();
  for (const page of callPages) {
    for (const call of (page.data as ShipmentCallNote[] | null) ?? []) {
      const note = call.note?.trim();
      if (note && !latestNoteByShipment.has(call.shipment_id)) {
        latestNoteByShipment.set(call.shipment_id, note);
      }
    }
  }

  const rows = buildFenixProgrammingRows(shipments, ordersById, latestNoteByShipment);
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
