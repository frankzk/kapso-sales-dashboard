import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runScheduledAliclikGuides } from "@/lib/aliclik-scheduled-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Guía Aliclik automática el día programado (MOM §6.2). Cada hora de 8:00 a
// 13:00 de Lima, antes del corte de Aliclik. Solo los pedidos de Provincia COD
// en Preparación · Por generar rótulo con fecha programada para hoy; los que
// fallan avisan por Telegram, uno por uno. `?dry=1` cotiza y dice qué haría.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // Un preview no emite guías de producción aunque tenga las credenciales copiadas.
  if (!dry && process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const report = await runScheduledAliclikGuides(createAdminSupabase(), { dry });
  return NextResponse.json(report, { status: report.error ? 502 : 200 });
}
