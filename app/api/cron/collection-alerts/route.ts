import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { runCollectionAdvanceSweep } from "@/lib/collection-alerts-advance";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Los avisos de cobranza avanzan solos (MOM §12, owner 25-11-2026).
//
// Cada 5 minutos (minutos 2, 7, …, 57: `2-57/5` en vercel.json), en las tiendas
// con algún aviso abierto: retira los que ya están resueltos y pasa a la
// siguiente persona de la escalera los que vencieron su turno. Antes eso solo
// ocurría cuando alguien tenía Kapta abierto, y lo hacía cada consulta de cada
// pestaña (lib/collection-alerts-advance.ts).
//
// Solo producción: un preview no mueve los avisos de verdad. La respuesta y el
// registro llevan conteos, nunca pedidos, celulares ni montos.
async function run(req: NextRequest) {
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });
  const started = Date.now();
  try {
    const report = await runCollectionAdvanceSweep(createAdminSupabase());
    const line = { ...report, ms: Date.now() - started };
    console.log(`[collection-alerts] ${JSON.stringify(line)}`);
    return NextResponse.json({ ok: report.errors === 0, ...line }, { status: report.errors ? 502 : 200 });
  } catch {
    // Sin el mensaje: un error de la base puede citar valores.
    console.log(`[collection-alerts] ${JSON.stringify({ error: "Error de la pasada de avisos de cobranza." })}`);
    return NextResponse.json({ ok: false, error: "Error de la pasada de avisos de cobranza." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
