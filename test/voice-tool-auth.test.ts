import { describe, expect, it } from "vitest";
import { voiceToolSecretMatches } from "@/lib/voice-recovery-server";

const h = (entries: Record<string, string>) => new Headers(entries);
const XAI = "secreto-xai";
const ELEVEN = "secreto-elevenlabs";

describe("autenticación de las tools del agente (MOM §11.8)", () => {
  it("cada agente entra con su secreto, por Authorization o por x-voice-secret", () => {
    expect(voiceToolSecretMatches(h({ authorization: `Bearer ${XAI}` }), [XAI, ELEVEN])).toBe(true);
    expect(voiceToolSecretMatches(h({ "x-voice-secret": XAI }), [XAI, ELEVEN])).toBe(true);
    expect(voiceToolSecretMatches(h({ "x-voice-secret": ELEVEN }), [XAI, ELEVEN])).toBe(true);
    expect(voiceToolSecretMatches(h({ authorization: `Bearer ${ELEVEN}` }), [XAI, ELEVEN])).toBe(true);
  });

  it("x-voice-secret con «Bearer » delante también vale", () => {
    expect(voiceToolSecretMatches(h({ "x-voice-secret": `Bearer ${ELEVEN}` }), [XAI, ELEVEN])).toBe(true);
  });

  it("sin el secreto de ElevenLabs configurado, solo vale el de xAI", () => {
    expect(voiceToolSecretMatches(h({ "x-voice-secret": ELEVEN }), [XAI, ""])).toBe(false);
    expect(voiceToolSecretMatches(h({ "x-voice-secret": XAI }), [XAI, ""])).toBe(true);
  });

  it("un secreto vacío o distinto nunca autoriza", () => {
    expect(voiceToolSecretMatches(h({}), [XAI, ""])).toBe(false);
    expect(voiceToolSecretMatches(h({ "x-voice-secret": "" }), ["", ""])).toBe(false);
    expect(voiceToolSecretMatches(h({ authorization: "Bearer " }), [XAI, ""])).toBe(false);
    expect(voiceToolSecretMatches(h({ "x-voice-secret": "otro" }), [XAI, ELEVEN])).toBe(false);
  });
});
