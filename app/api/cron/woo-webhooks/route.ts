// La revisión de los webhooks de WooCommerce (MOM §38.14, 25-10-2026).
//
// WooCommerce desactiva un webhook después de 5 fallos seguidos y no avisa a
// nadie: los pedidos siguen llegando por la pasada `woo_orders`, con retraso, y
// el Master no muestra nada raro. Cada hora, en el minuto 34 (`34 * * * *` en
// vercel.json, que no comparte con ningún otro barrido), lee la lista de
// webhooks de cada tienda ACTIVA con WooCommerce conectado
// (`GET /wp-json/wc/v3/webhooks`) y comprueba que los cuatro temas de pedido
// tengan uno «Activo» que entregue a esa tienda de Kapta
// (lib/woocommerce-webhooks-health.ts). El resultado queda en `sync_state`
// (fuente `woo_webhooks`) y, si algo falla, en `stores.woo_last_error`: lo
// muestra Ajustes → WooCommerce.
//
// SOLO LECTURA hacia WooCommerce: no crea, ni reactiva, ni cambia ningún
// webhook. Una tienda sin el sitio, la clave del sitio y las dos claves de la
// API no hace ni una llamada (una tienda solo de Shopify, por ejemplo). Hoy
// (25-10-2026) son dos: Aurela y Kenku, conectadas desde el 24-10.
//
//   ?dry=1          revisa y contesta, sin escribir nada en la base.
//   ?storeId=<uuid> solo esa tienda.
//
// Sin la 0274 (las columnas `woo_*`) responde 200 con `skipped: "sin_migracion"`.
// Si una tienda tiene un webhook mal o no se pudo revisar, 502: el cron se ve
// rojo, como el de comprobantes. La línea de log lleva ids de tienda, estados
// por tema y tipos de fallo: nunca direcciones, claves ni secretos.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { runWooWebhooksChecks } from "@/lib/woocommerce-webhooks-health";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Las tiendas van en paralelo; cada una para de pedir páginas a los 30 s
// (`WOO_WEBHOOKS_BUDGET_MS`) y cada llamada corta a los 15 s (`WOO_TIMEOUT_MS`).
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

  let report;
  try {
    report = await runWooWebhooksChecks(createAdminSupabase(), { dry, ...(storeId !== null ? { storeId } : {}) });
  } catch {
    // `runWooWebhooksChecks` no lanza; esto es la red de seguridad. Sin el
    // mensaje: un error de la base puede citar valores.
    const error = "Error de la revisión de los webhooks de WooCommerce.";
    console.log(`[woo-webhooks] ${JSON.stringify({ dry, error })}`);
    return NextResponse.json({ ok: false, dry, error }, { status: 500 });
  }

  // Vercel no guarda la respuesta del cron.
  console.log(`[woo-webhooks] ${JSON.stringify(report)}`);
  if (report.error) return NextResponse.json(report, { status: 500 });
  return NextResponse.json(report, { status: report.ok ? 200 : 502 });
}

export const GET = run;
export const POST = run;
