import { NextResponse, type NextRequest } from "next/server";
import {
  metaSocialConfigured,
  metaSocialVerifyConfigured,
  processMetaSocialWebhook,
  verifyChallenge,
} from "@/lib/meta-social-ingest";
import { env } from "@/lib/env";

// Needs Node crypto (HMAC + constant-time compare) and the service-role client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receptor de los webhooks de página de Facebook y de Instagram. Es una SONDA:
// guarda las entregas y no interpreta nada. Ver la cabecera de
// db/migrations/0124_meta_social_webhook_log.sql para el porqué.
//
// Se da de alta en la app de Meta (Webhooks → Page / Instagram):
//   Callback URL   {NEXT_PUBLIC_SITE_URL}/api/webhooks/meta-social
//   Verify Token   <META_WEBHOOK_VERIFY_TOKEN>   ← lo inventas tú
//   Campos         `feed` en Page · `comments` en Instagram
//
// NO es por tienda, y no por descuido: Meta lo configura por APP, así que una
// sola URL cubre Aurela y Kenku. La tienda tendrá que salir de `entry[].id`, que
// es uno de los datos que esta sonda viene a recoger — escribirla a ciegas
// mandaría los comentarios de una tienda a la bandeja de la otra.

/**
 * Apretón de manos de verificación. Meta llama por GET con `hub.mode`,
 * `hub.verify_token` y `hub.challenge`, y NO empieza a enviar hasta que se le
 * devuelve el challenge tal cual, en texto plano.
 *
 * Sin `hub.mode` la llamada no es de Meta: es una persona comprobando la URL
 * desde el navegador, y ahí se responde el health-check — la URL se pega a mano
 * en un panel y conviene poder verificar ANTES de darle a Guardar que el destino
 * existe y que las dos variables están cargadas. No revela ninguna: solo si
 * están presentes.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");

  if (mode) {
    const result = verifyChallenge({
      mode,
      token: url.searchParams.get("hub.verify_token"),
      challenge: url.searchParams.get("hub.challenge"),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: "verification_failed", reason: result.reason }, { status: 403 });
    }
    // Texto plano y sin comillas: Meta compara el cuerpo con su challenge, así
    // que devolverlo como JSON (`"1234"` con comillas) hace fallar el alta.
    return new NextResponse(result.challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return NextResponse.json({
    ok: true,
    endpoint: "meta-social-webhook",
    appSecretConfigured: metaSocialConfigured(),
    verifyTokenConfigured: metaSocialVerifyConfigured(),
    configure: {
      callbackUrl: `${env.siteUrl()}/api/webhooks/meta-social`,
      verifyToken: "<META_WEBHOOK_VERIFY_TOKEN>",
      fields: { page: ["feed"], instagram: ["comments"] },
    },
    note: "Sonda: registra las entregas sin interpretarlas. No responde comentarios.",
  });
}

export async function POST(req: NextRequest) {
  // Se lee como TEXTO y se firma tal cual: `req.json()` parsea y cualquier
  // re-serialización posterior cambiaría el cuerpo y tiraría el HMAC al suelo.
  // Además, un cuerpo mal formado haría lanzar a `json()` y perderíamos la
  // entrega — y de las entregas perdidas no hay forma de pedir copia.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "unreadable body" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  try {
    const result = await processMetaSocialWebhook({ headers, rawBody });
    if (result.status === "unauthorized") {
      return NextResponse.json(
        {
          ok: false,
          error: "unauthorized",
          reason: result.reason,
          hint:
            result.reason === "not_configured"
              ? "META_APP_SECRET no está configurado en este entorno."
              : result.reason === "missing_signature"
                ? "Falta la cabecera X-Hub-Signature-256. ¿Seguro que la llamada viene de Meta?"
                : "La firma no corresponde al cuerpo: revisa que META_APP_SECRET sea el App Secret de ESTA app.",
        },
        { status: 401 },
      );
    }
    if (result.status === "error") {
      return NextResponse.json({ ok: false, error: result.reason }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}
