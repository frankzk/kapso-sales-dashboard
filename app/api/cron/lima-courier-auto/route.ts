import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runLimaCourierAuto } from "@/lib/lima-courier-auto-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Guía Aliclik y Swayp del día programado en Lima (MOM §9.5 y §40, owner
// 16-11-2026: «Kapta la crea ese día»; «también debe intentar en la noche»). A
// las 8:00, 10:00 y 12:00 de Lima crea la guía de Aliclik de lo programado para
// hoy, y a las 15:00, 18:00, 20:00 y 21:00 la de lo de mañana (si Aliclik lo
// recoge ese día). Swayp arma su ruta el día anterior: su guía, la víspera.
// Cada organización según su posición en Automatizaciones (Apagado /
// Simulación / Activo). Los que fallan avisan por Telegram, uno por uno.
// `?dry=1` dice qué haría, sin crear, sin escribir y sin avisar.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // Un preview no emite guías de producción aunque tenga las credenciales copiadas.
  if (!dry && process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const report = await runLimaCourierAuto(createAdminSupabase(), { dry });
  return NextResponse.json(report, { status: report.error ? 502 : 200 });
}
