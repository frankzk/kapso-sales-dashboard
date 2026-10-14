// «Reintentos por salir» (entrega 1c, MOM §9.5) por GET, no por acción de
// servidor. Next ejecuta las acciones de servidor de una pestaña una detrás de
// otra: si la estación leyera la lista con una acción al montar, el primer
// escaneo (`markShipmentReady`) esperaría a que esa lectura termine. Un GET
// con `fetch` va por fuera de esa cola y el escáner nunca espera a la lista.
//
// Solo lee. La puerta (`warehouse.prepare` y las tiendas de Equipo) va dentro
// de `getWarehouseRetries`, que nunca lanza; sin sesión redirige a /login.

import { NextResponse } from "next/server";
import { getWarehouseRetries } from "@/lib/warehouse-retries-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getWarehouseRetries();
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
