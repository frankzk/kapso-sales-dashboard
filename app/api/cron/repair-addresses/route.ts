// Cron: recupera de Shopify las direcciones que faltan en la cola despachable.
//
// El panel repara el pedido al abrirlo y el Excel al generarlo, pero eso deja
// sin dirección a todo lo que nadie toca. Durante meses la app sincronizó
// pedidos con el bloque de envío traído solo con el teléfono (Shopify no
// devolvía el resto hasta que se habilitó el acceso a datos protegidos del
// cliente), así que el destino existe en Shopify pero no en la copia local.
//
// Cada corrida toma una tanda de los menos recientemente intentados y para ahí.
// No hace falta terminar en una sola pasada: lo reparado deja de calificar y la
// siguiente corrida sigue con el resto.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import {
  repairOrderAddresses,
  isShopifyOrderId,
  type AddressRepairTarget,
} from "@/lib/address-repair";
import { hasDeliverableAddress, shopifyShippingAddress } from "@/lib/shopify-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Las guías que aún se pueden despachar. Entregado/anulado/transferido ya no
// necesitan dirección, y reconsultarlas sería gastar cuota de Shopify.
const REPAIRABLE_CATEGORIES = ["pending", "in_route"];
// Pedidos por corrida. A 8 en paralelo son unos segundos, muy lejos del
// maxDuration, y el atraso inicial se drena en pocas corridas.
const BATCH = 300;
// Un pedido que Shopify tampoco tiene con calle no mejora por insistir: se
// reintenta recién a la semana, así el estado estable no gasta llamadas.
const RETRY_AFTER_DAYS = 7;

/** Constant-time equality (length-gated) to avoid leaking the secret via timing. */
function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

type CandidateOrder = {
  id: string;
  store_id: string;
  shopify_order_id: string | null;
  raw: unknown;
};

async function run(req: NextRequest) {
  if (!authorized(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const admin = createAdminSupabase();
  const cutoff = new Date(Date.now() - RETRY_AFTER_DAYS * 86_400_000).toISOString();

  // Pedidos con alguna guía despachable sin dirección propia, cuya copia local
  // no tiene calle. El filtro sobre el JSON deja el trabajo en la base: solo
  // viaja la tanda que de verdad se va a reparar.
  //
  // Una dirección propia en la guía (importada de Aliclik o corregida a mano)
  // manda sobre Shopify, por eso el join exige delivery_address nula.
  const { data, error } = await admin
    .from("orders")
    .select("id,store_id,shopify_order_id,raw,shipments!inner(id)")
    .in("shipments.status_category", REPAIRABLE_CATEGORIES)
    .is("shipments.delivery_address", null)
    .is("raw->shippingAddress->>address1", null)
    .or(`address_repair_attempted_at.is.null,address_repair_attempted_at.lt.${cutoff}`)
    .order("address_repair_attempted_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const candidates = (data as CandidateOrder[] | null) ?? [];
  const targets: AddressRepairTarget[] = [];
  for (const order of candidates) {
    // El filtro JSON no distingue calle vacía de ausente: se confirma acá.
    if (hasDeliverableAddress(shopifyShippingAddress(order.raw))) continue;
    if (!isShopifyOrderId(order.shopify_order_id)) continue;
    targets.push({
      orderId: order.id,
      storeId: order.store_id,
      shopifyOrderId: order.shopify_order_id,
    });
  }

  const outcome = await repairOrderAddresses(targets, admin);

  // Sellar toda la tanda mirada — reparada, sin calle en Shopify o descartada
  // acá — para que la próxima corrida avance al siguiente grupo en vez de
  // repetir este. Sellar solo lo intentado dejaría a los descartados volviendo
  // en cada corrida y ocupando lugar de los que sí se pueden reparar.
  if (candidates.length) {
    await admin
      .from("orders")
      .update({ address_repair_attempted_at: new Date().toISOString() })
      .in(
        "id",
        candidates.map((candidate) => candidate.id),
      );
  }

  return NextResponse.json({
    ok: true,
    candidatos: candidates.length,
    intentados: targets.length,
    reparados: outcome.repaired,
    sinDireccionEnShopify: outcome.stillMissing,
    fallidos: outcome.failed,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
