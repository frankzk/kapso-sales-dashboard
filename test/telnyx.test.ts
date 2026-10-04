import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyTelnyxCost,
  agenteDialBody,
  agentSipUriFor,
  clienteDialBody,
  decodeClientState,
  encodeClientState,
  noAnswerResumen,
  parseTelnyxEvent,
  telnyxPeruE164,
  verifyTelnyxSignature,
} from "@/lib/telnyx";
import { pickTelephony, pickVoiceRoute } from "@/lib/voice-recovery";
import {
  VOICE_AGENT_ELEVENLABS_KEY,
  VOICE_AGENT_KEY,
  VOICE_AGENT_TELNYX_KEY,
  aggregateReproDay,
  reproDayActor,
} from "@/lib/shipments";

const cfg = {
  apiKey: "k",
  connectionId: "conn-1",
  fromNumber: "+19182386713",
  xaiSipUri: "sip:+19182386713@sip.voice.x.ai;transport=tls",
  elevenLabsSipUri: "sip:+19182386713@sip.rtc.elevenlabs.io:5061;transport=tls",
};

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { publicB64: Buffer.from(der.subarray(der.length - 32)).toString("base64"), privateKey };
}

describe("Agente Telnyx — cliente de Telnyx (MOM §11.8)", () => {
  it("marca solo a teléfonos peruanos, en E.164", () => {
    expect(telnyxPeruE164("930 555 309")).toBe("+51930555309");
    expect(telnyxPeruE164("+51 930555309")).toBe("+51930555309");
    expect(telnyxPeruE164("+1 918 238 6713")).toBeNull();
  });

  it("el client_state ida y vuelta, y basura → null", () => {
    const enc = encodeClientState({ vc: "abc", leg: "cliente" });
    expect(decodeClientState(enc)).toEqual({ vc: "abc", leg: "cliente" });
    expect(decodeClientState("no-es-base64-json")).toBeNull();
    expect(decodeClientState(encodeClientState({ vc: "x", leg: "otro" as "cliente" }))).toBeNull();
  });

  it("el tramo a la clienta lleva detección de contestadora y la fila", () => {
    const body = clienteDialBody(cfg, "vc-1", "+51930555309");
    expect(body).toMatchObject({ connection_id: "conn-1", to: "+51930555309", from: "+19182386713" });
    expect(body.answering_machine_detection).toBe("detect");
    expect(decodeClientState(body.client_state)).toEqual({ vc: "vc-1", leg: "cliente" });
  });

  it("el tramo a xAI se une al de la clienta, sin SIP REFER", () => {
    const body = agenteDialBody(cfg, "vc-1", "ccid-cliente");
    expect(body).toMatchObject({
      to: cfg.xaiSipUri,
      link_to: "ccid-cliente",
      bridge_intent: true,
      bridge_on_answer: true,
    });
    expect(decodeClientState(body.client_state)).toEqual({ vc: "vc-1", leg: "agente" });
    const src = readFileSync(resolve(__dirname, "../lib/telnyx.ts"), "utf8");
    expect(src).not.toMatch(/actions\/refer|actions\/transfer/);
  });

  it("el motor elige la puerta SIP: Grok (xAI) o ElevenLabs; sin puerta, null", () => {
    expect(agentSipUriFor(cfg, "grok")).toBe(cfg.xaiSipUri);
    expect(agentSipUriFor(cfg, "elevenlabs")).toBe(cfg.elevenLabsSipUri);
    expect(agentSipUriFor({ ...cfg, elevenLabsSipUri: "" }, "elevenlabs")).toBeNull();
    expect(agenteDialBody(cfg, "vc-1", "ccid", cfg.elevenLabsSipUri).to).toBe(cfg.elevenLabsSipUri);
  });

  it("acepta solo avisos firmados por la cuenta y recientes", () => {
    const { publicB64, privateKey } = keyPair();
    const now = new Date("2026-10-03T15:00:00Z");
    const ts = String(Math.floor(now.getTime() / 1000));
    const rawBody = JSON.stringify({ data: { event_type: "call.answered" } });
    const signature = sign(null, Buffer.from(`${ts}|${rawBody}`), privateKey).toString("base64");

    expect(verifyTelnyxSignature({ rawBody, signature, timestamp: ts, publicKey: publicB64, now })).toBe(true);
    // Cuerpo alterado, otra clave, sin firma, o un aviso viejo: fuera.
    expect(verifyTelnyxSignature({ rawBody: rawBody + " ", signature, timestamp: ts, publicKey: publicB64, now })).toBe(false);
    expect(verifyTelnyxSignature({ rawBody, signature, timestamp: ts, publicKey: keyPair().publicB64, now })).toBe(false);
    expect(verifyTelnyxSignature({ rawBody, signature: null, timestamp: ts, publicKey: publicB64, now })).toBe(false);
    const late = new Date(now.getTime() + 10 * 60_000);
    expect(verifyTelnyxSignature({ rawBody, signature, timestamp: ts, publicKey: publicB64, now: late })).toBe(false);
  });

  it("lee el aviso: tipo, tramo, causa del corte y contestadora", () => {
    const ev = parseTelnyxEvent({
      data: {
        event_type: "call.hangup",
        occurred_at: "2026-10-03T15:00:00Z",
        payload: {
          call_control_id: "ccid",
          client_state: encodeClientState({ vc: "vc-1", leg: "cliente" }),
          hangup_cause: "user_busy",
          hangup_source: "callee",
          sip_hangup_cause: "486",
        },
      },
    });
    expect(ev).toMatchObject({
      type: "call.hangup",
      callControlId: "ccid",
      state: { vc: "vc-1", leg: "cliente" },
      hangupCause: "user_busy",
      sipHangupCause: "486",
    });
    expect(noAnswerResumen(ev!)).toBe("No contestó: ocupado.");
    expect(noAnswerResumen({ hangupCause: "timeout", sipHangupCause: null })).toBe("No contestó: timbró sin respuesta.");
    expect(parseTelnyxEvent({})).toBeNull();
  });
});

describe("costo real de cada tramo (call.cost)", () => {
  const aviso = (leg: "cliente" | "agente", total: string) =>
    parseTelnyxEvent({
      data: {
        event_type: "call.cost",
        payload: {
          call_control_id: `ccid-${leg}`,
          client_state: encodeClientState({ vc: "vc-1", leg }),
          status: "success",
          total_cost: total,
          billed_duration_secs: 60,
          cost_parts: [
            { call_part: "call-control", cost: "0.002", currency: "USD", rate: "0.002", billed_duration_secs: 60 },
            { call_part: "sip-trunking", cost: "0.0353", currency: "USD", rate: "0.0353", billed_duration_secs: 60 },
          ],
        },
      },
    })!;

  it("lee el total, la moneda, los segundos y el desglose", () => {
    expect(aviso("cliente", "0.0373").cost).toEqual({
      total: 0.0373,
      currency: "USD",
      billedSecs: 60,
      status: "success",
      parts: [
        { parte: "call-control", costo: 0.002, tarifa: 0.002, segundos: 60 },
        { parte: "sip-trunking", costo: 0.0353, tarifa: 0.0353, segundos: 60 },
      ],
    });
    // Los demás avisos no traen costo.
    expect(parseTelnyxEvent({ data: { event_type: "call.answered", payload: {} } })?.cost).toBeNull();
  });

  it("suma los dos tramos y un aviso repetido no duplica", () => {
    let rec = applyTelnyxCost(null, "cliente", aviso("cliente", "0.0373").cost!);
    expect(rec).toMatchObject({ total: 0.0373, moneda: "USD" });
    rec = applyTelnyxCost(rec, "agente", aviso("agente", "0.004").cost!);
    expect(rec.total).toBe(0.0413);
    expect(applyTelnyxCost(rec, "agente", aviso("agente", "0.004").cost!).total).toBe(0.0413);
  });

  it("sin monto (status error) el total no inventa ceros", () => {
    const sinMonto = { total: null, currency: null, billedSecs: null, status: "error", parts: [] };
    expect(applyTelnyxCost(null, "cliente", sinMonto).total).toBeNull();
  });
});

describe("reparto Daaph contra Telnyx", () => {
  it("sin Telnyx configurado o con 0 %, todo va por Zadarma", () => {
    expect(pickTelephony(50, false, () => 0)).toBe("zadarma");
    expect(pickTelephony(0, true, () => 0)).toBe("zadarma");
  });
  it("con 50 %, la suerte decide", () => {
    expect(pickTelephony(50, true, () => 0.2)).toBe("telnyx");
    expect(pickTelephony(50, true, () => 0.8)).toBe("zadarma");
    expect(pickTelephony(100, true, () => 0.999)).toBe("telnyx");
  });
});

describe("reparto de los tres agentes (Daaph, Telnyx, ElevenLabs)", () => {
  const all = { telnyxShare: 33, elevenShare: 33, telnyxReady: true, elevenReady: true };
  it("cada tramo del azar va a su agente", () => {
    expect(pickVoiceRoute(all, () => 0.1)).toEqual({ telephony: "telnyx", engine: "grok" });
    expect(pickVoiceRoute(all, () => 0.5)).toEqual({ telephony: "telnyx", engine: "elevenlabs" });
    expect(pickVoiceRoute(all, () => 0.9)).toEqual({ telephony: "zadarma", engine: "grok" });
  });
  it("un agente sin configurar no recibe nada: su parte vuelve a Daaph", () => {
    expect(pickVoiceRoute({ ...all, elevenReady: false }, () => 0.5)).toEqual({ telephony: "zadarma", engine: "grok" });
    expect(pickVoiceRoute({ ...all, telnyxReady: false }, () => 0.1)).toEqual({ telephony: "zadarma", engine: "grok" });
  });
  it("sin porcentajes, todo por Zadarma; si suman más de 100, se recorta", () => {
    expect(pickVoiceRoute({ ...all, telnyxShare: 0, elevenShare: 0 }, () => 0)).toEqual({ telephony: "zadarma", engine: "grok" });
    expect(pickVoiceRoute({ ...all, telnyxShare: 80, elevenShare: 80 }, () => 0.95)).toEqual({ telephony: "telnyx", engine: "elevenlabs" });
  });
});

describe("«Hoy por asesora» separa los dos agentes", () => {
  it("la firma «Agente de voz (Telnyx)» es el Agente Telnyx; el resto, Daaph", () => {
    expect(reproDayActor({ agent: null, kind: "call", newStatus: null, shipmentId: "g", note: "Agente de voz (Telnyx) · No contestó" })).toBe(VOICE_AGENT_TELNYX_KEY);
    expect(reproDayActor({ agent: null, kind: "call", newStatus: null, shipmentId: "g", note: "Agente de voz · No contestó" })).toBe(VOICE_AGENT_KEY);
    expect(
      reproDayActor({
        agent: null,
        kind: "reroute",
        newStatus: "en_ruta",
        shipmentId: "g",
        note: "Excepción sobre guía anulada X. Motivo: Agente de voz (Telnyx): la clienta aceptó",
      }),
    ).toBe(VOICE_AGENT_TELNYX_KEY);
  });

  it("la firma «Agente de voz (ElevenLabs)» es el Agente ElevenLabs", () => {
    expect(reproDayActor({ agent: null, kind: "call", newStatus: null, shipmentId: "g", note: "Agente de voz (ElevenLabs) · confirma" })).toBe(VOICE_AGENT_ELEVENLABS_KEY);
    expect(
      reproDayActor({
        agent: null,
        kind: "reroute",
        newStatus: "en_ruta",
        shipmentId: "g",
        note: "Excepción sobre guía anulada X. Motivo: Agente de voz (ElevenLabs): la clienta aceptó",
      }),
    ).toBe(VOICE_AGENT_ELEVENLABS_KEY);
  });

  it("los dos agentes van al final, detrás de las asesoras", () => {
    const out = aggregateReproDay([
      { agent: null, kind: "call", newStatus: null, shipmentId: "a", note: "Agente de voz · x" },
      { agent: null, kind: "call", newStatus: null, shipmentId: "b", note: "Agente de voz (Telnyx) · x" },
      { agent: "u1", kind: "call", newStatus: null, shipmentId: "c" },
    ]);
    expect(out[0]?.agent).toBe("u1");
    expect(out.slice(1).map((r) => r.agent).sort()).toEqual([VOICE_AGENT_KEY, VOICE_AGENT_TELNYX_KEY].sort());
  });
});

describe("guardas del flujo (código)", () => {
  const route = readFileSync(resolve(__dirname, "../app/api/webhooks/telnyx/route.ts"), "utf8");
  const server = readFileSync(resolve(__dirname, "../lib/voice-recovery-server.ts"), "utf8");
  const cron = readFileSync(resolve(__dirname, "../app/api/cron/voice-recovery/route.ts"), "utf8");

  it("el webhook verifica la firma antes de leer el aviso", () => {
    expect(route.indexOf("verifyTelnyxSignature(")).toBeGreaterThan(-1);
    expect(route.indexOf("verifyTelnyxSignature(")).toBeLessThan(route.indexOf("parseTelnyxEvent(JSON.parse"));
  });

  it("la fila se escribe antes de marcar, con la línea y el mismo número de agente", () => {
    const fn = server.slice(server.indexOf("async function placeTelnyxCall"));
    expect(fn.indexOf('telephony: "telnyx"')).toBeGreaterThan(-1);
    expect(fn.indexOf("provider: engine")).toBeGreaterThan(-1);
    expect(fn.indexOf("agent_number: input.agentNumber.trim()")).toBeGreaterThan(-1);
    expect(fn.indexOf(".insert(")).toBeLessThan(fn.indexOf("dialTelnyx("));
  });

  it("la detección de contestadora no cuelga: modo sombra (falso «buzón» el 03-10-2026)", () => {
    expect(route).not.toMatch(/call\.machine\.detection\.ended"[^]*?hangup\(/);
    expect(route).not.toContain("contestó un buzón de voz");
  });

  it("el costo se guarda sin pisar el del otro tramo (escritura condicionada)", () => {
    const fn = route.slice(route.indexOf("async function saveCost"));
    expect(fn).toContain('.eq("updated_at", row.updated_at)');
    expect(route.indexOf('ev.type === "call.cost"')).toBeLessThan(route.indexOf("eventos.push("));
  });

  it("un pedido del reintento automático no bloquea la cola: se salta al siguiente (04-10-2026)", () => {
    expect(server).toContain('reason: "reintento_automatico"');
    expect(cron).toContain('placed.ok || placed.reason !== "reintento_automatico"');
    expect(cron).toContain("queue.candidates.slice(0, MAX_TRIES_PER_PASS)");
  });

  it("un corte sin gestión se cierra al momento, no a los ~10 min del barrido (04-10-2026)", () => {
    // Los dos tramos: cuelgue de la clienta y del agente.
    expect(route.match(/if \(row\.status === "in_progress"\) await closeCutWithoutGestion\(admin, row, now\);/g)).toHaveLength(2);
    const fn = route.slice(route.indexOf("async function closeCutWithoutGestion"));
    // Margen por si el registro venía en camino, y nunca sobre una gestión.
    expect(fn.indexOf("HANGUP_GRACE_MS")).toBeLessThan(fn.indexOf("closeAsNoAnswer("));
    expect(fn).toContain("soloSinGestion: true");
    // La comparación lo sigue contando como atendida y cortada sin gestión.
    expect(fn).toMatch(/error: "sin registrar_gestion/);
    const close = server.slice(server.indexOf("export async function closeAsNoAnswer("));
    expect(close).toContain('if (opts.soloSinGestion) close = close.is("outcome", null);');
  });

  it("registrar_gestion reserva la llamada antes de escribir sobre el pedido", () => {
    const reg = readFileSync(resolve(__dirname, "../app/api/voice/tools/registrar_gestion/route.ts"), "utf8");
    const reserva = reg.indexOf(".update({ outcome: action.disposition })");
    expect(reserva).toBeGreaterThan(-1);
    expect(reg.slice(reserva, reserva + 200)).toContain('.is("outcome", null)');
    expect(reserva).toBeLessThan(reg.indexOf("writeVoiceAttempt(admin, call"));
    expect(reserva).toBeLessThan(reg.indexOf("discardRecovery(admin"));
  });

  it("el barrido sortea línea y motor de cada llamada", () => {
    expect(cron).toContain("pickVoiceRoute({ telnyxShare, elevenShare, telnyxReady, elevenReady })");
    expect(cron).toContain("telephony,");
    expect(cron).toContain("engine,");
  });
});
