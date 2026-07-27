import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { refreshAliclikOrder, statusFingerprint } from "@/lib/aliclik-track";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receptor de los avisos de estado de Aliclik.
//
// Configurar en el panel de Aliclik como:
//   {SITE}/api/webhooks/aliclik/<storeId>?secret=<ALICLIK_WEBHOOK_SECRET>
//
// AUTENTICACIÓN. La API de Aliclik NO firma sus notificaciones: su
// documentación define el payload {orderNumber, dispatchStatus, status,
// callStatus} y ninguna cabecera de autenticación, ni HMAC, ni IPs. El panel sí
// acepta una URL libre, así que el secreto viaja en la URL y se compara en
// tiempo constante — el mismo patrón que el webhook de Kapso. A diferencia de
// aquel, aquí NO hay respaldo con CRON_SECRET: una integración nueva no debe
// heredar una concesión que solo existe por compatibilidad.
//
// EL PAYLOAD NO SE CREE. No se escribe el estado que llega en el cuerpo. Se
// registra el aviso (append-only, con huella única = idempotencia) y se vuelve a
// preguntar por GET /integration/order, cuyo `updatedAt` sí permite descartar lo
// que llegue en desorden — que la documentación advierte que pasa. Como efecto
// lateral, un aviso falsificado, como mucho, nos hace releer la verdad.

const readSecret = (req: NextRequest): string | null =>
  req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");

/** Comparación en tiempo constante; longitudes distintas nunca son iguales. */
function secretEquals(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;

  const creds = await getStoreCreds(storeId);
  if (!creds) return new NextResponse("unauthorized", { status: 401 });
  if (!secretEquals(readSecret(req), creds.aliclik_webhook_secret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const orderNumber = String(body.orderNumber ?? "").trim();
  if (!orderNumber) {
    return NextResponse.json({ ok: false, error: "falta orderNumber" }, { status: 400 });
  }

  const status = body.status == null ? null : String(body.status);
  const callStatus = body.callStatus == null ? null : String(body.callStatus);
  const dispatchStatus = body.dispatchStatus == null ? null : String(body.dispatchStatus);

  const admin = createAdminSupabase();
  const fingerprint = statusFingerprint({ orderNumber, status, callStatus, dispatchStatus });

  // La idempotencia que pide la documentación: el mismo estado reenviado choca
  // con el único y no vuelve a consultar la API.
  const { error: insErr } = await admin.from("aliclik_webhook_events").insert({
    store_id: storeId,
    order_number: orderNumber,
    fingerprint,
    status,
    call_status: callStatus,
    dispatch_status: dispatchStatus,
    payload: body,
  });
  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
  }

  if (!creds.aliclik_api_token) {
    // Sin token no se puede releer. El aviso queda registrado igualmente: es
    // justo el rastro que hace falta para entender por qué no se aplicó.
    return NextResponse.json({ ok: true, applied: false, reason: "sin token" });
  }

  const result = await refreshAliclikOrder(orderNumber, { apiToken: creds.aliclik_api_token }, admin);

  // Siempre 2xx cuando el aviso se aceptó: un fallo NUESTRO al releer no debe
  // provocar reintentos de Aliclik — el cron de reconciliación lo recupera.
  return NextResponse.json({ ok: true, applied: result.outcome === "applied", outcome: result.outcome });
}

// Algunos proveedores validan el endpoint con un GET. Se autoriza igual, así el
// ping sirve además para comprobar que el secreto pegado es el correcto.
export async function GET(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const creds = await getStoreCreds(storeId);
  if (!creds || !secretEquals(readSecret(req), creds.aliclik_webhook_secret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
