import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runGfAutoGuides } from "@/lib/gf-auto-guide-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Guía GF automática (MOM §29.17, owner 15-11-2026; «ni bien entra el pedido»,
// 16-11-2026). Cada 10 minutos, todo el día. Solo los pedidos de Lima en
// Preparación · Por generar rótulo, sin fecha o programados para hoy o un día que
// viene (la guía va con ese día), de las tiendas con GF Courier
// por API; cada organización según su posición en Automatizaciones (Apagado /
// Simulación / Activo). Los que fallan avisan por Telegram, uno por uno.
// `?dry=1` dice qué haría, sin crear, sin escribir y sin avisar.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // Un preview no emite guías de producción aunque tenga las credenciales copiadas.
  if (!dry && process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const report = await runGfAutoGuides(createAdminSupabase(), { dry });
  return NextResponse.json(report, { status: report.error ? 502 : 200 });
}
