// Owner, 19-11-2026: «mi tía escanea y no logra ver bien, se le dificulta el
// escaneo, ¿cómo la ayudamos?». En Devoluciones cada lectura sale en grande
// encima del visor, el marco toma su color y el teléfono la dice en voz alta;
// la linterna ayuda con la poca luz del almacén.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readScanVoicePref, scanVerdictWord, scanVoiceText, speakScan, writeScanVoicePref } from "@/lib/scan-voice";

const read = (p: string) => readFileSync(p, "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("la palabra grande y la voz de cada lectura", () => {
  it("una palabra por resultado", () => {
    expect(scanVerdictWord("ok")).toBe("RECIBIDA");
    expect(scanVerdictWord("warn")).toBe("REPETIDA");
    expect(scanVerdictWord("crit")).toBe("ERROR");
    expect(scanVerdictWord("neutral")).toBe("AVISO");
  });

  it("la voz dice lo mismo, y cuándo mirar la pantalla", () => {
    expect(scanVoiceText("ok")).toBe("Recibida");
    expect(scanVoiceText("warn")).toBe("Repetida, no suma");
    expect(scanVoiceText("crit")).toBe("Error, mira la pantalla");
  });

  it("habla en español y corta lo anterior; sin voz no pasa nada", () => {
    const spoken: { text: string; lang: string }[] = [];
    const cancel = vi.fn();
    class Utterance { text: string; lang = ""; rate = 1; volume = 1; voice: unknown = null; constructor(t: string) { this.text = t; } }
    vi.stubGlobal("window", {
      SpeechSynthesisUtterance: Utterance,
      speechSynthesis: { cancel, getVoices: () => [{ lang: "en-US" }, { lang: "es-ES" }], speak: (u: Utterance) => spoken.push({ text: u.text, lang: u.lang }) },
    });
    speakScan("Recibida");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual([{ text: "Recibida", lang: "es-ES" }]);
    vi.stubGlobal("window", {});
    expect(() => speakScan("Recibida")).not.toThrow();
  });

  it("la voz queda prendida si nunca se tocó, y se recuerda en el teléfono", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
    expect(readScanVoicePref()).toBe(true);
    writeScanVoicePref(false);
    expect(readScanVoicePref()).toBe(false);
    writeScanVoicePref(true);
    expect(readScanVoicePref()).toBe(true);
    vi.stubGlobal("window", { get localStorage() { throw new Error("bloqueado"); } });
    expect(readScanVoicePref()).toBe(true);
  });
});

describe("la cámara de Devoluciones", () => {
  it("pide la palabra grande, la voz y ofrece la linterna", () => {
    expect(read("components/returns-reception.tsx")).toMatch(/feedback=\{last \? \{ key: last\.id, tone: last\.line\.tone \} : null\}\s+bigVerdict/);
    const cam = read("components/dispatch-camera.tsx");
    expect(cam).toContain("{scanVerdictWord(verdict.tone)}");
    expect(cam).toContain('{voiceOn ? "Voz: sí" : "Voz: no"}');
    expect(cam).toContain('{torch.on ? "Linterna: sí" : "Linterna"}');
    expect(cam).toContain("if (voiceOn) speakScan(scanVoiceText(feedbackTone));");
    const session = read("lib/dispatch-camera-session.ts");
    expect(session).toContain("width: { ideal: 1280 }, height: { ideal: 720 }");
    expect(session).toContain("return { stop, torchSupported, setTorch };");
  });
});
