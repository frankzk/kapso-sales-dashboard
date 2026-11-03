// «Swayp por salir · Lima» (fase 1, solo lectura; owner 03-11-2026) por GET,
// no por acción de servidor, como «Reintentos por salir»: Next ejecuta las
// acciones de servidor de una pestaña una detrás de otra, y si la estación
// leyera esta lista con una acción el escaneo (`markShipmentReady`) esperaría a
// que la lectura termine. Un GET con `fetch` va por fuera de esa cola y el
// escáner nunca espera a la lista.
//
// Solo lee. La puerta (`warehouse.prepare` y las tiendas de Equipo) va dentro
// de `getWarehouseSwayp`, que nunca lanza; sin sesión redirige a /login.

import { NextResponse } from "next/server";
import { getWarehouseSwayp } from "@/lib/warehouse-swayp-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getWarehouseSwayp();
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
