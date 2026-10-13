import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runPorConfirmarAuto } from "@/lib/swayp-por-confirmar-auto-server";
import type { PorConfirmarAutoSettings } from "@/lib/swayp-por-confirmar-auto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Swayp automático desde Por confirmar (MOM §11.13). Una pasada al día, a las
// 6:30 p. m. de Lima: después de las llamadas del día, para despachar al
// siguiente. Solo las organizaciones que lo activaron.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Un preview no emite guías de producción aunque tenga las credenciales copiadas.
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const admin = createAdminSupabase();
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const { data, error } = await admin.from("swayp_pc_auto_settings").select("*").eq("enabled", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const reports = [];
  for (const settings of (data ?? []) as PorConfirmarAutoSettings[]) {
    const { items, ...resumen } = await runPorConfirmarAuto(admin, settings, { dry });
    reports.push({ org: settings.org_id, ...resumen, items: items.length });
  }
  return NextResponse.json({ reports }, { status: reports.some((r) => r.error) ? 502 : 200 });
}
