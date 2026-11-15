import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanResultNotes, SCAN_READ_NOTES } from "@/lib/scan-sound";

describe("el sonido del lector (13-11-2026)", () => {
  it("un pitido corto al leer y un tono distinto por resultado", () => {
    expect(SCAN_READ_NOTES).toHaveLength(1);
    expect(SCAN_READ_NOTES[0]!.ms).toBeLessThan(100);
    const ok = scanResultNotes("ok")!;
    expect(ok).toHaveLength(2);
    expect(ok[1]!.freq).toBeGreaterThan(ok[0]!.freq); // sube: buena
    const warn = scanResultNotes("warn")!;
    expect(warn.map((n) => n.freq)).toEqual([660, 660]); // dos iguales: repetida
    const crit = scanResultNotes("crit")!;
    expect(crit).toHaveLength(1);
    expect(crit[0]!.freq).toBeLessThan(300); // grave y largo: error
    expect(crit[0]!.ms).toBeGreaterThan(300);
    expect(scanResultNotes("neutral")).toBeNull();
  });
  it("la cámara suena al leer, por resultado y prepara el audio al abrirse", () => {
    const src = readFileSync("components/dispatch-camera.tsx", "utf8");
    expect(src).toContain("playScanNotes(SCAN_READ_NOTES);");
    expect(src).toContain("playScanNotes(scanResultNotes(feedbackTone));");
    expect(src).toContain("primeScanSound();");
  });
});
