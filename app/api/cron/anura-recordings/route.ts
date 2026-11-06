// El cron de «Llamar con Anura» (MOM §8.7, «El cron de Anura», 06-11-2026).
//
// Cada 10 minutos (`1,11,21,31,41,51 * * * *` en vercel.json; el :23 es
// solo de shopify-own-app-tokens) y en todas las organizaciones: suelta las
// llamadas
// que Anura dejó colgadas, marca «vencida» lo que ya no se puede copiar,
// reintenta copiar a Storage las grabaciones «pendiente» que siguen a tiempo
// (las de prueba y las entrantes no tienen ficha que lo haga) y poda la
// bitácora de avisos (más de 30 días, y los enlaces de Anura ya usados). La
// pasada vive en lib/anura/maintenance.ts: acotada por lote y por tiempo, e
// idempotente.
//
//   ?dry=1   solo cuenta lo que haría, sin escribir ni bajar nada.
//
// Fuera de producción no hace nada (un preview copiaría al bucket real); con
// ?dry=1 sí corre. Ni la respuesta ni el log llevan teléfonos ni enlaces.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { runAnuraMaintenance } from "@/lib/anura/maintenance";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Literal (Next lo lee sin ejecutar el módulo); igual a ANURA_MAINTENANCE_MAX_DURATION_S.
export const maxDuration = 60;

async function run(req: NextRequest) {
  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`.
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (process.env.VERCEL_ENV !== "production" && !dry) {
    return NextResponse.json({ skipped: "not_production" });
  }

  let report;
  try {
    report = await runAnuraMaintenance(createAdminSupabase(), { dry });
  } catch {
    // `runAnuraMaintenance` no lanza; esto es la red de seguridad. Sin el
    // mensaje: un error de la base puede citar valores.
    const error = "Error de la pasada de Anura.";
    console.log(`[anura-recordings] ${JSON.stringify({ dry, error })}`);
    return NextResponse.json({ ok: false, dry, error }, { status: 500 });
  }

  // Vercel no guarda la respuesta del cron. Solo conteos y motivos fijos.
  console.log(`[anura-recordings] ${JSON.stringify(report)}`);
  return NextResponse.json(report, { status: report.ok ? 200 : 502 });
}

export const GET = run;
export const POST = run;
