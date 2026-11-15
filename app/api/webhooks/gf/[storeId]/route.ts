import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { gfCourier, verifyGfWebhook, type GfWebhookEnvelope } from "@/lib/gf-courier";
import { loadGfStore } from "@/lib/gf-courier-guide";
import { applyGfSnapshot } from "@/lib/gf-courier-track";
import { gfWebhookNote } from "@/lib/gf-webhook-note";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receptor de webhooks de GF Courier (MOM §29.17). Se registra en GF por tienda:
//   POST {GF}/v1/webhooks  { url: "{SITE}/api/webhooks/gf/<storeId>", events: ["order.*"], secret }
// con el mismo secreto guardado cifrado en stores.gf_courier_webhook_secret_enc.
//
// AUTENTICACIÓN. GF firma: X-GF-Signature = v1=HMAC_SHA256(secret, X-GF-Timestamp + "." + cuerpo crudo). Se verifica
// sobre el cuerpo CRUDO antes de parsear, en tiempo constante, y se rechaza un timestamp de más de 5 minutos.
// IDEMPOTENCIA. X-GF-Event-Id es único en gf_webhook_events (append-only): un reintento de GF choca y responde 200.
// EL PAYLOAD NO SE CREE. Igual que con Aliclik, el aviso solo dispara una relectura de GET /v1/orders/{tracking}:
// lo que se aplica es el estado ACTUAL de GF, así que un evento atrasado no retrocede la guía.
export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const raw = await req.text();
  const admin = createAdminSupabase();
  const store = await loadGfStore(admin, storeId);
  if (!store?.webhookSecret || !store.token) return NextResponse.json({ error: "not_configured" }, { status: 404 });
  const check = verifyGfWebhook(raw, { signature: req.headers.get("x-gf-signature"), timestamp: req.headers.get("x-gf-timestamp") }, store.webhookSecret);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });

  let envelope: GfWebhookEnvelope;
  try { envelope = JSON.parse(raw) as GfWebhookEnvelope; } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
  const eventId = req.headers.get("x-gf-event-id") ?? envelope.id;
  if (!eventId || eventId !== envelope.id) return NextResponse.json({ error: "event_id_mismatch" }, { status: 400 });
  const tracking = typeof envelope.data?.tracking_id === "string" ? envelope.data.tracking_id : null;

  const log = async (outcome: string) => admin.from("gf_webhook_events").insert({ event_id: eventId, store_id: storeId, type: envelope.type,
    tracking_id: tracking, payload: envelope, outcome });
  if (envelope.type === "webhook.test" || !tracking || !envelope.type.startsWith("order.")) {
    const { error } = await log("ignored");
    return NextResponse.json({ ok: true, outcome: error?.code === "23505" ? "duplicate" : "ignored" });
  }
  // Primero la relectura y la aplicación; después el registro con su resultado. Si el registro choca (23505), el
  // evento ya se había procesado: aplicar otra vez es inofensivo porque se aplica el estado actual, no el del aviso.
  const current = await gfCourier.getOrder({ apiToken: store.token }, tracking);
  if (!current.ok) {
    await log("error");
    // 5xx para que GF reintente más tarde si el problema es de lectura; 200 si GF dice que no existe.
    return NextResponse.json({ ok: false, error: current.error.code }, { status: current.status === 404 ? 200 : 502 });
  }
  const applied = await applyGfSnapshot(current.data, admin);
  const { error } = await log(applied.outcome);
  // Un aviso con motivo («No respondió antes de salir (1 de 2)», la anulación) deja su línea en el historial. Solo la
  // primera entrega del evento: un reenvío choca con el registro único y no la duplica.
  const note = gfWebhookNote(envelope);
  if (note && !error && applied.orderId) {
    const order = await admin.from("orders").select("store_id").eq("id", applied.orderId).maybeSingle();
    await admin.from("order_events").insert({ store_id: order.data?.store_id ?? storeId, order_id: applied.orderId, kind: "courier_report",
      occurred_at: new Date().toISOString(), actor: null, source: "gf_courier", courier: "gf_courier", guide_code: tracking, note });
  }
  return NextResponse.json({ ok: applied.ok, outcome: error?.code === "23505" ? "duplicate" : applied.outcome }, { status: applied.ok || applied.outcome === "unknown_order" ? 200 : 500 });
}
