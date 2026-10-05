import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agoLabel,
  lastCallResult,
  limaPassLabel,
  liveAgentName,
  liveElapsed,
  liveSignature,
  nextVoicePass,
  pinLiveCalls,
  type LiveVoiceCall,
} from "@/lib/voice-live";
import { withinVoiceHours } from "@/lib/voice-recovery-queue";

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
    expect(src).toContain('useVoiceLiveStatus(view === "pendiente")');
    expect(src).toMatch(/pinLiveCalls\(sort \? sortShipmentRows\(filtered/);
  });

  it("la última llamada, dicha en palabras", () => {
    const base = { status: "completed", outcome: null, error: null, started_at: null };
    expect(lastCallResult({ ...base, outcome: "confirma" })).toBe("confirmó");
    expect(lastCallResult({ ...base, outcome: "programar" })).toBe("programó");
    expect(lastCallResult({ ...base, outcome: "cancela" })).toBe("canceló");
    expect(lastCallResult({ ...base, outcome: "no_contesta" })).toBe("no contestó");
    expect(lastCallResult({ ...base, outcome: "no_contesta", started_at: "t" })).toBe("buzón o sin respuesta");
    expect(
      lastCallResult({ ...base, outcome: "no_contesta", started_at: "t", error: "sin registrar_gestion: se cortó la llamada" }),
    ).toBe("se cortó sin gestión");
    expect(lastCallResult({ ...base, status: "failed", outcome: "sin_resultado" })).toBe("falló");
  });

  it("la próxima pasada cae en punto de 5 min y dentro del horario de Lima", () => {
    const within = (d: Date) => withinVoiceHours(d, 9, 22);
    // Domingo 04-10 21:07 Lima → 21:10.
    expect(nextVoicePass(new Date("2026-10-05T02:07:00Z"), within)?.toISOString()).toBe("2026-10-05T02:10:00.000Z");
    // En punto pasa a la siguiente: 21:10 → 21:15.
    expect(nextVoicePass(new Date("2026-10-05T02:10:00Z"), within)?.toISOString()).toBe("2026-10-05T02:15:00.000Z");
    // 22:03 Lima del domingo → lunes 09:00.
    expect(nextVoicePass(new Date("2026-10-05T03:03:00Z"), within)?.toISOString()).toBe("2026-10-05T14:00:00.000Z");
    expect(nextVoicePass(new Date("2026-10-05T03:03:00Z"), () => false)).toBeNull();
  });

  it("la hora de la pasada y el «hace», en Lima", () => {
    const now = Date.parse("2026-10-05T02:07:00Z"); // dom 21:07 Lima
    expect(limaPassLabel("2026-10-05T02:10:00Z", now)).toBe("21:10");
    expect(limaPassLabel("2026-10-05T14:00:00Z", now)).toBe("mañana 09:00");
    expect(limaPassLabel("2026-10-06T14:00:00Z", now)).toBe("mar 09:00");
    expect(agoLabel("2026-10-05T02:05:00Z", now)).toBe("hace 2 min");
    expect(agoLabel("2026-10-05T02:06:40Z", now)).toBe("hace un momento");
    expect(agoLabel("2026-10-05T00:05:00Z", now)).toBe("hace 2 h");
  });
});
