// Avisos de Anura para «Llamar con Anura» (fase 1, Click2Dial).
//
//   POST /api/webhooks/anura?org=<orgId>&t=<token>
//   Content-Type: application/json   (la plantilla de Ajustes › Telefonía Anura)
//
// El token se deriva de ENCRYPTION_KEY y la org (lib/anura/token.ts). Token
// malo → 401; todo lo demás → 200, para que Anura no reintente. La lógica, la
// bitácora y la copia de la grabación viven en lib/anura/webhook.ts.

import { NextResponse, after, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { ANURA_WEBHOOK_MAX_BYTES, handleAnuraWebhook } from "@/lib/anura/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// La respuesta sale en cuanto se aplica el aviso; la copia de la grabación
// (hasta 20 s) corre después con `after`.
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  const result = await handleAnuraWebhook(
    {
      org: req.nextUrl.searchParams.get("org"),
      token: req.nextUrl.searchParams.get("t"),
      authorization: req.headers.get("authorization"),
      // Un cuerpo de más no se procesa (queda «ignorado» en la bitácora).
      body: raw.length > ANURA_WEBHOOK_MAX_BYTES ? raw.slice(0, ANURA_WEBHOOK_MAX_BYTES + 1) : raw,
    },
    { admin: createAdminSupabase(), defer: (work) => after(work) },
  );
  return NextResponse.json(result.body, { status: result.status });
}
