import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { loadChatbyAutoSettings, runChatbyAutoconfirm } from "@/lib/chatby-autoconfirm-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Confirmación automática por Chatby y su guía Aliclik (MOM §6.1, «Confirmó
// por Chatby», 01-11-2026). Cada 10 minutos: lee en Chatby (solo lectura, dos
// GET por pedido, con tope por pasada) los pedidos de Provincia COD en Por
// confirmar de las últimas 72 h, confirma lo que la clienta confirmó con el
// pedido, el monto y la dirección del pedido, y crea la guía Aliclik de lo
// confirmado hasta el tope del día. Solo las organizaciones encendidas en
// `chatby_auto_settings` (0297); sin la tabla no hace nada. `?dry=1` lee y dice
// qué haría, sin escribir.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  // Un preview no confirma pedidos ni emite guías de producción aunque tenga las credenciales copiadas.
  if (!dry && process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const admin = createAdminSupabase();
  const { settings, missing, error } = await loadChatbyAutoSettings(admin);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (missing) return NextResponse.json({ skipped: "sin_migracion_0297" });
  const reports = [];
  for (const s of settings) {
    const { items, ...resumen } = await runChatbyAutoconfirm(admin, s, { dry });
    reports.push({ ...resumen, items: dry ? items : items.length });
  }
  return NextResponse.json({ reports }, { status: reports.some((r) => r.error) ? 502 : 200 });
}
