import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { getStoreCreds } from "@/lib/ingest";
import { FlowClient } from "@/lib/flow/client";
import { confirmFlowPayment } from "@/lib/flow/confirm";

// Receptor de las confirmaciones de pago de Flow.cl.
//
// NO CONFUNDIR CON `app/api/webhooks/flow/`, que es Shopify Flow —carritos
// abandonados—. Son dos integraciones distintas que se llaman igual; ésta es
// la pasarela que cobra. La colisión de nombres ya vive en la base de datos
// (`stores.flow_webhook_secret_enc` es de la otra), así que aquí todo lleva
// `flowcl`.
//
// Se le pasa a Flow como `urlConfirmation` al crear cada cobro:
//   {SITE}/api/webhooks/flowcl/<storeId>?secret=<flowcl_webhook_secret de la tienda>
//
// No se configura en ningún panel de Flow: viaja en cada petición, y por eso
// el secreto puede ser POR TIENDA (0161) como los de Kapso y Aliclik.
//
// EL AVISO NO SE CREE. Flow manda un POST con un solo parámetro, `token`, sin
// firma y sin monto. Eso no dice que algo esté pagado: dice «mira otra vez».
// Lo que se escribe sale de consultar `payment/getStatus`, que va firmado con
// el secretKey. Por eso un aviso falsificado, como mucho, nos hace releer la
// verdad — el secreto de la URL es una puerta, no la cerradura.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readSecret = (req: NextRequest): string | null =>
  req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");

/** Comparación en tiempo constante; longitudes distintas nunca son iguales. */
function secretEquals(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// GET: ping para validar la URL desde el navegador sin mandar un aviso real.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  return NextResponse.json({ ok: true, endpoint: "flowcl", storeId });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;

  // LAS CREDENCIALES SON DE ESTA TIENDA, no del entorno: la cuenta de Flow
  // decide en qué banco cae el dinero, así que no se comparte entre tiendas de
  // distinto titular. Y no hay respaldo a una cuenta global — una tienda mal
  // configurada tiene que fallar, no cobrar en la cuenta de otro.
  const creds = await getStoreCreds(storeId);
  if (!creds) return new NextResponse("unauthorized", { status: 401 });
  if (!secretEquals(readSecret(req), creds.flowcl_webhook_secret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  if (!creds.flowcl_api_key || !creds.flowcl_secret_key) {
    // Sin credenciales no se puede consultar el estado, y sin consultarlo no
    // se escribe nada. Un 500 hace que Flow reintente, que es lo correcto:
    // el aviso es bueno, lo que falta es configuración nuestra.
    return NextResponse.json({ ok: false, error: "Flow.cl sin configurar" }, { status: 500 });
  }

  // Flow notifica como `application/x-www-form-urlencoded`.
  let token = "";
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "").trim();
  } catch {
    token = "";
  }

  if (!token) {
    // Un aviso sin token no se puede procesar nunca: 400 para que Flow no
    // reintente indefinidamente algo que no va a mejorar.
    return NextResponse.json({ ok: false, error: "falta token" }, { status: 400 });
  }

  try {
    const result = await confirmFlowPayment(token, {
      admin: createAdminSupabase(),
      client: new FlowClient({
        apiKey: creds.flowcl_api_key,
        secretKey: creds.flowcl_secret_key,
        baseUrl: env.flowclApiBase(),
      }),
    });

    // Solo la FORMA, nunca el token ni datos del pagador: este log se lee en
    // Vercel y el token abre el link de pago.
    console.log(
      "[flowcl-webhook]",
      JSON.stringify({ storeId, outcome: result.outcome, linkId: result.linkId ?? null }),
    );

    switch (result.outcome) {
      case "registrado":
      case "duplicado":
      case "sin_pagar":
        return NextResponse.json({ ok: true, outcome: result.outcome });
      case "desconocido":
        // 200 a propósito: el aviso se entendió y no hay nada que hacer con
        // él. Un 4xx haría a Flow reintentar un token que nunca será nuestro.
        return NextResponse.json({ ok: true, outcome: result.outcome });
      case "sin_registrar":
        // El dinero entró y el comprobante no cupo. Queda anotado en el link
        // con su `register_error`; 200 porque reintentar no lo va a arreglar
        // —haría falta que alguien mire—, y 5xx solo llenaría de reintentos.
        console.error("[flowcl-webhook] pago sin registrar", result.message);
        return NextResponse.json({ ok: true, outcome: result.outcome });
    }
  } catch (e) {
    // 5xx: fallo transitorio (Flow caído, red, base de datos). Que reintente.
    const message = e instanceof Error ? e.message : "internal error";
    console.error("[flowcl-webhook] error", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
