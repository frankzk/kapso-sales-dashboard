import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runLimaRetryAuto } from "@/lib/lima-retry-auto-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Reintentos Aliclik automáticos de Lima (MOM §9.5, entrega 3, 04-11-2026).
// Cada hora de 8:23 a 13:23 de Lima, antes del corte de Aliclik: las variantes
// en simulación dejan su renglón en el log y las activas crean la guía como
// «Aprobar», con tope diario. `?dry=1` es la vista previa: cotiza todas las
// variantes como si estuvieran en simulación y no escribe nada.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // Un preview no emite guías de producción aunque tenga las credenciales copiadas.
  if (!dry && process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const report = await runLimaRetryAuto(createAdminSupabase(), { preview: dry });
  return NextResponse.json(report, { status: report.error ? 502 : 200 });
}
