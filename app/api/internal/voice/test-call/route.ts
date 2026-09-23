// Llamada de prueba del agente de voz (MOM §11.8, plan Fase 2).
//
// Toma un pedido REAL —para que el agente hable con una ficha de verdad—,
// llama al teléfono del PROBADOR y no escribe nada sobre el pedido: la fila de
// `voice_calls` va en `mode = 'test'` y las tools lo respetan.
//
//   POST /api/internal/voice/test-call
//   x-internal-secret: <CRON_SECRET>
//   { "order_id": "<uuid>" | "order_name": "#KP135098", "phone": "930555309" }
//
// No mira `voice_recovery_enabled`: probar tiene que poder hacerse con la cola
// apagada. Sí exige número de agente y extensión con caller ID peruano, igual
// que una llamada real: la prueba sirve si ensaya lo mismo que saldrá.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { zadarmaLocalPeru } from "@/lib/zadarma";
import {
  internalAuthorized,
  loadStoreVoiceConfig,
  placeVoiceCall,
} from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }
  let body: { order_id?: string; order_name?: string; phone?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "cuerpo inválido" }, { status: 400 });
  }

  const phone = zadarmaLocalPeru(body.phone);
  if (!phone) {
    return NextResponse.json({ ok: false, error: "phone debe ser un teléfono peruano" }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const now = new Date();

  let query = admin.from("orders").select("id, store_id, name");
  if (body.order_id) query = query.eq("id", body.order_id);
  else if (body.order_name) query = query.eq("name", body.order_name.trim());
  else return NextResponse.json({ ok: false, error: "falta order_id u order_name" }, { status: 400 });
  const { data: orders, error: orderError } = await query.limit(2);
  if (orderError) return NextResponse.json({ ok: false, error: orderError.message }, { status: 500 });
  if (!orders?.length) return NextResponse.json({ ok: false, error: "pedido no encontrado" }, { status: 404 });
  if (orders.length > 1) {
    return NextResponse.json({ ok: false, error: "ese nombre existe en varias tiendas; usa order_id" }, { status: 409 });
  }
  const order = orders[0] as { id: string; store_id: string; name: string };

  const store = await loadStoreVoiceConfig(admin, order.store_id);
  const agentNumber = store?.voice_recovery_agent_number?.trim();
  const sip = store?.voice_recovery_zadarma_sip?.trim();
  if (!agentNumber || !sip) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "La tienda no tiene configurado el número del agente o la extensión de Zadarma con caller ID peruano (stores.voice_recovery_agent_number / voice_recovery_zadarma_sip).",
      },
      { status: 400 },
    );
  }

  const placed = await placeVoiceCall(
    admin,
    {
      storeId: order.store_id,
      orderId: order.id,
      phone,
      mode: "test",
      triggeredBy: null,
      agentNumber,
      sip,
    },
    now,
  );
  if (!placed.ok) {
    return NextResponse.json(
      { ok: false, voice_call_id: placed.callId ?? null, error: placed.error },
      { status: placed.status },
    );
  }

  return NextResponse.json({
    ok: true,
    voice_call_id: placed.callId,
    order: order.name,
    from: placed.from,
    to: placed.to,
    note: "Zadarma marca primero al agente y después a este teléfono. Nada se escribe sobre el pedido.",
  });
}
