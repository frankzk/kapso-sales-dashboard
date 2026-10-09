import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { sincronizarSiToca } from "@/lib/swayp-inventory-sync";
import { recalcularDisponibilidadSwaypMasterTodas } from "@/lib/master-swayp-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Sync DIARIO del stock contra el inventario de Swayp (MOM, «El mismo conteo,
// leído por API»). Lee GET /v1/integrations/products con la credencial de las
// guías. Corre cada hora, pero sólo sincroniza si la última buena fue hace
// ≥ 20 h: casi siempre responde «al día», y un fallo de Swayp se reintenta a
// la hora siguiente. La lógica vive en lib/swayp-inventory-sync.ts.
//
// Las horas en que el sync no toca, refresca igual el filtro «Swayp» del Master
// (0235): el stock no cambió, pero los pedidos sí cambian de etapa. Cuando el
// sync corre, ya lo refrescó él.

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
    const admin = createAdminSupabase();
    const r = await sincronizarSiToca(admin);
    if (r.estado === "sin_credencial" || r.estado === "al_dia") {
      const master = await recalcularDisponibilidadSwaypMasterTodas(admin).catch((e: unknown) => [
        { error: e instanceof Error ? e.message : "error desconocido" },
      ]);
      if (r.estado === "sin_credencial") return NextResponse.json({ ok: true, skipped: r.estado, faltan: r.faltan, master });
      return NextResponse.json({ ok: true, skipped: r.estado, master });
    }
    // Un fallo de Swayp queda registrado en swayp_inventory_sync_runs y se ve
    // en Stock Swayp; el 502 es para que también se vea en los logs de Vercel.
    return NextResponse.json(r.resultado, { status: "error" in r.resultado ? 502 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falló el sync de inventario" },
      { status: 500 },
    );
  }
}
