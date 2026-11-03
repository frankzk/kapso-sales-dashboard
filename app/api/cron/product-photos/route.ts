// La copia de las fotos de producto de WhatsApp a Storage (MOM §39, 23-10-2026).
//
// Shopify cierra Kenku Perú y Aurela el 28-10-2026 y su CDN dejará de servir las
// fotos que /api/wa-image pone en la cabecera de las plantillas. Cada hora, en
// el minuto 48 (`48 * * * *` en vercel.json), copia al bucket privado
// `product-photos` las fotos del espejo `shopify_product_images` que todavía no
// tienen copia para su URL actual (lib/product-photos-copy.ts). Lo ya copiado
// no se baja ni se sube otra vez; nada se pisa ni se borra. Trabaja hasta 90 s
// (`PRODUCT_PHOTO_COPY_BUDGET_MS`) y lo que no cupo sigue a la hora siguiente.
//
//   ?dry=1          solo cuenta, por tienda, cuántas fotos hay, cuántas ya
//                   tienen copia y cuántas faltan, sin bajar ni subir nada.
//   ?storeId=<uuid> solo esa tienda.
//
// Fuera de producción no copia (un preview subiría al bucket real, y una copia
// no se pisa nunca); con ?dry=1 sí corre.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { copyProductPhotos } from "@/lib/product-photos-copy";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Literal (Next lo lee sin ejecutar el módulo); igual a PRODUCT_PHOTO_COPY_MAX_DURATION_S.
export const maxDuration = 120;

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
    report = await copyProductPhotos(createAdminSupabase(), { dry, ...(storeId ? { storeId } : {}) });
  } catch {
    // `copyProductPhotos` no lanza; esto es la red de seguridad. Sin el mensaje:
    // un error de la base puede citar valores.
    const error = "Error de la pasada de fotos de producto.";
    console.log(`[product-photos] ${JSON.stringify({ dry, error })}`);
    return NextResponse.json({ ok: false, dry, error }, { status: 500 });
  }

  // Vercel no guarda la respuesta del cron. Solo ids de tienda, conteos y
  // motivos cortos: ni URLs, ni títulos de producto.
  console.log(`[product-photos] ${JSON.stringify(report)}`);
  return NextResponse.json(report, { status: report.ok ? 200 : 502 });
}

export const GET = run;
export const POST = run;
