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
// La composición vive en lib/shalom/rotulo-compose.ts, compartida con las guías
// combinadas en lote (app/api/shalom/rotulos).
//
// Es una ruta y no una server action porque devuelve un PDF: el navegador lo
// abre en una pestaña y se imprime, sin pasar el binario por React. Necesita
// descifrar credenciales de la tienda (service role) → Node.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { SHALOM_ROTULO_COLUMNS, composeShalomRotulo, type ShalomRotuloRow } from "@/lib/shalom/rotulo-compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await ctx.params;

  // Autorización por RLS: el cliente de sesión solo ve los envíos de las tiendas
  // del usuario, así que cambiar el id en la URL no sirve para leer otro rótulo.
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const { data: shipment } = await sb.from("shipments").select(SHALOM_ROTULO_COLUMNS).eq("id", shipmentId).maybeSingle();
  if (!shipment) return new NextResponse("forbidden", { status: 403 });

  const result = await composeShalomRotulo(sb, createAdminSupabase(), shipment as unknown as ShalomRotuloRow);
  if (!result.ok) return new NextResponse(result.message, { status: result.status });

  return new NextResponse(result.pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="rotulo-${result.code}.pdf"`,
      "cache-control": "private, max-age=300",
    },
  });
}
