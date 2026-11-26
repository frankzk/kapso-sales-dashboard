import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { loadGfReadyStores } from "@/lib/gf-auto-guide-server";
import { describeGfCatalogSync, recordGfCatalogSync, syncGfCatalog } from "@/lib/gf-catalog-sync-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Catálogo sincronizado con GF Courier (MOM §29.17, owner 16-11-2026): cada hora, cada tienda con GF Courier por API
// habilitado sube a GF lo que falta o cambió de nombre, y agota lo que dejó de vender. `?dry=1` dice qué haría.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (!dry && process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const admin = createAdminSupabase();
  const ready = await loadGfReadyStores(admin);
  if (ready.error) return NextResponse.json({ error: ready.error }, { status: 502 });
  const stores = [];
  for (const s of ready.stores) {
    const report = await syncGfCatalog(admin, s.id, { dry });
    const summary = describeGfCatalogSync(report);
    // Queda en sync_state y en el log de Vercel: un fallo (p. ej. sin catalogue:write) ya no pasa en silencio.
    await recordGfCatalogSync(admin, report);
    (report.ok ? console.log : console.warn)(`[gf-catalog-sync] ${s.name}${dry ? " (dry)" : ""}: ${summary}`);
    stores.push({ store: s.name, ok: report.ok, summary });
  }
  return NextResponse.json({ dry, stores });
}
