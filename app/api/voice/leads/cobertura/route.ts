// Tool `consultar_cobertura` del agente de voz para leads (MOM §33).
//
// La persona dice dónde vive y el agente pregunta aquí cómo le llega: la misma
// cobertura del Master (`order_coverage_for`), no una lista propia. Responde
// qué decir (contraentrega, o agencia con adelanto de `lib/adelanto-minimo`);
// el agente nunca pide ni recibe el pago. Solo lee: no escribe nada.
//
//   POST https://<kapta>/api/voice/leads/cobertura
//   x-voice-secret: <VOICE_LEADS_TOOLS_SECRET>
//   { voice_call_id, distrito, provincia?, departamento? }

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { coberturaParaAgente } from "@/lib/voice-leads";
import { bindLeadCall, leadToolAuthorized, leadVoiceCoverage } from "@/lib/voice-leads-server";
import { readToolBody } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  if (!leadToolAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }
  const body = await readToolBody(req);
  const admin = createAdminSupabase();
  const now = new Date();

  // La llamada dice de qué tienda es la cobertura (cada tienda tiene sus
  // excepciones de distrito y sus tarifas).
  const bound = await bindLeadCall(admin, body.voice_call_id, "open", now);
  if ("error" in bound) {
    // Sin tienda no hay cobertura que mirar: el agente dice que una asesora la confirma.
    return NextResponse.json({ ok: false, error: bound.error, ...coberturaParaAgente(null) });
  }
  const cobertura = await leadVoiceCoverage(
    admin,
    bound.call.store_id,
    { distrito: body.distrito, provincia: body.provincia, departamento: body.departamento },
    now,
  );
  return NextResponse.json({ ok: true, ...cobertura });
}
