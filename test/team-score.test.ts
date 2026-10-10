import { describe, expect, it } from "vitest";
import { VOICE_AGENT_KEY, VOICE_AGENT_TELNYX_KEY, type ReproDayAgentCount } from "@/lib/shipments";
import { aggregateVoiceScore } from "@/lib/voice-scoreboard";
import { buildTeamScore, teamConversion, teamCostPerReprogramada } from "@/lib/team-score";

const person = (agent: string, name: string, o: Partial<ReproDayAgentCount> = {}) => ({
  agent,
  name,
  gestiones: 0,
  reprogramadas: 0,
  anuladas: 0,
  entregadas: 0,
  guias: 0,
  pedidos: 0,
  reprogramadasGuias: 0,
  reprogramadasEntregadas: 0,
  ...o,
});

describe("«Gestión por persona»: asesoras y agentes en una tabla (10-10-2026)", () => {
  // El 10-10, Telnyx: una llamada sin respuesta y una que confirmó con salida Swayp.
  const agents = aggregateVoiceScore([
    { telephony: "telnyx", provider: "grok", order_id: "p1", started_at: null, outcome: "no_contesta", salidaOk: false, costo: 0.01 },
    { telephony: "telnyx", provider: "grok", order_id: "p2", started_at: "t", outcome: "confirma", salidaOk: true, costo: 0.02 },
    { telephony: "zadarma", provider: "grok", order_id: "p3", started_at: "t", outcome: "programar", salidaOk: false },
  ]);
  const people = [
    person("u1", "Mariannys", {
      gestiones: 4,
      reprogramadas: 2,
      pedidos: 4,
      guias: 5,
      reprogramadasGuias: 2,
      reprogramadasEntregadas: 1,
    }),
    // La fila del agente armada desde `shipment_calls` (llamada + dos `reroute`) se descarta.
    person(VOICE_AGENT_TELNYX_KEY, "Agente Telnyx", {
      gestiones: 4,
      reprogramadas: 1,
      guias: 3,
      pedidos: 2,
      reprogramadasGuias: 1,
      reprogramadasEntregadas: 1,
    }),
  ];
  const { rows, total } = buildTeamScore(people, agents);

  it("asesoras arriba y los tres agentes abajo, siempre", () => {
    expect(rows.map((r) => r.name)).toEqual(["Mariannys", "Agente Daaph", "Agente Telnyx", "Agente ElevenLabs"]);
  });

  it("el agente cuenta por sus llamadas: una llamada, una gestión; reprogramadas = salidas Swayp", () => {
    const telnyx = rows.find((r) => r.key === VOICE_AGENT_TELNYX_KEY)!;
    expect(telnyx).toMatchObject({ gestiones: 2, pedidos: 2, reprogramadas: 1, atendidas: 1, anuladas: null });
    expect(teamConversion(telnyx)).toBe(1);
    expect(teamCostPerReprogramada(telnyx)).toBeCloseTo(0.03);
  });

  it("la asesora no lleva columnas de llamada; Daaph sin costo no da costo por reprogramada", () => {
    expect(rows[0]).toMatchObject({ atendidas: null, costo: null, voice: false });
    const daaph = rows.find((r) => r.key === VOICE_AGENT_KEY)!;
    expect(daaph).toMatchObject({ gestiones: 1, programar: 1, costo: null });
    expect(teamCostPerReprogramada(daaph)).toBeNull();
  });

  it("el total suma todos; el costo por reprogramada del total no sale si falta el de una llamada", () => {
    expect(total).toMatchObject({ gestiones: 7, reprogramadas: 3, pedidos: 7, anuladas: 0, atendidas: 2, programar: 1 });
    expect(teamCostPerReprogramada(total)).toBeNull();
  });

  it("llegaron: la entrega real de lo reprogramado, del rastro en shipment_calls, también para el agente", () => {
    expect(rows[0]).toMatchObject({ llegaron: 1, llegaronDe: 2 });
    expect(rows.find((r) => r.key === VOICE_AGENT_TELNYX_KEY)).toMatchObject({ llegaron: 1, llegaronDe: 1 });
    expect(rows.find((r) => r.key === VOICE_AGENT_KEY)).toMatchObject({ llegaron: 0, llegaronDe: 0 });
    expect(total).toMatchObject({ llegaron: 2, llegaronDe: 3 });
  });

  it("la conversión del total usa solo las reprogramadas de los agentes, no las de las asesoras", () => {
    // 1 reprogramada por llamada (Telnyx) sobre 2 atendidas; las 2 de Mariannys no cuentan.
    expect(total.reprogramadasLlamada).toBe(1);
    expect(teamConversion(total)).toBe(0.5);
    expect(teamConversion(rows[0]!)).toBeNull();
  });
});
