import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runPagoOnlineDaily } from "@/lib/pago-online-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// «Pago solo online (lista automática)» (MOM §41.11). Corre cada minuto entre
// las 10:00 y las 10:59 UTC (05:00 a 05:59 de Lima, que es UTC−5 fijo):
//   * la primera pasada del día calcula la lista de cada organización que no
//     está apagada (el candado `pago_online_runs.daily_key` hace que las demás
//     se salten el cálculo) y, en Activo, la manda a cada tienda;
//   * todas miran los reintentos que tocan (1, 5 y 15 minutos después de un
//     5xx o un tiempo agotado): 1 + 5 + 15 = 21 minutos, dentro de la hora.
// Si el cálculo falla, suelta el candado y el minuto siguiente lo vuelve a
// intentar. Solo producción, con CRON_SECRET (`internalAuthorized`).
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const report = await runPagoOnlineDaily(createAdminSupabase());
  // Sin celulares ni correos en la respuesta: solo cuentas y estados.
  return NextResponse.json(
    {
      error: report.error,
      orgs: report.orgs.map((o) => ({
        orgId: o.orgId,
        mode: o.mode,
        skipped: o.skipped ?? null,
        runId: o.runId,
        phones: o.counts?.phones ?? null,
        emails: o.counts?.emails ?? null,
        guard: o.guard,
        error: o.error,
        sends: o.sends.map((s) => ({ storeId: s.storeId, status: s.status, httpStatus: s.httpStatus, nextAttemptAt: s.nextAttemptAt })),
      })),
      retries: report.retries.map((s) => ({ storeId: s.storeId, status: s.status, httpStatus: s.httpStatus, nextAttemptAt: s.nextAttemptAt })),
    },
    { status: report.error ? 502 : 200 },
  );
}
