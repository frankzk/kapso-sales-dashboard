import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateVoiceScore,
  voiceAgentOfCall,
  voiceCallsPerConfirma,
  voiceConversion,
  type VoiceScoreCall,
} from "@/lib/voice-scoreboard";
import { VOICE_AGENT_ELEVENLABS_KEY, VOICE_AGENT_KEY, VOICE_AGENT_TELNYX_KEY } from "@/lib/shipments";

const call = (over: Partial<VoiceScoreCall> = {}): VoiceScoreCall => ({
  telephony: "zadarma",
  provider: "grok",
  started_at: null,
  outcome: "no_contesta",
  salidaOk: false,
  ...over,
});

describe("Agentes de voz: comparación (MOM §11.8)", () => {
  it("la línea y el motor dicen quién llamó", () => {
    expect(voiceAgentOfCall({ telephony: null, provider: "grok" })).toBe(VOICE_AGENT_KEY);
    expect(voiceAgentOfCall({ telephony: "zadarma", provider: "grok" })).toBe(VOICE_AGENT_KEY);
    expect(voiceAgentOfCall({ telephony: "telnyx", provider: "grok" })).toBe(VOICE_AGENT_TELNYX_KEY);
    expect(voiceAgentOfCall({ telephony: "telnyx", provider: "elevenlabs" })).toBe(VOICE_AGENT_ELEVENLABS_KEY);
  });

  it("siempre los tres agentes, en orden, aunque uno no haya llamado", () => {
    const rows = aggregateVoiceScore([]);
    expect(rows.map((r) => r.agent)).toEqual([VOICE_AGENT_KEY, VOICE_AGENT_TELNYX_KEY, VOICE_AGENT_ELEVENLABS_KEY]);
    expect(rows.every((r) => r.llamadas === 0)).toBe(true);
  });

  it("cuenta atendidas, cortes sin gestión, resultados y guías", () => {
    const [daaph, telnyx] = aggregateVoiceScore([
      call(), // no contestó
      call({ started_at: "t", outcome: "no_contesta" }), // atendió y se cortó
      call({ started_at: "t", outcome: "confirma", salidaOk: true }),
      call({ started_at: "t", outcome: "programar" }),
      call({ telephony: "telnyx", started_at: "t", outcome: "confirma" }),
      call({ telephony: "telnyx", started_at: "t", outcome: "cancela" }),
    ]);
    expect(daaph).toMatchObject({ llamadas: 4, atendidas: 3, sinGestion: 1, confirma: 1, programar: 1, guias: 1 });
    expect(telnyx).toMatchObject({ llamadas: 2, atendidas: 2, sinGestion: 0, confirma: 1, cancela: 1, guias: 0 });
    expect(voiceConversion(daaph!)).toBeCloseTo(1 / 3);
    expect(voiceCallsPerConfirma(daaph!)).toBe(4);
  });

  it("sin atendidas ni confirma no hay tasa: guion, no cero", () => {
    expect(voiceConversion({ confirma: 0, atendidas: 0 })).toBeNull();
    expect(voiceCallsPerConfirma({ confirma: 0, llamadas: 5 })).toBeNull();
  });

  it("solo llamadas reales", () => {
    const src = readFileSync(resolve(__dirname, "../lib/shipments-access.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function getVoiceScoreboard"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('.eq("mode", "real")');
  });
});
