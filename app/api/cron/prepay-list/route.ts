import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runPrepayAutoRule } from "@/lib/prepay-list-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// La regla automática de la «Lista de pago adelantado» (MOM §41). Cada hora:
// en cada organización con la regla en Simulación guarda quién entraría; en
// Activo agrega a la lista a quien rechazó en la puerta o no recogió en la
// agencia en los últimos seis meses (respetando las bajas a mano). Apagado no
// hace nada. Solo producción: un preview no escribe la lista de verdad.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const report = await runPrepayAutoRule(createAdminSupabase());
  // Sin celulares en la respuesta: solo cuentas y nombres de pedido.
  return NextResponse.json(
    {
      error: report.error,
      orgs: report.orgs.map((o) => ({
        orgId: o.orgId,
        mode: o.mode,
        error: o.error,
        wouldAdd: o.summary?.wouldAdd ?? 0,
        inserted: o.summary?.inserted ?? null,
        alreadyListed: o.summary?.alreadyListed ?? 0,
        respectedRemovals: o.summary?.respectedRemovals ?? 0,
      })),
    },
    { status: report.error ? 502 : 200 },
  );
}
