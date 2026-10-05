import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { liveAgentName, liveElapsed, liveSignature, pinLiveCalls, type LiveVoiceCall } from "@/lib/voice-live";

const call = (orderId: string, over: Partial<LiveVoiceCall> = {}): LiveVoiceCall => ({
  orderId,
  orderName: `#${orderId}`,
  agent: "Agente Telnyx",
  phase: "in_progress",
  since: "2026-10-05T14:00:00.000Z",
  ...over,
});

describe("«Llamando ahora» en Envíos (MOM §11.8)", () => {
  it("la fila del pedido en llamada va primero; el resto conserva su orden", () => {
    const rows = [{ order_id: "a" }, { order_id: "b" }, { order_id: null }, { order_id: "c" }];
    const live = new Map([["c", call("c")]]);
    expect(pinLiveCalls(rows, live).map((r) => r.order_id)).toEqual(["c", "a", "b", null]);
  });

  it("sin llamadas, la misma lista (no se recrea: la tabla está memoizada)", () => {
    const rows = [{ order_id: "a" }];
    expect(pinLiveCalls(rows, new Map())).toBe(rows);
    expect(pinLiveCalls(rows, new Map([["z", call("z")]]))).toBe(rows);
  });

  it("el agente sale de la línea y el motor", () => {
    expect(liveAgentName("zadarma", "grok")).toBe("Agente Daaph");
    expect(liveAgentName(null, null)).toBe("Agente Daaph");
    expect(liveAgentName("telnyx", "grok")).toBe("Agente Telnyx");
    expect(liveAgentName("telnyx", "elevenlabs")).toBe("Agente ElevenLabs");
  });

  it("el tiempo en minutos y segundos, nunca negativo", () => {
    const t0 = Date.parse("2026-10-05T14:00:00.000Z");
    expect(liveElapsed("2026-10-05T14:00:00.000Z", t0 + 42_000)).toBe("0:42");
    expect(liveElapsed("2026-10-05T14:00:00.000Z", t0 + 725_000)).toBe("12:05");
    expect(liveElapsed("2026-10-05T14:00:00.000Z", t0 - 5_000)).toBe("0:00");
    expect(liveElapsed("basura", t0)).toBe("0:00");
  });

  it("la firma cambia si una llamada empieza, cambia de fase o termina", () => {
    const a = liveSignature([call("a", { phase: "dialing" })]);
    expect(liveSignature([call("a", { phase: "in_progress" })])).not.toBe(a);
    expect(liveSignature([])).not.toBe(a);
    expect(liveSignature([call("b"), call("a")])).toBe(liveSignature([call("a"), call("b")]));
  });

  it("solo llamadas reales y abiertas, sin las caducadas", () => {
    const src = readFileSync(resolve(__dirname, "../lib/shipments-access.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function getLiveVoiceCalls("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain('.eq("mode", "real")');
    expect(body).toContain('.in("status", ["dialing", "in_progress"])');
    expect(body).toContain(".filter((r) => !isStale(r, now))");
  });

  it("la cola la fija primero en cualquier orden, y sondea solo en Pendiente", () => {
    const src = readFileSync(resolve(__dirname, "../components/shipments.tsx"), "utf8");
    expect(src).toContain('useLiveVoiceCalls(view === "pendiente")');
    expect(src).toMatch(/pinLiveCalls\(sort \? sortShipmentRows\(filtered/);
  });
});
