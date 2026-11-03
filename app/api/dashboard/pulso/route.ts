import { NextResponse, type NextRequest } from "next/server";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getSalesPulse } from "@/lib/sales-pulse-access";
import { parsePulsePeriod } from "@/lib/sales-pulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// «Cómo van las ventas» del Consolidado (MOM §17.5): hoy, esta semana o este
// mes (`?periodo=hoy|semana|mes`) de las tiendas que ve quien pregunta, contra
// el periodo anterior a esta altura. Lo pide el bloque al cambiar de pestaña y
// cada minuto mientras la pestaña está a la vista. Las mismas puertas que la
// página: sin tiendas, o solo vendedora o solo motorizado, no hay ventas que ver.
export async function GET(req: NextRequest) {
  const periodo = parsePulsePeriod(req.nextUrl.searchParams.get("periodo"));
  const [role, stores] = await Promise.all([getUserRoleSummary(), getAccessibleStores()]);
  if (role.isVendedoraOnly || role.isRiderOnly || !stores.length) {
    return NextResponse.json({ error: "Sin acceso a las ventas." }, { status: 403 });
  }
  try {
    const data = await getSalesPulse(stores, periodo);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`No se pudieron leer las ventas (${periodo})`, error);
    return NextResponse.json({ error: "No se pudieron leer las ventas." }, { status: 500 });
  }
}
