import { NextResponse } from "next/server";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getTodaySales } from "@/lib/today-sales-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// El refresco de «Hoy» del Consolidado (MOM §17.5): las ventas del día de las
// tiendas que ve quien pregunta, contra ayer a esta hora. Lo pide el bloque
// cada minuto mientras la pestaña está a la vista. Las mismas puertas que la
// página: sin tiendas, o solo vendedora o solo motorizado, no hay ventas que ver.
export async function GET() {
  const [role, stores] = await Promise.all([getUserRoleSummary(), getAccessibleStores()]);
  if (role.isVendedoraOnly || role.isRiderOnly || !stores.length) {
    return NextResponse.json({ error: "Sin acceso a las ventas de hoy." }, { status: 403 });
  }
  try {
    const data = await getTodaySales(stores);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("No se pudieron leer las ventas de hoy", error);
    return NextResponse.json({ error: "No se pudieron leer las ventas de hoy." }, { status: 500 });
  }
}
