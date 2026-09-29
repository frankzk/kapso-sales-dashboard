import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { credencialInventarioDesdeEnv, sincronizarInventarioSwayp } from "@/lib/swayp-inventory-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Sync automático del stock contra el inventario de Swayp (MOM, «El mismo
// conteo, leído por API»). La lógica y las retenciones viven en
// lib/swayp-inventory-sync.ts; esto solo autentica y elige la credencial.
// Sin credencial de inventario (`SWAYP_INVENTORY_TOKEN`) no hace nada:
// responde qué falta.

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
  const guardada = credencialInventarioDesdeEnv();
  if (!guardada.ok) {
    return NextResponse.json({ ok: true, skipped: "sin credencial", faltan: guardada.faltan });
  }
  try {
    const r = await sincronizarInventarioSwayp(createAdminSupabase(), {
      creds: guardada.creds,
      orgId: guardada.orgId,
      userId: null,
      ciudades: "todas",
      source: "cron",
    });
    // Un fallo de Swayp queda registrado en swayp_inventory_sync_runs y se ve
    // en Stock Swayp; el 502 es para que también se vea en los logs de Vercel.
    return NextResponse.json(r, { status: "error" in r ? 502 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falló el sync de inventario" },
      { status: 500 },
    );
  }
}
