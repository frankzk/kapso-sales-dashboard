// La foto de los pedidos de Shopify para sus boletas (MOM §35.10, owner
// 23-10-2026).
//
// Shopify cierra Kenku Perú y Aurela el 28-10-2026. Cada 10 minutos, mientras
// Shopify responde, guarda lo que la boleta leería de cada pedido que todavía
// puede necesitarla (lib/invoicing/snapshots.ts), para emitirla desde esa foto
// cuando Shopify ya no conteste. En los minutos 4, 14, 24, 34, 44 y 54: lejos
// del sync (cada 5) y del barrido de boletas (6, 16…), que también leen
// Shopify, y termina antes de que empiecen.
//
//   ?dry=1          solo cuenta cuántos pedidos faltan por tienda, sin llamar a
//                   Shopify ni escribir nada.
//   ?storeId=<uuid> solo esa tienda.
//
// Fuera de producción no llama a Shopify (un preview gastaría el cupo de las
// tiendas reales); con ?dry=1 sí corre.
//
// Sin la 0274 (el código puede llegar a producción antes que ella, que se aplica
// a mano) responde 200 con `skipped: "sin_migracion"`.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { isInvoiceSnapshotMigrationMissing, runInvoiceSnapshotSweep } from "@/lib/invoicing/snapshots";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(req: NextRequest) {
  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`.
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const storeId = req.nextUrl.searchParams.get("storeId");
  if (storeId !== null && !UUID_RE.test(storeId)) {
    return NextResponse.json({ ok: false, error: "storeId inválido" }, { status: 400 });
  }
  if (process.env.VERCEL_ENV !== "production" && !dry) {
    return NextResponse.json({ skipped: "not_production" });
  }

  let report;
  try {
    report = await runInvoiceSnapshotSweep(createAdminSupabase(), { dry, ...(storeId ? { storeId } : {}) });
  } catch (err) {
    if (isInvoiceSnapshotMigrationMissing(err)) {
      const skipped = { ok: true, dry, skipped: "sin_migracion" as const };
      console.log(`[invoice-snapshots] ${JSON.stringify(skipped)}`);
      return NextResponse.json(skipped);
    }
    // Sin el mensaje: un error de la base puede citar valores.
    const error = "Error de la pasada de fotos de pedidos.";
    console.log(`[invoice-snapshots] ${JSON.stringify({ dry, error })}`);
    return NextResponse.json({ ok: false, dry, error }, { status: 500 });
  }

  // Vercel no guarda la respuesta del cron. Solo ids de tienda, conteos y
  // motivos cortos: ni pedidos, ni clientas, ni el token.
  console.log(`[invoice-snapshots] ${JSON.stringify(report)}`);
  const failed = report.errors.length > 0;
  return NextResponse.json({ ok: !failed, ...report }, { status: failed ? 502 : 200 });
}

export const GET = run;
export const POST = run;
