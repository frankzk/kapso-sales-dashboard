// Barrido de comprobantes electrónicos por RUC (MOM §35).
//
// Cada 10 minutos, desfasado de los demás barridos para no caer en el mismo
// minuto que el sync ni que el recálculo del Master. Por organización con un
// RUC en simulación o en real revisa sus pedidos pagados (§35.3), vuelve a
// leerlos en Shopify, pide el turno en la base (`invoice_claim`) y simula o
// emite en SimpleFact; después concilia lo que quedó sin respuesta (§35.4).
//
//   ?dry=1          revisa, lee en Shopify y arma la boleta, sin escribir nada
//                   en la base ni llamar a SimpleFact (tampoco concilia). Sirve
//                   para medir qué saldría antes de encender un RUC.
//   ?storeId=<uuid> solo esa tienda.
//
// Fuera de producción no emite (un preview no manda boletas a SUNAT aunque se
// copien las credenciales); con ?dry=1 sí corre, para probar.
//
// Sin la migración 0257 o la 0258 (el código puede llegar a producción antes
// que ellas, que se aplican a mano) responde 200 con `skipped: "sin_migracion"`:
// no hay nada que barrer, y un cron rojo cada 10 minutos solo taparía lo que sí
// falla. Solo si lo que falta es de la 0257 o la 0258
// (`isInvoiceMigrationMissing`): otra tabla que no existe es una base rota, y el
// cron se ve rojo.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { isInvoiceMigrationMissing, runInvoiceSweep } from "@/lib/invoicing/server";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El log no lleva celulares: un error de la base puede citar uno. */
function sinTelefonos(text: string): string {
  return text.replace(/(?<!\d)(?:\+?51[\s-]?)?9\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g, "[número]").slice(0, 300);
}

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
    report = await runInvoiceSweep(createAdminSupabase(), { dry, ...(storeId ? { storeId } : {}) });
  } catch (err) {
    // El barrido ya lo convierte en `skipped`; esto cubre lo que lance antes.
    if (isInvoiceMigrationMissing(err)) {
      const skipped = { ok: true, dry, skipped: "sin_migracion" as const };
      console.log(`[invoices] ${JSON.stringify(skipped)}`);
      return NextResponse.json(skipped);
    }
    const error = sinTelefonos(err instanceof Error ? err.message : "Error del barrido de comprobantes");
    console.log(`[invoices] ${JSON.stringify({ dry, error })}`);
    return NextResponse.json({ ok: false, dry, error }, { status: 500 });
  }

  // Vercel no guarda la respuesta del cron: sin esta línea, «no emitió nada» no
  // se distingue de «nada era elegible», de «todo bloqueado por X» ni de «la
  // lista de candidatos vino llena» (`lleno`). Solo ids de organización y de
  // RUC, códigos de motivo y conteos: ni clientas, ni teléfonos, ni el token.
  console.log(`[invoices] ${JSON.stringify(report)}`);
  // Como Swayp automático: si algo falló, el cron se ve rojo.
  const failed = report.errors.length > 0;
  return NextResponse.json({ ok: !failed, ...report }, { status: failed ? 502 : 200 });
}

export const GET = run;
export const POST = run;
