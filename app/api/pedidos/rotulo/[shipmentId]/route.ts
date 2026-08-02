// Rótulo de UNA salida. Hoy es un redirect al generador de PDF.
//
// POR QUÉ YA NO DEVUELVE HTML. Esta ruta servía una página con un botón
// "Imprimir rótulo" que abría el diálogo del navegador. Eso imprime a la medida
// del papel que el navegador supone —A4—, así que el rótulo salía diminuto en
// una esquina de la hoja: inservible para la impresora de etiquetas.
//
// Peor que el formato era la divergencia: al ser un renderizador aparte, se
// quedó sin la tabla de productos, sin la variante y sin el monto a cobrar. Dos
// rótulos distintos para el mismo paquete es una fuente permanente de errores de
// almacén, así que queda uno solo.
//
// Se mantiene la ruta —en vez de borrarla— porque su URL está en enlaces ya
// repartidos y en `shipments.label_url` de salidas viejas.

import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ shipmentId: string }> },
) {
  const { shipmentId } = await context.params;
  const target = new URL(`/api/pedidos/rotulos?ids=${encodeURIComponent(shipmentId)}`, request.url);
  // 307: el navegador repite el GET con las cookies de sesión, y el PDF se sirve
  // bajo la misma RLS que antes protegía el HTML.
  return NextResponse.redirect(target, 307);
}
