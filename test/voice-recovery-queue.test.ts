import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  VOICE_EXCLUSION_LABEL,
  compareVoiceCandidates,
  isLimaSunday,
  voiceRecoveryEligible,
  withinVoiceHours,
  type VoiceCandidateInput,
} from "@/lib/voice-recovery-queue";
import { pideNoLlamar, translateGestion } from "@/lib/voice-recovery";

// Martes 22-09-2026, 11:00 en Lima.
const NOW = new Date("2026-09-22T16:00:00.000Z");
const TODAY = "2026-09-22";
const hace = (dias: number) => new Date(NOW.getTime() - dias * 86_400_000).toISOString();

/** Guía Aliclik anulada con intento fallido DESPUÉS de salir: abre la recuperación. */
const guiaFallida = (over: Record<string, unknown> = {}) => ({
  courier: "aliclik",
  delivery_status: "anulado",
  reported_status: "CANCEL · PICKED · ",
  closed_at: hace(2),
  returned_at: null,
  updated_at: hace(2),
  ...over,
});

function input(over: Partial<VoiceCandidateInput> = {}): VoiceCandidateInput {
  return {
    now: NOW,
    today: TODAY,
    guides: [guiaFallida()],
    events: [],
    recoveryWindowDays: 30,
    maxAgeDays: 7,
    district: "Cusco",
    region: "Cuzco",
    lineItems: [{ title: "Aceite de Semilla Negra", sku: "ETH-60", quantity: 1 }],
    stock: [{ city: "cusco", product: "Aceite de Semilla Negra", sku: "ETH-60", quantity: 10 }],
    phone: "51930555309",
    priors: [],
    nextContactOn: null,
    agentCalls: [],
    maxAgentAttempts: 2,
    doNotCall: false,
    ...over,
  };
}

const prior = (general_status: string, id: string) =>
  ({
    order_id: id,
    order_name: `#${id}`,
    order_created_at: hace(40),
    general_status,
    macro_stage: general_status === "anulado" ? "por_cerrar" : "finalizado",
    order_total: 149,
  }) as never;

describe("quién entra a la cola del agente (MOM §11.8)", () => {
  it("un pedido que cumple las nueve condiciones entra, con su fecha de cierre", () => {
    expect(voiceRecoveryEligible(input())).toEqual({ eligible: true, closedAt: hace(2), dueByPact: false });
  });

  it.each<[string, Partial<VoiceCandidateInput>, string]>([
    ["1 · recuperación descartada", { events: [{ kind: "recovery_discarded", occurred_at: hace(1) }] }, "recuperacion_no_activa"],
    ["1 · el paquete nunca salió", { guides: [guiaFallida({ reported_status: "CANCEL · PREPARED · " })] }, "recuperacion_no_activa"],
    ["2 · la guía cerró hace diez días", { guides: [guiaFallida({ closed_at: hace(10), updated_at: hace(10) })] }, "cerrada_hace_mucho"],
    ["3 · sin stock en su ciudad", { stock: [{ city: "cusco", product: "Aceite de Semilla Negra", sku: "ETH-60", quantity: 0 }] }, "sin_stock_swayp"],
    ["3 · ciudad sin bodega Swayp", { district: "Iquitos", region: "Loreto" }, "sin_stock_swayp"],
    ["4 · lo rechazó en la puerta", { guides: [guiaFallida({ reported_status: "REFUSED · PICKED · " })] }, "rechazo_en_puerta"],
    ["5 · sin teléfono", { phone: null }, "telefono_invalido"],
    ["5 · un fijo no se llama", { phone: "5117058243" }, "telefono_invalido"],
    ["6 · dos antecedentes", { priors: [prior("anulado", "a"), prior("devuelto", "b")] }, "antecedentes"],
    ["7 · ya la llamó una persona hoy", { events: [{ kind: "confirmation_contact", occurred_at: "2026-09-22T14:00:00.000Z" }] }, "gestion_hoy"],
    ["7 · tiene fecha pactada futura", { nextContactOn: "2026-09-24" }, "fecha_pactada_futura"],
    ["9 · pidió que no la llamen", { doNotCall: true }, "pidio_no_llamar"],
    ["tope · el agente ya llamó hoy", { agentCalls: [{ queued_at: "2026-09-22T14:30:00.000Z" }] }, "agente_ya_llamo_hoy"],
    ["tope · el agente agotó sus intentos", { agentCalls: [{ queued_at: hace(3) }, { queued_at: hace(2) }] }, "agente_agoto_intentos"],
  ])("%s → fuera", (_name, over, reason) => {
    expect(voiceRecoveryEligible(input(over))).toEqual({ eligible: false, reason });
  });

  it("8 · sin cupo: siete días distintos con gestión", () => {
    const events = [8, 7, 6, 5, 4, 3, 1].map((d) => ({ kind: "confirmation_contact", occurred_at: hace(d) }));
    expect(voiceRecoveryEligible(input({ events }))).toEqual({ eligible: false, reason: "sin_cupo_de_gestion" });
  });

  it("un antecedente solo sugiere adelanto: entra", () => {
    expect(voiceRecoveryEligible(input({ priors: [prior("anulado", "a")] }))).toMatchObject({ eligible: true });
  });

  it("sin motivo del courier entra: la ausencia no es un rechazo (§11.7)", () => {
    expect(
      voiceRecoveryEligible(input({ guides: [guiaFallida({ reported_status: "CANCEL · PICKED · " })] })),
    ).toMatchObject({ eligible: true });
  });

  it("una gestión de ayer a las 20:00 de Lima no cuenta como de hoy", () => {
    // 20:00 del 21 en Lima = 01:00 del 22 en UTC.
    const events = [{ kind: "confirmation_contact", occurred_at: "2026-09-22T01:00:00.000Z" }];
    expect(voiceRecoveryEligible(input({ events }))).toMatchObject({ eligible: true });
  });

  it("una fecha pactada vencida o de hoy entra, y va primero", () => {
    const due = voiceRecoveryEligible(input({ nextContactOn: TODAY }));
    expect(due).toMatchObject({ eligible: true, dueByPact: true });
    const list = [
      { dueByPact: false, closedAt: hace(1) },
      { dueByPact: true, closedAt: hace(5) },
      { dueByPact: false, closedAt: hace(3) },
    ].sort(compareVoiceCandidates);
    expect(list.map((c) => c.closedAt)).toEqual([hace(5), hace(1), hace(3)]);
  });

  it("cada motivo de exclusión tiene su frase para el drawer", () => {
    const src = readFileSync("lib/voice-recovery-queue.ts", "utf8");
    const reasons = [...src.matchAll(/\| "([a-z_]+)"/g)].map((m) => m[1]);
    for (const r of reasons) expect(VOICE_EXCLUSION_LABEL[r as keyof typeof VOICE_EXCLUSION_LABEL]).toBeTruthy();
  });
});

describe("horario del agente, en hora de Lima", () => {
  it("de 9 a 20, con la hora de Lima y no la de UTC", () => {
    expect(withinVoiceHours(new Date("2026-09-22T14:00:00.000Z"), 9, 20)).toBe(true); // 09:00 Lima
    expect(withinVoiceHours(new Date("2026-09-22T13:59:00.000Z"), 9, 20)).toBe(false); // 08:59
    expect(withinVoiceHours(new Date("2026-09-23T00:59:00.000Z"), 9, 20)).toBe(true); // 19:59
    expect(withinVoiceHours(new Date("2026-09-23T01:00:00.000Z"), 9, 20)).toBe(false); // 20:00
  });

  it("el domingo no se llama", () => {
    expect(isLimaSunday(new Date("2026-09-27T15:00:00.000Z"))).toBe(true);
    // Sábado 22:00 en Lima = domingo 03:00 en UTC: sigue siendo sábado.
    expect(isLimaSunday(new Date("2026-09-27T03:00:00.000Z"))).toBe(false);
  });
});

describe("«que no la llamen» (§11.8, condición 9)", () => {
  it.each([
    "La clienta pidió que no la llamen más.",
    "Dice: no me llamen",
    "No quiere que la vuelvan a llamar",
    "Pide que no la sigan llamando",
  ])("detecta «%s»", (t) => {
    expect(pideNoLlamar(t)).toBe(true);
  });

  it("no confunde un «no contestó» ni «la llamamos mañana»", () => {
    expect(pideNoLlamar("No contestó la llamada")).toBe(false);
    expect(pideNoLlamar("Pide que la llamemos mañana")).toBe(false);
  });

  it("queda marcado en lo que registra el agente", () => {
    const a = translateGestion(
      { disposition: "programar", resumen: "Contestó y pidió que no la llamen más." },
      { today: TODAY, canDiscard: false, voiceCallId: "vc" },
    );
    expect(a).toMatchObject({ kind: "attempt", extra: { no_llamar: true } });
  });
});
