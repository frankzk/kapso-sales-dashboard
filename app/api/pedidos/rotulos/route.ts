// Rótulos en lote: un PDF con todas las etiquetas de los pedidos seleccionados.
//
// El almacén no imprime de a uno: prepara la tanda del día. Este endpoint recibe
// los pedidos marcados en el Master y devuelve UN archivo descargable, con una
// página de 100 × 150 mm por rótulo — el mismo formato que el rótulo individual
// HTML, para no reconfigurar la impresora de etiquetas.
//
// Lectura por RLS (cliente de sesión): una salida de otra tienda simplemente no
// aparece, así que cambiar ids en la URL no filtra rótulos ajenos.

import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createServerSupabase } from "@/lib/db";
import { isCourierTbd, outputDisplayCode } from "@/lib/shipment-output";
import { buildRotulosPdf, type RotuloData } from "@/lib/labels/rotulo-pdf";
import { selectLabelsForOrders, type ShipmentForLabel } from "@/lib/labels/pick-shipment";
import { labelItemsFor } from "@/lib/labels/line-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tope defensivo: una tanda real son decenas, no miles. Evita PDFs eternos. */
const MAX_LABELS = 200;

const LABEL_COLUMNS =
  "id,order_id,courier,guide_code,output_code,output_number,qr_token,custody_state,created_at," +
  "order_name,customer_name,customer_phone,product,district,province,region,delivery_address,delivery_reference";

type LabelRow = ShipmentForLabel & {
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
};

function parseIds(raw: string | null): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const orderIds = parseIds(params.get("orders"));
  const shipmentIds = parseIds(params.get("ids"));

  if (!orderIds.length && !shipmentIds.length) {
    return NextResponse.json({ error: "Indica los pedidos a rotular." }, { status: 400 });
  }
  if (orderIds.length > MAX_LABELS || shipmentIds.length > MAX_LABELS) {
    return NextResponse.json(
      { error: `Demasiados rótulos de una vez (máximo ${MAX_LABELS}).` },
      { status: 400 },
    );
  }

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const query = sb.from("shipments").select(LABEL_COLUMNS);
  const { data } = orderIds.length
    ? await query.in("order_id", orderIds)
    : await query.in("id", shipmentIds);
  const rows = (data as LabelRow[] | null) ?? [];

  // Con `orders` se elige una salida por pedido; con `ids` el operador ya eligió
  // la salida exacta, y solo se respeta el orden en que las pidió.
  let selected: LabelRow[];
  let missing: string[] = [];
  if (orderIds.length) {
    const picked = selectLabelsForOrders(orderIds, rows);
    selected = picked.labels;
    missing = picked.missing;
  } else {
    const byId = new Map(rows.map((row) => [row.id, row]));
    selected = shipmentIds.map((id) => byId.get(id)).filter(Boolean) as LabelRow[];
  }

  if (!selected.length) {
    return NextResponse.json(
      {
        error:
          missing.length > 0
            ? "Los pedidos seleccionados todavía no tienen una salida creada, así que no hay rótulo que imprimir."
            : "No se encontraron esas salidas, o no tienes acceso.",
      },
      { status: 404 },
    );
  }

  // Las líneas del pedido son la fuente real de cantidad y variante: el texto
  // guardado en la salida no distingue tallas, y hay pedidos con tres líneas del
  // mismo producto que solo se diferencian por ahí.
  // El total del pedido es además lo que se cobra en la puerta, así que viaja en
  // la misma consulta: es el dato más caro de equivocar del rótulo.
  const lineItemsByOrder = new Map<string, unknown>();
  const moneyByOrder = new Map<string, { total: number | null; currency: string | null }>();
  const selectedOrderIds = Array.from(
    new Set(selected.map((row) => row.order_id).filter(Boolean) as string[]),
  );
  if (selectedOrderIds.length) {
    const { data: orderRows } = await sb
      .from("orders")
      .select("id,line_items,total_amount,currency")
      .in("id", selectedOrderIds);
    type OrderRow = {
      id: string;
      line_items: unknown;
      total_amount: number | null;
      currency: string | null;
    };
    for (const order of (orderRows as OrderRow[] | null) ?? []) {
      lineItemsByOrder.set(order.id, order.line_items);
      moneyByOrder.set(order.id, { total: order.total_amount, currency: order.currency });
    }
  }

  const labels: RotuloData[] = await Promise.all(
    selected.map(async (row) => {
      const payload = row.qr_token || row.output_code || row.guide_code;
      const money = row.order_id ? moneyByOrder.get(row.order_id) : undefined;
      return {
        code: outputDisplayCode(row.output_code, row.courier) || row.guide_code,
        // Una salida sin courier decidido lo dice en el rótulo: el operador ve
        // que ese paquete todavía puede ir a cualquier ruta.
        courier: isCourierTbd(row.courier) ? "Por definir" : row.courier,
        orderName: row.order_name,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        items: labelItemsFor(
          row.order_id ? lineItemsByOrder.get(row.order_id) : null,
          row.product,
        ),
        collectAmount: money?.total ?? null,
        currency: money?.currency ?? null,
        destination: [row.district, row.province, row.region].filter(Boolean).join(" / "),
        address: row.delivery_address,
        reference: row.delivery_reference,
        qrPayload: payload,
        qrPng: new Uint8Array(
          await QRCode.toBuffer(payload, {
            type: "png",
            margin: 1,
            width: 360,
            errorCorrectionLevel: "M",
          }),
        ),
      };
    }),
  );

  const pdf = await buildRotulosPdf(labels);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename =
    labels.length === 1 ? `rotulo-${labels[0]!.code}.pdf` : `rotulos-${stamp}-${labels.length}.pdf`;

  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "-")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // Cuántos de los pedidos pedidos no tenían salida: la UI lo avisa.
      "x-rotulos-missing": String(missing.length),
    },
  });
}
