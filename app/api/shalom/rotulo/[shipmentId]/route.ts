// Rótulo compuesto de una salida Shalom: su etiqueta arriba, la nuestra abajo.
//
// Un envío por agencia necesita dos cosas en el mismo papel. La de Shalom, que
// es la que se lee en su mostrador y la que ellos escanean, y la nuestra, que
// dice QUÉ va dentro y trae el QR de la salida para el doble escaneo de
// despacho. Hasta ahora eran dos impresiones distintas —«Rótulo ↗» y «Rótulo
// interno»— y para conseguir la segunda el almacén terminaba creando una salida
// `por definir` desde «Descargar rótulos (PDF)», que después bloquea la emisión
// de la guía de agencia. Este endpoint las junta y quita el rodeo.
//
// Es una ruta y no una server action porque devuelve un PDF: el navegador lo
// abre en una pestaña y se imprime, sin pasar el binario por React. Necesita
// descifrar credenciales de la tienda (service role) → Node.

import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { describeShalomError } from "@/lib/shalom/client";
import { loadStoreShalom, readWithFreshSession, type StoreShalom } from "@/lib/shalom/session";
import { buildAgencyRotuloPdf } from "@/lib/labels/agency-rotulo";
import { labelItemsFor } from "@/lib/labels/line-items";
import { outputDisplayCode } from "@/lib/shipment-output";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Su etiqueta es una página. Techo generoso pero finito, como en `label/`. */
const MAX_BYTES = 10 * 1024 * 1024;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await ctx.params;

  // Autorización por RLS: el cliente de sesión solo ve los envíos de las tiendas
  // del usuario, así que cambiar el id en la URL no sirve para leer otro rótulo.
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const { data: shipment } = await sb
    .from("shipments")
    .select(
      "id,store_id,order_id,courier,guide_code,output_code,output_number,qr_token,order_name,customer_name,product,shalom_ose_id",
    )
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return new NextResponse("forbidden", { status: 403 });

  const row = shipment as {
    id: string;
    store_id: string;
    order_id: string | null;
    courier: string;
    guide_code: string | null;
    output_code: string | null;
    output_number: number | null;
    qr_token: string | null;
    order_name: string | null;
    customer_name: string | null;
    product: string | null;
    shalom_ose_id: number | null;
  };

  if (row.courier !== "shalom") {
    return new NextResponse("esta guía no es de Shalom", { status: 400 });
  }
  if (!row.shalom_ose_id) {
    return new NextResponse(
      "Esta guía no se creó por API (llegó por el reporte), así que su rótulo hay que bajarlo de pro.shalom.pe.",
      { status: 404 },
    );
  }
  // Sin QR no hay banda que valga: el doble escaneo de despacho es la mitad del
  // motivo de este papel. Es defensivo — la base lo pone al crear la salida.
  if (!row.qr_token) {
    return new NextResponse(
      "Esta salida no tiene QR interno; imprime el rótulo de Shalom y avisa, porque no debería pasar.",
      { status: 409 },
    );
  }

  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, row.store_id);
  if (!store?.shalom_pro_email) {
    return new NextResponse("La tienda no tiene cuenta de Shalom Pro configurada.", { status: 409 });
  }

  let courierPdf: ArrayBuffer;
  try {
    // Lectura: si el token murió se renueva y reintenta sola. Bajar el rótulo no
    // crea ni modifica nada, así que repetirlo es gratis.
    courierPdf = await readWithFreshSession(admin, row.store_id, store as StoreShalom, (client) =>
      client.label(row.shalom_ose_id as number),
    );
  } catch (err) {
    return new NextResponse(describeShalomError(err), { status: 502 });
  }
  if (courierPdf.byteLength > MAX_BYTES) {
    return new NextResponse("el rótulo de Shalom llegó con un tamaño inesperado", { status: 502 });
  }

  // Los productos y la tienda salen por el cliente de sesión, no por el admin:
  // lo que el usuario no puede ver tampoco debe acabar impreso en un rótulo.
  const [{ data: order }, { data: storeRow }] = await Promise.all([
    row.order_id
      ? sb.from("orders").select("line_items").eq("id", row.order_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("stores").select("name").eq("id", row.store_id).maybeSingle(),
  ]);

  const code =
    outputDisplayCode(row.output_code, row.courier) || row.output_code || row.guide_code || "";

  let pdf: Uint8Array;
  try {
    pdf = await buildAgencyRotuloPdf(courierPdf, {
      code,
      guideCode: row.guide_code,
      storeName: (storeRow as { name: string | null } | null)?.name ?? null,
      orderName: row.order_name,
      customerName: row.customer_name,
      items: labelItemsFor((order as { line_items?: unknown } | null)?.line_items, row.product),
      qrPng: await QRCode.toBuffer(row.qr_token, {
        margin: 0,
        width: 320,
        errorCorrectionLevel: "M",
      }),
    });
  } catch {
    // Componer puede fallar si su PDF viene corrupto o cifrado. Se dice, en vez
    // de servir un papel a medias: el rótulo suelto sigue en `/api/shalom/label`.
    return new NextResponse(
      "No se pudo componer el rótulo con el PDF de Shalom. Usa el rótulo suelto y avisa.",
      { status: 502 },
    );
  }

  return new NextResponse(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="rotulo-${code || row.shalom_ose_id}.pdf"`,
      "cache-control": "private, max-age=300",
    },
  });
}
