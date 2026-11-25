import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { normalizeZernioEvent } from "@/lib/social-inbox";
import { verifyZernioSignature } from "@/lib/zernio-signature";
import { applySocialEvent } from "@/lib/social-inbox-store";
import { runSocialAutoReplies } from "@/lib/social-auto-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receptor de los avisos de Zernio: comentarios y mensajes directos de Facebook
// e Instagram para Leads → Redes (MOM §25.4). Se registra en Zernio (Webhooks)
// con esta URL y el mismo secreto que `ZERNIO_WEBHOOK_SECRET` en Vercel.
//
// AUTENTICACIÓN. `X-Zernio-Signature` = HMAC-SHA256 hex del cuerpo CRUDO; se
// verifica antes de leer el JSON. Una firma mala responde 401.
// IDEMPOTENCIA. El `id` del aviso (= `X-Zernio-Event-Id`) es único en
// `social_webhook_events`: Zernio reintenta hasta 7 veces y un repetido responde
// 200 sin volver a aplicarse.
// NUNCA 4xx A UN AVISO VÁLIDO: Zernio da por muerto el aviso ante un 4xx (salvo
// 408 y 429). Si falla guardar, 500 para que reintente; si falla aplicarlo, queda
// guardado con su error y se responde 200 (se reprocesa desde la base).
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyZernioSignature(raw, req.headers.get("x-zernio-signature"), process.env.ZERNIO_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true, outcome: "bad_json" });
  }
  const eventId = (typeof payload.id === "string" && payload.id) || req.headers.get("x-zernio-event-id");
  const event = typeof payload.event === "string" ? payload.event : req.headers.get("x-zernio-event") ?? "desconocido";
  if (!eventId) return NextResponse.json({ ok: true, outcome: "sin_id" });

  const admin = createAdminSupabase();
  const account = (payload.account && typeof payload.account === "object" ? payload.account : {}) as Record<string, unknown>;
  const accountId = typeof account.accountId === "string" ? account.accountId : typeof account.id === "string" ? account.id : null;
  const { error: insertError } = await admin.from("social_webhook_events").insert({ event_id: eventId, event, account_id: accountId, payload });
  if (insertError) {
    if (insertError.code === "23505") return NextResponse.json({ ok: true, outcome: "duplicate" });
    return NextResponse.json({ ok: false, error: "store_failed" }, { status: 500 });
  }

  let outcome = "ignored";
  let failure: string | null = null;
  try {
    const normalized = normalizeZernioEvent(payload);
    if (normalized) {
      const threadId = await applySocialEvent(admin, normalized);
      outcome = "applied";
      // Las respuestas automáticas (fase 3) van DESPUÉS de responder: Zernio pide un 2xx en 5 s.
      if (threadId) {
        after(async () => {
          try {
            await runSocialAutoReplies(createAdminSupabase(), normalized, threadId);
          } catch (e) {
            await createAdminSupabase().from("social_webhook_events").update({ error: `auto: ${e instanceof Error ? e.message : String(e)}` }).eq("event_id", eventId);
          }
        });
      }
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    outcome = "error";
  }
  await admin.from("social_webhook_events").update({ processed_at: new Date().toISOString(), error: failure }).eq("event_id", eventId);
  return NextResponse.json({ ok: true, outcome });
}
