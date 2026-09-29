import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { sincronizarSiToca } from "@/lib/swayp-inventory-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Sync DIARIO del stock contra el inventario de Swayp (MOM, «El mismo conteo,
// leído por API»). Corre cada hora, pero sólo sincroniza si la última buena
// fue hace ≥ 20 h y hay una credencial utilizable: la de API
// (`SWAYP_INVENTORY_TOKEN`) o la sesión del panel que una persona dejó al
// pegar su token o al abrir Swayp con la extensión. La lógica vive en
// lib/swayp-inventory-session.ts; esto solo autentica.

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
  const orgId = (process.env.SWAYP_INVENTORY_ORG_ID ?? "").trim();
  if (!orgId) {
    return NextResponse.json({ ok: true, skipped: "sin organización", faltan: ["SWAYP_INVENTORY_ORG_ID"] });
  }
  try {
    const r = await sincronizarSiToca(createAdminSupabase(), orgId);
    if (r.estado !== "corrio") return NextResponse.json({ ok: true, skipped: r.estado });
    // Un fallo de Swayp queda registrado en swayp_inventory_sync_runs y se ve
    // en Stock Swayp; el 502 es para que también se vea en los logs de Vercel.
    return NextResponse.json(
      { origen: r.origen, ...r.resultado },
      { status: "error" in r.resultado ? 502 : 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falló el sync de inventario" },
      { status: 500 },
    );
  }
}
