import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { describeShalomError } from "@/lib/shalom/client";
import { loadStoreShalom, readWithFreshSession, type StoreShalom } from "@/lib/shalom/session";

// Sirve el rótulo PDF de una guía de Shalom a través del panel, para que la
// operadora no tenga que entrar a pro.shalom.pe a buscar el envío y bajarlo.
//
// Es una ruta y no una server action porque el resultado es un PDF: así el
// navegador lo abre en una pestaña y se imprime, sin pasar el binario por React.
// Necesita descifrar credenciales (service role) → Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// El rótulo de Shalom es una etiqueta de una página. Un techo generoso pero
// finito evita que una respuesta anómala se coma la memoria de la función.
const MAX_BYTES = 10 * 1024 * 1024;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await ctx.params;

  // Autorización por RLS: el cliente de sesión solo ve los envíos de las tiendas
  // a las que el usuario tiene acceso, así que si la fila no aparece, no es suya.
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const { data: shipment } = await sb
    .from("shipments")
    .select("store_id,courier,shalom_ose_id")
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return new NextResponse("forbidden", { status: 403 });

  const row = shipment as { store_id: string; courier: string; shalom_ose_id: number | null };
  if (row.courier !== "shalom") {
    return new NextResponse("esta guía no es de Shalom", { status: 400 });
  }
  // Las guías que entraron por el reporte Excel no tienen `ose_id`: nacieron en
  // el panel de Shalom y su rótulo se baja de ahí. Solo las creadas por API lo
  // tienen, y solo esas pueden servirse acá.
  if (!row.shalom_ose_id) {
    return new NextResponse(
      "Esta guía no se creó por API (llegó por el reporte), así que su rótulo hay que bajarlo de pro.shalom.pe.",
      { status: 404 },
    );
  }

  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, row.store_id);
  if (!store?.shalom_pro_email) {
    return new NextResponse("La tienda no tiene cuenta de Shalom Pro configurada.", { status: 409 });
  }

  let pdf: ArrayBuffer;
  try {
    // Lectura: si el token está muerto se renueva y reintenta sola. Bajar el
    // rótulo no crea ni modifica nada, así que repetirlo es gratis.
    pdf = await readWithFreshSession(admin, row.store_id, store as StoreShalom, (client) =>
      client.label(row.shalom_ose_id as number),
    );
  } catch (err) {
    return new NextResponse(describeShalomError(err), { status: 502 });
  }

  if (pdf.byteLength > MAX_BYTES) {
    return new NextResponse("el rótulo llegó con un tamaño inesperado", { status: 502 });
  }

  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
      // `inline` para que se abra en el visor y se imprima de una; el nombre
      // sale con el nº de orden para que el PDF descargado sea identificable.
      "content-disposition": `inline; filename="rotulo-shalom-${row.shalom_ose_id}.pdf"`,
      // Privado: es un documento de un pedido concreto, no cachear en compartido.
      "cache-control": "private, max-age=300",
    },
  });
}
