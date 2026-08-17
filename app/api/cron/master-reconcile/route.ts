import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { budgetShareMs, reconcileOrderMaster } from "@/lib/order-master";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// El barrido del Master, con reloj propio.
//
// POR QUÉ ES UN CRON APARTE. Vivía en la ÚLTIMA línea de `runStoreSync`, y las
// tiendas se recorren en serie bajo un solo `maxDuration`:
//
//     for (const id of storeIds) await runStoreSync(id, admin);
//
// Delante del barrido van el tirón de Shopify, el de Kapso, los números de
// WhatsApp y los rollups. Sin reparto de reloj, la segunda tienda hereda lo que
// la primera no gastó, y lo primero que muere cuando se acaba es justo la última
// línea de la segunda.
//
// NO ES UNA SOSPECHA, ESTÁ MEDIDO (17-08-2026). Con la cuarta puerta ya
// desplegada, el atraso global bajó de 955 pedidos a ~200 y ahí se quedó. Al
// agrupar los que no drenaban salió UNA sola fila: **Kenku Peru, 207 pedidos,
// 50 horas de desfase medio**. Aurela, cero. Misma regla, mismo código, mismas
// dos tiendas activas — a una no le llegaba nunca. Se descartaron antes las
// otras cuatro explicaciones: la tienda está activa, los pedidos existen
// (`sin_fila_en_orders = 0`), la versión es la vigente (`mom-v1.8`) y ninguno
// caía fuera del alcance de la página de guías.
//
// Y YA NOS HABÍA PASADO, con estas mismas palabras en aliclik-close/route.ts:
// «un trabajo colgado del final de otro más largo no tiene garantía de
// ejecutarse nunca». Aquella vez fueron la caducidad de huérfanas y el pase de
// rezagadas detrás de un bucle que agotaba el `maxDuration`. Esta vez fue el
// barrido del Master detrás de una sincronización completa. El arreglo es el
// mismo porque el defecto es el mismo: presupuesto propio, y repartido.
//
// LO QUE NO CAMBIA. La regla de qué está desfasado sigue viviendo entera en
// `reconcileOrderMaster` — este fichero solo decide CUÁNDO y CON CUÁNTO tiempo.
// Duplicar acá la definición de «viejo» sería el bug que este repositorio lleva
// media docena de incidentes pagando.

/** Corte por reloj, por debajo de `maxDuration`: el corte tiene que ser nuestro. */
const BUDGET_MS = 240_000;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

interface StoreReport {
  storeId: string;
  /** Pedidos que el barrido dio por desfasados en esta pasada. */
  requested: number;
  /** De esos, cuántos quedaron con su fila al día. */
  written: number;
  /** Los que reventaron. Si no es cero, hay etapas viejas y hay que mirar por qué. */
  failed: number;
  /** Los que no cupieron en el reloj. No es un fallo — vuelven en la siguiente
   *  pasada—, pero si nunca baja, el presupuesto se quedó corto. */
  deferred: number;
  /** Milisegundos que le tocaron a esta tienda. Se informa porque el reparto es
   *  justo lo que aquí se está arreglando: verlo evita volver a discutirlo. */
  budgetMs: number;
  error: string | null;
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const single = req.nextUrl.searchParams.get("storeId");
  const deadline = Date.now() + BUDGET_MS;

  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports: StoreReport[] = [];
  for (const [i, storeId] of storeIds.entries()) {
    // Lo que queda, entre las tiendas que faltan por barrer — esta incluida. Así
    // la última de la cola tiene su parte garantizada aunque la primera se pase
    // de tiempo, que es exactamente lo que no ocurría antes.
    const share = budgetShareMs(deadline - Date.now(), storeIds.length - i);
    const storeDeadline = Date.now() + share;

    const report: StoreReport = {
      storeId,
      requested: 0,
      written: 0,
      failed: 0,
      deferred: 0,
      budgetMs: Math.round(share),
      error: null,
    };
    reports.push(report);

    try {
      const done = await reconcileOrderMaster(admin, [storeId], { deadline: storeDeadline });
      report.requested = done.requested;
      report.written = done.written;
      report.failed = done.failed ?? 0;
      report.deferred = done.deferred ?? 0;
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({ ok: true, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
