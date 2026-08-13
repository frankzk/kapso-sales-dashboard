// Guía combinada: el rótulo de Tanders y el interno en una hoja A4 (0120).
//
// Ver la cabecera de lib/labels/guia-combinada.ts para el porqué del formato.
// Acá solo se reúnen los datos: la ficha que Tanders tiene de la salida
// (`tanders_raw`) y las líneas del pedido, que son la fuente real de cantidad y
// variante — el texto guardado en la salida no distingue tallas.
//
// Lectura por RLS (cliente de sesión), igual que el rótulo interno: una salida
// de otra tienda no aparece, así que cambiar ids en la URL no filtra rótulos
// ajenos.

import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createServerSupabase } from "@/lib/db";
import { outputDisplayCode } from "@/lib/shipment-output";
import { buildTandersLabel, type LabelShipment } from "@/lib/tanders/label";
import { buildGuiaCombinadaPdf, type CombinadaEntry } from "@/lib/labels/guia-combinada";
import { labelItemsFor } from "@/lib/labels/line-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Una tanda real son decenas. El tope evita PDFs eternos. */
const MAX_LABELS = 200;

const COLUMNS =
  "id,order_id,store_id,courier,guide_code,output_code,qr_token,order_name,product," +
  "customer_name,customer_phone,delivery_address,delivery_reference,tanders_raw";

type Row = LabelShipment & {
  id: string;
  order_id: string | null;
  store_id: string;
  courier: string;
  output_code: string | null;
  qr_token: string | null;
  order_name: string | null;
  product: string | null;
};

function parseIds(raw: string | null): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );
}

export async function GET(request: NextRequest) {
  const shipmentIds = parseIds(request.nextUrl.searchParams.get("ids"));
  if (!shipmentIds.length) {
    return NextResponse.json({ error: "Indica las salidas a imprimir." }, { status: 400 });
  }
  if (shipmentIds.length > MAX_LABELS) {
    return NextResponse.json(
      { error: `Demasiadas guías de una vez (máximo ${MAX_LABELS}).` },
      { status: 400 },
    );
  }

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const { data } = await sb.from("shipments").select(COLUMNS).in("id", shipmentIds);
  const byId = new Map(((data as Row[] | null) ?? []).map((r) => [r.id, r]));
  const selected = shipmentIds.map((id) => byId.get(id)).filter(Boolean) as Row[];

  if (!selected.length) {
    return NextResponse.json(
      { error: "No se encontraron esas salidas, o no tienes acceso." },
      { status: 404 },
    );
  }

  // La combinada es de Tanders: su mitad de arriba se dibuja con lo que Tanders
  // tiene de la salida. Una salida de otro courier no puede producirla, y decir
  // por qué evita que alguien concluya que la guía «no funciona».
  const noTanders = selected.filter((r) => r.courier !== "tanders");
  if (noTanders.length === selected.length) {
    return NextResponse.json(
      {
        error:
          "La guía combinada es para salidas de Tanders: su mitad superior es el rótulo del courier.",
      },
      { status: 400 },
    );
  }
  const tandersRows = selected.filter((r) => r.courier === "tanders");

  const orderIds = Array.from(new Set(tandersRows.map((r) => r.order_id).filter(Boolean) as string[]));
  const lineItemsByOrder = new Map<string, unknown>();
  if (orderIds.length) {
    const { data: orders } = await sb.from("orders").select("id,line_items").in("id", orderIds);
    for (const o of ((orders ?? []) as { id: string; line_items: unknown }[])) {
      lineItemsByOrder.set(o.id, o.line_items);
    }
  }
  // La tienda es la marca que el cliente reconoce, no "Kapta" — el mismo
  // criterio que el rótulo interno.
  const storeIds = Array.from(new Set(tandersRows.map((r) => r.store_id)));
  const { data: stores } = await sb.from("stores").select("id,name").in("id", storeIds);
  const storeName = new Map(
    ((stores ?? []) as { id: string; name: string | null }[]).map((s) => [s.id, s.name]),
  );

  const entries: CombinadaEntry[] = [];
  for (const row of tandersRows) {
    const label = buildTandersLabel(row);
    // El QR de Tanders codifica su N° de seguimiento; el nuestro, el token de la
    // SALIDA. Son dos identificadores distintos a propósito: el suyo lo escanean
    // ellos, el nuestro lo escanea el almacén.
    const [tandersQr, internoQr] = await Promise.all([
      QRCode.toBuffer(label.trackingCode, { margin: 0, width: 320, errorCorrectionLevel: "M" }),
      QRCode.toBuffer(row.qr_token ?? row.guide_code, {
        margin: 0,
        width: 320,
        errorCorrectionLevel: "M",
      }),
    ]);
    entries.push({
      tanders: label,
      tandersQrPng: new Uint8Array(tandersQr),
      interno: {
        code: outputDisplayCode(row.output_code, row.courier) || row.guide_code,
        storeName: storeName.get(row.store_id) ?? null,
        orderName: row.order_name,
        // Las líneas del pedido son la fuente real de cantidad y variante; el
        // texto de la salida es el respaldo para las que llegaron sin pedido.
        items: labelItemsFor(row.order_id ? lineItemsByOrder.get(row.order_id) : null, row.product),
        qrPng: new Uint8Array(internoQr),
      },
    });
  }

  const pdf = await buildGuiaCombinadaPdf(entries);
  const filename =
    entries.length === 1 ? `guia-combinada-${entries[0]!.interno.code}.pdf` : `guias-combinadas.pdf`;
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
