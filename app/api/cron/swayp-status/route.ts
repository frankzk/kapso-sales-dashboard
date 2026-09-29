import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { sweepSwaypStatus } from "@/lib/swayp-status-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Estado de las guías Swayp leído de su API (`GET /v2/guias/{guia}`), porque su
// webhook solo manda entregas. La lógica vive en lib/swayp-status-sweep.ts;
// esto solo autentica y deja una línea con los conteos en el log.

function secretEquals(got: string | null, want: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await sweepSwaypStatus(createAdminSupabase());
    // Solo conteos, motivos y forma: ni guías, ni pedidos, ni datos de clientes.
    console.info(
      `[swayp-status] leídas ${report.scanned} · cambiaron ${report.aplicados} · sin cambio ${report.sinCambio}` +
        ` · no encontradas ${report.noEncontradas} · errores ${report.errores}` +
        (report.detenido ? ` · detenido: ${report.detenido}` : "") +
        (Object.keys(report.desconocidos).length ? ` · desconocidos ${JSON.stringify(report.desconocidos)}` : "") +
        (report.fallos.length ? ` · fallos ${JSON.stringify(report.fallos)}` : "") +
        // La forma de la respuesta (claves y estados crudos, sin datos): la API
        // no está documentada y así se ve qué manda.
        ` · crudos ${JSON.stringify(report.crudos)} · historial ${report.historial ?? "-"} · forma ${JSON.stringify(report.forma)}`,
    );
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : "falló el barrido";
    console.error(`[swayp-status] ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
