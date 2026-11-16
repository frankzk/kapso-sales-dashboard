// La medición de una semana de «mensaje posterior» (owner, 16-11-2026).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { POSTERIOR_CAPTURE_UNTIL, capturePosterior, posteriorMessages } from "@/lib/chatby-autoconfirm";
import type { ChatbyMessage } from "@/lib/chatby-conversation";

const msg = (id: string, over: Partial<ChatbyMessage> = {}): ChatbyMessage => ({
  id,
  kind: "cliente",
  at: "2026-11-16T15:00:00Z",
  text: "",
  template: null,
  button: false,
  media: null,
  mediaUrl: null,
  error: false,
  agent: null,
  location: null,
  ...over,
});

describe("posteriorMessages", () => {
  it("solo lo que escribió la clienta después de confirmar, sin coordenadas", () => {
    const messages = [
      msg("a", { text: "hola" }),
      msg("c", { text: "Sí confirmo, pago S/ 149 al recibir" }),
      msg("b", { kind: "bot", text: "Gracias" }),
      msg("d", { text: "¿Me lo pueden mandar el lunes?" }),
      msg("e", { media: "audio" }),
      msg("f", { text: "https://maps.google.com/?q=-12.1,-77.0", location: { lat: -12.1, lng: -77 } }),
    ];
    expect(posteriorMessages(messages, "c")).toEqual([
      { at: "2026-11-16T15:00:00Z", text: "¿Me lo pueden mandar el lunes?", media: null, button: false, location: false },
      { at: "2026-11-16T15:00:00Z", text: "", media: "audio", button: false, location: false },
      { at: "2026-11-16T15:00:00Z", text: "", media: null, button: false, location: true },
    ]);
  });

  it("recorta el texto y no pasa de 8", () => {
    const many = [msg("c"), ...Array.from({ length: 12 }, (_, i) => msg(`m${i}`, { text: "x".repeat(500) }))];
    const out = posteriorMessages(many, "c");
    expect(out).toHaveLength(8);
    expect(out[0]!.text).toHaveLength(300);
    expect(posteriorMessages(many, null)).toEqual([]);
    expect(posteriorMessages(many, "zz")).toEqual([]);
  });

  it("se guarda solo hasta el 23-11-2026", () => {
    expect(POSTERIOR_CAPTURE_UNTIL).toBe("2026-11-23T05:00:00Z");
    expect(capturePosterior(new Date("2026-11-16T12:00:00Z"))).toBe(true);
    expect(capturePosterior(new Date("2026-11-23T05:00:00Z"))).toBe(false);
  });

  it("el servidor lo guarda en la evidencia del frenado", () => {
    const server = readFileSync(resolve(process.cwd(), "lib/chatby-autoconfirm-server.ts"), "utf8");
    expect(server).toContain('if (verdict.reason === "mensaje_posterior" && capturePosterior()) {');
    expect(server).toContain("evidence.posterior = posteriorMessages(conversation.messages, verdict.messageId);");
  });
});
