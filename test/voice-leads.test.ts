// Agente de voz para leads — las reglas puras de lib/voice-leads.ts (MOM §33).
//
// Aquí no hay base ni red. Cada prueba fija una decisión del piloto que, si
// cambiara en silencio, cambiaría a quién llama el agente, qué escucha al
// conectar o qué escribe sobre el lead. Las rutas, el barrido y el drawer
// tienen sus propias pruebas (voice-leads-server, -rutas, -drawer).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import { assignArm, FRIO_COVERAGE_EXPERIMENT } from "@/lib/lead-experiment";
import { categoryOf, CLAIM_TTL_MINUTES, isValidStatus } from "@/lib/leads";
import {
  LEAD_VOICE_EXCLUSION_LABEL,
  LEAD_VOICE_MOTIVO_LABEL,
  LEAD_VOICE_OUTCOME_LABEL,
} from "@/lib/voice-lead-labels";
import { voiceDates } from "@/lib/voice-recovery";
import {
  attemptCounts,
  buildLeadFicha,
  chatParaAgente,
  coberturaParaAgente,
  consultaHablada,
  followupFrom,
  handoffContextFor,
  LEAD_VOICE_EXCLUSIONS,
  LEAD_VOICE_EXPERIMENT,
  LEAD_VOICE_HANDOFF_REASON,
  LEAD_VOICE_MOTIVO_STATUS,
  LEAD_VOICE_MOTIVOS,
  LEAD_VOICE_OUTCOMES,
  LEAD_VOICE_RESULTS,
  LEAD_VOICE_RETRY_GAP_HOURS,
  LEAD_VOICE_VARS,
  leadPatchFor,
  leadVoiceArm,
  leadVoiceEligible,
  leadVoiceInitiation,
  leadVoicePhone,
  leadVoiceSettingsFrom,
  leadVoiceTimelineTitle,
  nombreHablado,
  noAnswerNote,
  saludoLima,
  sortLeadVoiceQueue,
  translateLeadResult,
  type ChatMessage,
  type LeadCaptura,
  type LeadFicha,
  type LeadFichaInput,
  type LeadResultAction,
  type LeadResultInput,
  type LeadVoiceAttempt,
  type LeadVoiceCandidate,
  type LeadVoiceEligibilityInput,
  type LeadVoiceExclusion,
  type LeadVoiceLead,
  type LeadVoiceSettings,
  pideNoContactar,
} from "@/lib/voice-leads";

// Lunes 12-10-2026, 12:00 en Lima (UTC-5, sin horario de verano).
const NOW = new Date("2026-10-12T17:00:00.000Z");
const T = NOW.getTime();
const MIN = 60_000;
const H = 60 * MIN;
const hace = (ms: number) => new Date(T - ms).toISOString();
const en = (ms: number) => new Date(T + ms).toISOString();

const CAMPANA = "cmp-piloto";

// ── Un lead que el agente SÍ llama; cada prueba rompe una cosa ──────────────

function settings(over: Partial<LeadVoiceSettings> = {}): LeadVoiceSettings {
  return {
    ...leadVoiceSettingsFrom({ id: "tienda-1", name: "Biru Peru" }),
    enabled: true,
    auto: true,
    campaignIds: [CAMPANA],
    // Sin control: así el lead de referencia cae siempre en tratamiento y cada
    // prueba de exclusión mide solo lo que rompe. El sorteo va aparte.
    holdoutPct: 0,
    ...over,
  };
}

function lead(over: Partial<LeadVoiceLead> = {}): LeadVoiceLead {
  return {
    id: "0d6f3a52-1b7c-4e2a-9f10-3c5d7e8a9b01",
    store_id: "tienda-1",
    phone: "51987654321",
    name: "Rosa Quispe",
    status: "nuevo",
    category: "open",
    has_order: false,
    order_id: null,
    source: "meta_ad",
    ad_id: "ad-1",
    inbound_count: 3,
    first_seen_at: hace(5 * H),
    last_inbound_at: hace(3 * H),
    claimed_at: null,
    next_followup_at: null,
    contact_opt_out_at: null,
    ...over,
  };
}

type Over = Partial<Omit<LeadVoiceEligibilityInput, "lead" | "settings">> & {
  lead?: Partial<LeadVoiceLead>;
  settings?: Partial<LeadVoiceSettings>;
};

function input(over: Over = {}): LeadVoiceEligibilityInput {
  const { lead: l, settings: s, ...rest } = over;
  return {
    lead: lead(l),
    now: NOW,
    settings: settings(s),
    campaignId: CAMPANA,
    humanTouched: false,
    doNotCall: false,
    attempts: [],
    arm: null,
    ...rest,
  };
}

const intento = (queued_at: string, status = "completed", outcome: string | null = "no_contesta"): LeadVoiceAttempt => ({
  queued_at,
  status,
  outcome,
});

const razon = (i: LeadVoiceEligibilityInput) => {
  const r = leadVoiceEligible(i);
  return r.ok ? "ok" : r.reason;
};

/** Un «volver a llamar» que agendó el propio agente hace 4 h. */
function agendado(over: Over = {}): LeadVoiceEligibilityInput {
  return input({
    attempts: [intento(hace(4 * H), "completed", "volver_a_llamar")],
    ...over,
    lead: { status: "volver_a_llamar", next_followup_at: hace(10 * MIN), ...over.lead },
  });
}

/**
 * UUID v4 a partir de una semilla fija (mulberry32). El reparto del sorteo se
 * mide igual en cada corrida: una prueba de proporciones con azar real falla
 * de vez en cuando sin que nada esté mal.
 */
function idsSembrados(n: number, semilla: number): string[] {
  let s = semilla >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const hex = (k: number) => Array.from({ length: k }, () => Math.floor(rnd() * 16).toString(16)).join("");
  return Array.from(
    { length: n },
    () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rnd() * 4)]}${hex(3)}-${hex(12)}`,
  );
}

/** Coeficiente phi entre dos variables binarias: 0 = independientes. */
function phi(a: readonly boolean[], b: readonly boolean[]): number {
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
  a.forEach((x, i) => {
    if (x && b[i]) n11++;
    else if (x) n10++;
    else if (b[i]) n01++;
    else n00++;
  });
  return (n11 * n00 - n10 * n01) / Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
}

// ── A quién llama ───────────────────────────────────────────────────────────

describe("leadVoiceEligible: quién entra a la cola del agente", () => {
  it("el lead de referencia entra: primera llamada, tratamiento y brazo por guardar", () => {
    expect(leadVoiceEligible(input())).toEqual({ ok: true, kind: "primera", arm: "tratamiento", assignNow: true });
  });

  // Cada exclusión sola, sobre el lead que sí entra.
  const CASOS: [LeadVoiceExclusion, string, Over][] = [
    ["agente_apagado", "la tienda no lo encendió", { settings: { enabled: false } }],
    ["sin_telefono", "sin teléfono", { lead: { phone: null } }],
    ["sin_telefono", "un fijo de Lima", { lead: { phone: "014567890" } }],
    ["sin_telefono", "un número incompleto", { lead: { phone: "98765432" } }],
    ["no_contactar", "pidió no ser contactado", { lead: { contact_opt_out_at: hace(24 * H) } }],
    ["no_contactar", "su teléfono está en la lista «no llamar» de la tienda", { doNotCall: true }],
    ["ya_compro", "está en ganados", { lead: { category: "won" } }],
    ["ya_compro", "tiene pedido (has_order)", { lead: { has_order: true } }],
    ["ya_compro", "tiene pedido (order_id)", { lead: { order_id: "pedido-1" } }],
    ["fuera_de_campana", "no viene de un anuncio", { lead: { source: "cod_cart" } }],
    ["fuera_de_campana", "el anuncio no se resolvió a campaña", { campaignId: null }],
    ["fuera_de_campana", "viene de otra campaña", { campaignId: "cmp-otra" }],
    ["fuera_de_campana", "la tienda no eligió campañas (el defecto de 0247)", { settings: { campaignIds: [] } }],
    ["perdido", "está en Perdidos", { lead: { category: "lost" } }],
    ["poco_interes", "escribió una sola vez", { lead: { inbound_count: 1 } }],
    ["poco_interes", "sin conteo de mensajes", { lead: { inbound_count: null } }],
    [
      "callback_pendiente",
      "el agente lo vuelve a llamar a la hora que pidió",
      {
        lead: { status: "volver_a_llamar", next_followup_at: en(H) },
        attempts: [intento(hace(4 * H), "completed", "volver_a_llamar")],
      },
    ],
    ["estado", "una asesora lo movió de «Sin llamar»", { lead: { status: "no_responde" } }],
    ["estado", "ya está en «Atender ahora»", { lead: { status: "casi_cierra", category: "hot" } }],
    ["atendido_por_asesora", "una asesora ya lo llamó o le escribió", { humanTouched: true }],
    ["reservado", "una asesora lo tiene tomado", { lead: { claimed_at: hace(5 * MIN) } }],
    ["muy_pronto", "escribió hace una hora y la espera es de dos", { lead: { last_inbound_at: hace(H) } }],
    ["muy_antiguo", "escribió hace más de 48 h", { lead: { last_inbound_at: hace(49 * H) } }],
    ["muy_antiguo", "sin ninguna fecha de entrada", { lead: { last_inbound_at: null, first_seen_at: null } }],
    ["grupo_control", "su brazo guardado es control", { arm: "control" }],
    ["llamada_abierta", "el agente lo está marcando", { attempts: [intento(hace(MIN), "dialing", null)] }],
    ["intentos_agotados", "dos intentos que marcaron, con tope 2", { attempts: [intento(hace(20 * H)), intento(hace(10 * H))] }],
    ["reintento_pronto", "el último intento fue hace una hora", { attempts: [intento(hace(H))] }],
  ];

  it.each(CASOS)("%s: %s", (esperada, _porque, over) => {
    expect(razon(input(over))).toBe(esperada);
  });

  it("la tabla de arriba prueba TODAS las exclusiones", () => {
    expect(new Set(CASOS.map(([r]) => r))).toEqual(new Set(LEAD_VOICE_EXCLUSIONS));
  });

  // MOM §33.2 lista las condiciones en este orden, y el panel muestra la
  // primera que falla. Si el código las evaluara en otro orden, la razón que ve
  // la asesora no sería la que el MOM promete.
  it("la primera que falla es la razón, en el orden de LEAD_VOICE_EXCLUSIONS", () => {
    const i = input({
      settings: { enabled: false, maxAttempts: 2 },
      lead: {
        phone: "014567890",
        contact_opt_out_at: hace(H),
        has_order: true,
        category: "lost",
        inbound_count: 1,
        status: "volver_a_llamar",
        next_followup_at: en(H),
        claimed_at: hace(MIN),
        last_inbound_at: hace(30 * MIN),
      },
      campaignId: "cmp-otra",
      doNotCall: true,
      humanTouched: true,
      arm: "control",
      attempts: [
        intento(hace(10 * H)),
        intento(hace(2 * H), "queued", null),
        intento(hace(H), "completed", "volver_a_llamar"),
      ],
    });
    const pasos: [string, () => void][] = [
      ["agente_apagado", () => (i.settings.enabled = true)],
      ["sin_telefono", () => (i.lead.phone = "987654321")],
      ["no_contactar", () => (i.lead.contact_opt_out_at = null)],
      ["no_contactar", () => (i.doNotCall = false)],
      ["ya_compro", () => (i.lead.has_order = false)],
      ["fuera_de_campana", () => (i.campaignId = CAMPANA)],
      ["perdido", () => (i.lead.category = "open")],
      ["poco_interes", () => (i.lead.inbound_count = 2)],
      ["callback_pendiente", () => (i.lead.status = "no_responde")],
      ["estado", () => (i.lead.status = "nuevo")],
      ["atendido_por_asesora", () => (i.humanTouched = false)],
      ["reservado", () => (i.lead.claimed_at = null)],
      ["muy_pronto", () => (i.lead.last_inbound_at = hace(49 * H))],
      ["muy_antiguo", () => (i.lead.last_inbound_at = hace(3 * H))],
      ["grupo_control", () => (i.arm = "tratamiento")],
      ["llamada_abierta", () => (i.attempts = i.attempts.filter((a) => a.status !== "queued"))],
      ["intentos_agotados", () => (i.settings.maxAttempts = 3)],
      ["reintento_pronto", () => (i.attempts = [intento(hace(10 * H)), intento(hace(4 * H), "completed", "volver_a_llamar")])],
    ];
    for (const [esperada, arreglar] of pasos) {
      expect(razon(i)).toBe(esperada);
      arreglar();
    }
    expect(leadVoiceEligible(i)).toEqual({ ok: true, kind: "primera", arm: "tratamiento", assignNow: false });
    expect([...new Set(pasos.map(([r]) => r))]).toEqual([...LEAD_VOICE_EXCLUSIONS]);
  });

  it("un celular con +51 y espacios sí vale", () => {
    expect(razon(input({ lead: { phone: "+51 987 654 321" } }))).toBe("ok");
  });

  it("una reserva vencida ya no lo frena", () => {
    expect(razon(input({ lead: { claimed_at: hace((CLAIM_TTL_MINUTES + 1) * MIN) } }))).toBe("ok");
  });

  it("sin last_inbound_at mide la ventana desde first_seen_at", () => {
    expect(razon(input({ lead: { last_inbound_at: null, first_seen_at: hace(3 * H) } }))).toBe("ok");
    expect(razon(input({ lead: { last_inbound_at: null, first_seen_at: hace(30 * MIN) } }))).toBe("muy_pronto");
  });

  it("la espera y la ventana salen de los ajustes de la tienda", () => {
    const reciente = { lead: { last_inbound_at: hace(30 * MIN) } };
    expect(razon(input({ ...reciente, settings: { waitMinutes: 0 } }))).toBe("ok");
    const viejo = { lead: { last_inbound_at: hace(60 * H) } };
    expect(razon(input({ ...viejo, settings: { maxAgeHours: 72 } }))).toBe("ok");
  });
});

// ── El sorteo y el grupo de control ─────────────────────────────────────────

describe("leadVoiceArm: el sorteo del grupo de control", () => {
  const IDS = idsSembrados(20_000, 1210);
  const controlShare = (holdout: number) => IDS.filter((id) => leadVoiceArm(id, holdout) === "control").length / IDS.length;

  it("es determinista y es assignArm con la sal propia del piloto", () => {
    for (const id of IDS.slice(0, 300)) {
      expect(leadVoiceArm(id, 50)).toBe(leadVoiceArm(id, 50));
      expect(leadVoiceArm(id, 50)).toBe(assignArm(id, LEAD_VOICE_EXPERIMENT, 0.5));
      expect(leadVoiceArm(id, 30)).toBe(assignArm(id, LEAD_VOICE_EXPERIMENT, 0.7));
    }
    expect(LEAD_VOICE_EXPERIMENT).toBe("agente_voz_leads_v1");
  });

  it.each([50, 30, 10, 90])("con %i %% de control, el control es ese porcentaje (±1,5 puntos)", (holdout) => {
    const share = controlShare(holdout);
    expect(share).toBeGreaterThan(holdout / 100 - 0.015);
    expect(share).toBeLessThan(holdout / 100 + 0.015);
  });

  it("0 llama a todos, 100 a nadie, y un porcentaje fuera de rango se acota", () => {
    const ids = IDS.slice(0, 500);
    expect(ids.every((id) => leadVoiceArm(id, 0) === "tratamiento")).toBe(true);
    expect(ids.every((id) => leadVoiceArm(id, 100) === "control")).toBe(true);
    expect(ids.every((id) => leadVoiceArm(id, -10) === "tratamiento")).toBe(true);
    expect(ids.every((id) => leadVoiceArm(id, 150) === "control")).toBe(true);
    // Un ajuste roto no reparte raro: vuelve al defecto de 0247 (50 %).
    expect(ids.every((id) => leadVoiceArm(id, Number.NaN) === leadVoiceArm(id, 50))).toBe(true);
  });

  // Diseño factorial (decisión 5): los leads del piloto ya están repartidos en
  // frio_cobertura_v1. Si el brazo del agente dependiera de aquél, cada
  // experimento mediría en parte el tratamiento del otro.
  it("es independiente de frio_cobertura_v1: correlación ≈ 0", () => {
    const voz = IDS.map((id) => leadVoiceArm(id, 50) === "tratamiento");
    const frio = IDS.map((id) => assignArm(id, FRIO_COVERAGE_EXPERIMENT) === "tratamiento");
    expect(Math.abs(phi(voz, frio))).toBeLessThan(0.03);
    // Y dentro de CADA brazo de frío, el agente reparte la misma mitad.
    const enFrio = (brazo: boolean) => {
      const sub = voz.filter((_, i) => frio[i] === brazo);
      return sub.filter(Boolean).length / sub.length;
    };
    expect(Math.abs(enFrio(true) - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(enFrio(false) - 0.5)).toBeLessThan(0.03);
  });

  it("ni con la misma fracción repite los brazos de frio_cobertura_v1", () => {
    const iguales = IDS.filter((id) => leadVoiceArm(id, 50) === assignArm(id, FRIO_COVERAGE_EXPERIMENT, 0.5)).length;
    // Con la misma sal coincidirían el 100 %; independientes, la mitad.
    expect(Math.abs(iguales / IDS.length - 0.5)).toBeLessThan(0.015);
  });
});

describe("el grupo de control nunca se llama", () => {
  it("con el brazo control guardado no entra, sea primera llamada o volver a llamar", () => {
    const esperado = { ok: false, reason: "grupo_control", arm: "control", assignNow: false };
    expect(leadVoiceEligible(input({ arm: "control" }))).toEqual(esperado);
    expect(leadVoiceEligible(agendado({ arm: "control" }))).toEqual(esperado);
  });

  it("sorteado al vuelo: cada control sale «grupo_control» y solo el tratamiento llama", () => {
    const ids = idsSembrados(2_000, 33);
    let control = 0;
    for (const id of ids) {
      const r = leadVoiceEligible(input({ lead: { id }, settings: { holdoutPct: 50 } }));
      expect(r.assignNow).toBe(true);
      if (r.arm === "control") {
        control++;
        expect(r).toEqual({ ok: false, reason: "grupo_control", arm: "control", assignNow: true });
      } else {
        expect(r).toEqual({ ok: true, kind: "primera", arm: "tratamiento", assignNow: true });
      }
    }
    expect(control / ids.length).toBeGreaterThan(0.45);
    expect(control / ids.length).toBeLessThan(0.55);
  });

  it("el brazo se sortea recién cuando el lead es elegible (si no, no se guarda nada)", () => {
    expect(leadVoiceEligible(input({ lead: { last_inbound_at: hace(30 * MIN) } }))).toEqual({
      ok: false,
      reason: "muy_pronto",
      arm: null,
      assignNow: false,
    });
  });

  it("un brazo ya guardado manda aunque la tienda cambie el porcentaje", () => {
    for (const id of idsSembrados(50, 7)) {
      expect(leadVoiceEligible(input({ lead: { id }, settings: { holdoutPct: 100 }, arm: "tratamiento" }))).toEqual({
        ok: true,
        kind: "primera",
        arm: "tratamiento",
        assignNow: false,
      });
    }
  });

  // Intención de tratar: el lead elegible entra al experimento aunque esta vez
  // no se le pueda llamar (llamada abierta, tope, descanso).
  it("elegible pero ocupado: igual se guarda su brazo", () => {
    expect(leadVoiceEligible(input({ attempts: [intento(hace(MIN), "in_progress", null)] }))).toEqual({
      ok: false,
      reason: "llamada_abierta",
      arm: "tratamiento",
      assignNow: true,
    });
  });
});

// ── Intentos y descanso ─────────────────────────────────────────────────────

describe("intentos", () => {
  it("attemptCounts: solo la fila que Telnyx rechazó antes de marcar (cancelled) no gasta intento", () => {
    const x = hace(H);
    expect(attemptCounts(intento(x, "cancelled", "sin_resultado"))).toBe(false);
    // El puente al agente falló con la persona ya en línea: sí gasta, o el
    // agente la volvería a llamar cada tres horas sin tope.
    expect(attemptCounts(intento(x, "failed", "sin_resultado"))).toBe(true);
    expect(attemptCounts(intento(x, "completed", "no_contesta"))).toBe(true);
    expect(attemptCounts(intento(x, "failed", "no_contesta"))).toBe(true);
    expect(attemptCounts(intento(x, "completed", "sin_resultado"))).toBe(true);
    expect(attemptCounts(intento(x, "completed", "atender_ahora"))).toBe(true);
    expect(attemptCounts(intento(x, "dialing", null))).toBe(true);
  });

  it("las que Telnyx rechazó no agotan el tope", () => {
    const attempts = [
      intento(hace(20 * H), "cancelled", "sin_resultado"),
      intento(hace(15 * H), "cancelled", "sin_resultado"),
      intento(hace(10 * H), "cancelled", "sin_resultado"),
      intento(hace(5 * H)),
    ];
    expect(razon(input({ attempts }))).toBe("ok");
  });

  it("las que se cortaron por el puente al agente sí lo agotan", () => {
    const attempts = [intento(hace(20 * H), "failed", "sin_resultado"), intento(hace(10 * H), "failed", "sin_resultado")];
    expect(razon(input({ attempts }))).toBe("intentos_agotados");
  });

  it("el tope es el de la tienda", () => {
    const dos = [intento(hace(20 * H)), intento(hace(10 * H))];
    expect(razon(input({ attempts: dos, settings: { maxAttempts: 2 } }))).toBe("intentos_agotados");
    expect(razon(input({ attempts: dos, settings: { maxAttempts: 3 } }))).toBe("ok");
    expect(razon(input({ attempts: [intento(hace(10 * H))], settings: { maxAttempts: 1 } }))).toBe("intentos_agotados");
  });

  it("cualquier fila abierta del agente es «llamada_abierta»", () => {
    for (const status of ["queued", "dialing", "in_progress"]) {
      expect(razon(input({ attempts: [intento(hace(5 * H), status, null)] }))).toBe("llamada_abierta");
    }
  });
});

describe("descanso entre intentos", () => {
  it(`espera ${LEAD_VOICE_RETRY_GAP_HOURS} h desde el último intento`, () => {
    expect(LEAD_VOICE_RETRY_GAP_HOURS).toBe(3);
    expect(razon(input({ attempts: [intento(hace(3 * H - MIN))] }))).toBe("reintento_pronto");
    expect(razon(input({ attempts: [intento(hace(3 * H + MIN))] }))).toBe("ok");
  });

  it("mira el último por queued_at aunque las filas lleguen desordenadas", () => {
    const s = { maxAttempts: 3 };
    expect(razon(input({ settings: s, attempts: [intento(hace(H)), intento(hace(10 * H))] }))).toBe("reintento_pronto");
    expect(razon(input({ settings: s, attempts: [intento(hace(10 * H)), intento(hace(H))] }))).toBe("reintento_pronto");
  });

  // Una fila que Telnyx rechazó no gasta intento, pero sí descanso: sin él, un
  // número que Telnyx siempre rechaza encabezaría la cola en cada pasada del
  // barrido (cada 5 min) y se comería su turno.
  it("también descansa tras una llamada que no salió", () => {
    expect(razon(input({ attempts: [intento(hace(H), "cancelled", "sin_resultado")] }))).toBe("reintento_pronto");
  });

  it("el «volver a llamar» no espera el descanso: la persona pidió esa hora", () => {
    const r = leadVoiceEligible(agendado({ attempts: [intento(hace(H), "completed", "volver_a_llamar")] }));
    expect(r).toEqual({ ok: true, kind: "volver_a_llamar", arm: "tratamiento", assignNow: true });
  });
});

describe("volver a llamar", () => {
  it("antes de la hora pedida: callback_pendiente", () => {
    expect(razon(agendado({ lead: { next_followup_at: en(MIN) } }))).toBe("callback_pendiente");
  });

  it("vencida la hora: entra como «volver_a_llamar»", () => {
    const r = leadVoiceEligible(agendado());
    expect(r.ok && r.kind).toBe("volver_a_llamar");
  });

  it("no mira la espera de las asesoras ni lo viejo del último mensaje", () => {
    expect(razon(agendado({ lead: { last_inbound_at: hace(5 * MIN) } }))).toBe("ok");
    expect(razon(agendado({ lead: { last_inbound_at: hace(100 * H) } }))).toBe("ok");
  });

  it("la ventana se cuenta desde la hora pedida", () => {
    expect(razon(agendado({ lead: { next_followup_at: hace(47 * H) } }))).toBe("ok");
    expect(razon(agendado({ lead: { next_followup_at: hace(49 * H) } }))).toBe("muy_antiguo");
  });

  it("si lo agendó una asesora y no el agente, no es del agente: «estado»", () => {
    expect(razon(agendado({ attempts: [] }))).toBe("estado");
    expect(razon(agendado({ attempts: [intento(hace(4 * H), "completed", "no_compra")] }))).toBe("estado");
  });

  it("si la llamada de vuelta no contestó, el agente no insiste", () => {
    const attempts = [intento(hace(10 * H), "completed", "volver_a_llamar"), intento(hace(4 * H), "completed", "no_contesta")];
    expect(razon(agendado({ attempts }))).toBe("estado");
  });

  it("sin hora guardada no hay vuelta: «estado»", () => {
    expect(razon(agendado({ lead: { next_followup_at: null } }))).toBe("estado");
  });

  it("la hora pendiente se informa antes que lo que pase después (asesora, reserva)", () => {
    expect(razon(agendado({ lead: { next_followup_at: en(H), claimed_at: hace(MIN) }, humanTouched: true }))).toBe(
      "callback_pendiente",
    );
    expect(razon(agendado({ humanTouched: true }))).toBe("atendido_por_asesora");
  });

  it("el tope de intentos también vale para la vuelta", () => {
    expect(razon(agendado({ settings: { maxAttempts: 1 } }))).toBe("intentos_agotados");
  });
});

// ── El orden de la cola ─────────────────────────────────────────────────────

describe("sortLeadVoiceQueue", () => {
  type C = LeadVoiceCandidate & { tag: string };
  const c = (tag: string, kind: C["kind"], over: Partial<LeadVoiceLead>): C => ({ tag, kind, lead: lead(over) });

  it("primero los «volver a llamar» (el más antiguo), después las primeras (la más reciente)", () => {
    const cola: C[] = [
      c("p-5h", "primera", { last_inbound_at: hace(5 * H) }),
      c("v-10m", "volver_a_llamar", { next_followup_at: hace(10 * MIN) }),
      c("p-3h", "primera", { last_inbound_at: hace(3 * H) }),
      c("v-2h", "volver_a_llamar", { next_followup_at: hace(2 * H) }),
      c("p-4h-sin-inbound", "primera", { last_inbound_at: null, first_seen_at: hace(4 * H) }),
    ];
    const antes = cola.map((x) => x.tag);
    expect(sortLeadVoiceQueue(cola).map((x) => x.tag)).toEqual(["v-2h", "v-10m", "p-3h", "p-4h-sin-inbound", "p-5h"]);
    // No reordena la lista que recibe.
    expect(cola.map((x) => x.tag)).toEqual(antes);
  });
});

// ── Lo que el agente escucha ────────────────────────────────────────────────

describe("chatParaAgente", () => {
  const m = (dir: ChatMessage["dir"], text: string, mediaKind: string | null = null): ChatMessage => ({ dir, text, mediaKind });

  it("rotula Cliente/Tienda y respeta el orden de la conversación", () => {
    expect(chatParaAgente([m("inbound", "Hola"), m("outbound", "Buen día, ¿en qué le ayudo?"), m("inbound", "¿Precio?")])).toBe(
      "Cliente: Hola\nTienda: Buen día, ¿en qué le ayudo?\nCliente: ¿Precio?",
    );
  });

  it("sin enlaces y con los espacios juntados", () => {
    expect(chatParaAgente([m("inbound", "mira https://tienda.example/products/x?ref=1  esto\n\n ya")])).toBe(
      "Cliente: mira [enlace] esto ya",
    );
  });

  it("un mensaje sin texto dice qué medio era; uno vacío no aparece", () => {
    const out = chatParaAgente([
      m("inbound", "", "image"),
      m("inbound", "  ", "audio"),
      m("outbound", "", "document"),
      m("inbound", "", "location"),
      m("inbound", "con foto", "image"),
      m("inbound", ""),
    ]);
    expect(out).toBe("Cliente: [imagen]\nCliente: [audio]\nTienda: [documento]\nCliente: [archivo]\nCliente: con foto");
  });

  it("un mensaje largo se corta a 240 caracteres", () => {
    const out = chatParaAgente([m("inbound", "a".repeat(500))]);
    expect(out).toBe(`Cliente: ${"a".repeat(237)}…`);
  });

  it("con tope de mensajes se quedan los más recientes", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => m(i % 2 ? "outbound" : "inbound", `m${i + 1}`));
    expect(chatParaAgente(msgs, { maxMsgs: 3 })).toBe("Tienda: m18\nCliente: m19\nTienda: m20");
  });

  // Corta en el primero que no cabe, sin saltar a uno más viejo y corto: el
  // agente nunca lee una conversación con un hueco en medio.
  it("con tope de caracteres se quedan los más recientes que quepan, sin huecos", () => {
    const msgs = [m("inbound", "viejo"), m("outbound", "x".repeat(200)), m("inbound", "último")];
    expect(chatParaAgente(msgs, { maxChars: 50 })).toBe("Cliente: último");
  });

  it("por defecto: 14 mensajes y 900 caracteres", () => {
    const cortos = Array.from({ length: 30 }, (_, i) => m("inbound", `hola ${i}`));
    expect(chatParaAgente(cortos).split("\n")).toHaveLength(14);
    const largos = Array.from({ length: 30 }, () => m("inbound", "b".repeat(100)));
    const out = chatParaAgente(largos);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.split("\n")).toHaveLength(8);
  });

  it("sin mensajes, vacío", () => {
    expect(chatParaAgente([])).toBe("");
  });
});

describe("saludoLima", () => {
  it.each([
    ["2026-10-12T11:00:00.000Z", "buenos días"], // 06:00 Lima
    ["2026-10-12T16:59:00.000Z", "buenos días"], // 11:59
    ["2026-10-12T17:00:00.000Z", "buenas tardes"], // 12:00
    ["2026-10-12T23:59:00.000Z", "buenas tardes"], // 18:59
    ["2026-10-13T00:00:00.000Z", "buenas noches"], // 19:00, ya martes en UTC
    ["2026-10-13T04:59:00.000Z", "buenas noches"], // 23:59
  ])("%s ⇒ %s", (iso, saludo) => {
    expect(saludoLima(new Date(iso))).toBe(saludo);
  });
});

describe("nombreHablado", () => {
  it.each([
    ["GONZALO PÉREZ", "Gonzalo"],
    ["rosa quispe", "Rosa"],
    ["🌸 Rosa", "Rosa"],
    ["Ana_Lu", "Ana"],
    ["Al", "Al"],
    ["🌸", ""],
    [".", ""],
    ["123456", ""],
    ["J. Pérez", ""], // una inicial no es un nombre
    ["Mamá de Luis", ""],
    ["Sra. Carmen", ""],
    ["Tía Rosa", ""],
    ["", ""],
    [null, ""],
  ])("«%s» ⇒ «%s»", (name, hablado) => {
    expect(nombreHablado(name)).toBe(hablado);
  });
});

describe("consultaHablada", () => {
  it("sin enlaces, sin espacios de más y con tope de 200", () => {
    expect(consultaHablada("Hola https://tienda.example/products/a   info")).toBe("Hola info");
    const larga = consultaHablada("c".repeat(300));
    expect(larga).toHaveLength(198);
    expect(larga.endsWith("…")).toBe(true);
    expect(consultaHablada(null)).toBe("");
  });
});

describe("buildLeadFicha y leadVoiceInitiation", () => {
  const fichaInput = (over: Partial<LeadFichaInput> = {}): LeadFichaInput => ({
    lead: {
      name: "Rosa Quispe",
      first_inbound_text: "Hola, quiero info https://tienda.example/products/shampoo",
      district: "  Cayma ",
      ad_headline: "Shampoo anticaspa",
    },
    storeName: "Biru Peru",
    settings: { product: "Shampoo anticaspa", offer: "1 unidad o el 3x2" },
    chat: "Cliente: Hola",
    now: NOW,
    attempt: 1,
    kind: "primera",
    mode: "real",
    ...over,
  });
  const FICHA_KEYS = LEAD_VOICE_VARS.filter((k) => k !== "voice_call_id" && k !== "encontrada");

  it("la ficha lleva cada variable, todas como texto", () => {
    const f = buildLeadFicha(fichaInput());
    expect(Object.keys(f).sort()).toEqual([...FICHA_KEYS].sort());
    for (const v of Object.values(f)) expect(typeof v).toBe("string");
    expect(f).toEqual({
      modo: "real",
      tienda: "Biru",
      nombre: "Rosa",
      producto: "Shampoo anticaspa",
      oferta: "1 unidad o el 3x2",
      consulta: "Hola, quiero info",
      chat: "Cliente: Hola",
      distrito_chat: "Cayma",
      hoy: voiceDates(NOW).hoy,
      hoy_texto: voiceDates(NOW).hoy_texto,
      saludo: "buenas tardes",
      intento: "1",
      es_volver_a_llamar: "no",
    });
    expect(f.hoy_texto).toBe("lunes 12 de octubre");
    expect(f.hoy).toBe("2026-10-12");
  });

  it("el producto sale de los ajustes, si no del anuncio, si no una frase neutra", () => {
    expect(buildLeadFicha(fichaInput({ settings: { product: "", offer: "" } })).producto).toBe("Shampoo anticaspa");
    const sinNada = fichaInput({ settings: { product: "", offer: "" } });
    sinNada.lead = { ...sinNada.lead, ad_headline: null };
    expect(buildLeadFicha(sinNada).producto).toBe("el producto que vio en el anuncio");
  });

  it("intento desde 1, vuelta, modo prueba y oferta con tope", () => {
    const f = buildLeadFicha(fichaInput({ attempt: 0, kind: "volver_a_llamar", mode: "test", settings: { product: "x", offer: "o".repeat(1000) } }));
    expect(f.intento).toBe("1");
    expect(f.es_volver_a_llamar).toBe("si");
    expect(f.modo).toBe("test");
    expect(f.oferta).toHaveLength(800);
    expect(buildLeadFicha(fichaInput({ attempt: 2 })).intento).toBe("2");
  });

  it("con llamada: todas las variables, encontrada «si» y el saludo con el nombre", () => {
    const init = leadVoiceInitiation("call-1", buildLeadFicha(fichaInput()));
    expect(init.type).toBe("conversation_initiation_client_data");
    expect(Object.keys(init.dynamic_variables).sort()).toEqual([...LEAD_VOICE_VARS].sort());
    for (const v of Object.values(init.dynamic_variables)) expect(typeof v).toBe("string");
    expect(init.dynamic_variables).toMatchObject({ voice_call_id: "call-1", encontrada: "si", nombre: "Rosa", modo: "real" });
    expect(init.conversation_config_override.agent.first_message).toBe("Hola, buenas tardes. ¿Hablo con Rosa?");
  });

  it("sin nombre que decir, pregunta con quién habla", () => {
    const f = buildLeadFicha(fichaInput({ lead: { name: "🌸" } }));
    expect(leadVoiceInitiation("call-1", f).conversation_config_override.agent.first_message).toBe(
      "Hola, buenas tardes. ¿Con quién tengo el gusto?",
    );
  });

  // ElevenLabs no arranca si falta una variable que el prompt usa: sin llamada
  // van todas, vacías, y el agente se despide con «encontrada = no».
  it.each([
    ["sin fila ni ficha", null, null],
    ["con ficha pero sin fila", null, "ficha"],
    ["con fila pero sin ficha", "call-1", null],
  ])("%s: encontrada «no», nada del lead y un saludo neutro", (_c, callId, conFicha) => {
    const init = leadVoiceInitiation(callId, conFicha ? buildLeadFicha(fichaInput()) : null);
    expect(Object.keys(init.dynamic_variables).sort()).toEqual([...LEAD_VOICE_VARS].sort());
    for (const [k, v] of Object.entries(init.dynamic_variables)) expect(v).toBe(k === "encontrada" ? "no" : "");
    expect(init.conversation_config_override.agent.first_message).toBe("Hola, buenas.");
  });

  it("una ficha vieja o incompleta da texto vacío, y lo que no es variable no viaja", () => {
    const ficha = { ...buildLeadFicha(fichaInput()), telefono: "51987654321" } as Partial<LeadFicha>;
    delete ficha.oferta;
    const init = leadVoiceInitiation("call-1", ficha as LeadFicha);
    expect(init.dynamic_variables.oferta).toBe("");
    expect(JSON.stringify(init)).not.toContain("987654321");
  });
});

// ── Cobertura que explica el agente ─────────────────────────────────────────

describe("coberturaParaAgente", () => {
  it("Lima y provincia COD: contraentrega, sin adelanto", () => {
    for (const kind of ["lima", "provincia_cod"]) {
      const c = coberturaParaAgente(kind);
      expect(c).toMatchObject({ cobertura: kind, pago: "contraentrega", adelanto: "" });
      expect(c.mensaje).toContain("sin adelanto");
    }
  });

  it("agencia: el adelanto es ADELANTO_MINIMO_LABEL y el pago lo ve una asesora", () => {
    const c = coberturaParaAgente("agencia");
    expect(c).toMatchObject({ cobertura: "agencia", pago: "adelanto", adelanto: ADELANTO_MINIMO_LABEL });
    expect(c.mensaje).toContain(ADELANTO_MINIMO_LABEL);
    expect(c.mensaje).toContain("asesora");
  });

  it.each([null, undefined, "por_revisar", "otra_cosa"])("%s ⇒ por revisar", (kind) => {
    expect(coberturaParaAgente(kind)).toMatchObject({ cobertura: "por_revisar", pago: "por_confirmar", adelanto: "" });
  });

  it("el número del adelanto no está escrito a mano (§12)", () => {
    const src = readFileSync(new URL("../lib/voice-leads.ts", import.meta.url), "utf8");
    expect(src).toContain('from "@/lib/adelanto-minimo"');
    expect(src).not.toMatch(/S\/\s?\d/);
  });
});

// ── registrar_resultado_lead ────────────────────────────────────────────────

type Apply = Extract<LeadResultAction, { kind: "apply" }>;
const aplicar = (body: LeadResultInput): Apply => {
  const a = translateLeadResult(body, NOW);
  if (a.kind !== "apply") throw new Error(a.error);
  return a;
};

describe("translateLeadResult", () => {
  it("rechaza un resultado fuera del catálogo y dice cuáles valen", () => {
    for (const resultado of [undefined, "", "confirma", "asesora"]) {
      const a = translateLeadResult({ resultado }, NOW);
      expect(a.kind).toBe("invalid");
      if (a.kind === "invalid") for (const r of LEAD_VOICE_RESULTS) expect(a.error).toContain(r);
    }
  });

  it("acepta mayúsculas y espacios alrededor", () => {
    expect(aplicar({ resultado: "  ATENDER_AHORA " }).outcome).toBe("atender_ahora");
  });

  it("atender_ahora: «Atender ahora» con la captura limpia y seguimiento automático", () => {
    const a = aplicar({
      resultado: "atender_ahora",
      nombre: "  Rosa   Quispe ",
      distrito: "Cayma",
      provincia: "Arequipa",
      departamento: "Arequipa",
      direccion: "Calle Los Pinos 123",
      referencia: "frente al parque",
      promo: "3x2",
      cantidad: "3",
      resumen: "Quiere el 3x2.",
    });
    expect(a).toEqual({
      kind: "apply",
      outcome: "atender_ahora",
      status: "casi_cierra",
      needsAttention: true,
      handoffContext:
        "Agente de voz: quiere comprar. Pide: 3x2, 3 unidades. Nombre: Rosa Quispe. Lugar: Cayma, Arequipa, Arequipa. " +
        "Dirección: Calle Los Pinos 123. Referencia: frente al parque. Quiere el 3x2.",
      followup: "default",
      optOut: false,
      motivo: null,
      captura: {
        nombre: "Rosa Quispe",
        distrito: "Cayma",
        provincia: "Arequipa",
        departamento: "Arequipa",
        direccion: "Calle Los Pinos 123",
        referencia: "frente al parque",
        promo: "3x2",
        cantidad: 3,
      },
      resumen: "Quiere el 3x2.",
      note: "Agente de voz · Quiere comprar: pasa a una asesora · Quiere el 3x2.",
    });
  });

  it.each<[LeadResultInput["cantidad"], number | null]>([
    [3, 3],
    ["3", 3],
    ["3 unidades", 3],
    [99, 99],
    // El primer número, no los dígitos pegados (antes: 23, 53 y 25).
    ["2 o 3", 2],
    ["5x3", 5],
    [2.5, 2],
    ["0", null],
    ["100", null],
    ["dos", null],
    ["", null],
    [null, null],
  ])("cantidad %j ⇒ %j", (cantidad, esperada) => {
    expect(aplicar({ resultado: "atender_ahora", cantidad }).captura?.cantidad).toBe(esperada);
  });

  it("la captura se recorta a lo que cabe", () => {
    const c = aplicar({ resultado: "atender_ahora", direccion: "d".repeat(500), nombre: "n".repeat(200) }).captura as LeadCaptura;
    expect(c.direccion).toHaveLength(200);
    expect(c.nombre).toHaveLength(80);
  });

  it("volver_a_llamar: la hora que pidió, en Lima", () => {
    const a = aplicar({ resultado: "volver_a_llamar", fecha: "2026-10-13", hora: "15:30", resumen: "Está manejando." });
    expect(a).toMatchObject({
      outcome: "volver_a_llamar",
      status: "volver_a_llamar",
      needsAttention: false,
      handoffContext: null,
      followup: { at: "2026-10-13T20:30:00.000Z" },
      captura: null,
      motivo: null,
    });
  });

  it("volver_a_llamar sin una hora futura válida: la automática", () => {
    expect(aplicar({ resultado: "volver_a_llamar" }).followup).toBe("default");
    expect(aplicar({ resultado: "volver_a_llamar", fecha: "2026-10-12", hora: "10:00" }).followup).toBe("default");
    expect(aplicar({ resultado: "volver_a_llamar", fecha: "mañana" }).followup).toBe("default");
  });

  it.each(LEAD_VOICE_MOTIVOS)("no_compra por %s: su estado de Perdidos y el motivo en la nota", (motivo) => {
    const a = aplicar({ resultado: "no_compra", motivo, resumen: "Gracias." });
    expect(a).toMatchObject({
      status: LEAD_VOICE_MOTIVO_STATUS[motivo],
      needsAttention: false,
      handoffContext: null,
      followup: "clear",
      optOut: false,
      motivo,
      captura: null,
    });
    expect(a.note).toBe(`Agente de voz · No compra (${LEAD_VOICE_MOTIVO_LABEL[motivo]}) · Gracias.`);
  });

  it("no_compra con un motivo inventado o sin motivo ⇒ «otro»", () => {
    expect(aplicar({ resultado: "no_compra", motivo: "caro" }).motivo).toBe("otro");
    expect(aplicar({ resultado: "no_compra" })).toMatchObject({ motivo: "otro", status: "cancelado_cliente" });
    expect(aplicar({ resultado: "no_compra", motivo: " PRECIO " }).motivo).toBe("precio");
  });

  it("el motivo solo cuenta en no_compra", () => {
    expect(aplicar({ resultado: "atender_ahora", motivo: "precio" }).motivo).toBeNull();
    expect(aplicar({ resultado: "volver_a_llamar", motivo: "precio" }).motivo).toBeNull();
  });

  it("no_llamar: cancelado por cliente y no contactar", () => {
    expect(aplicar({ resultado: "no_llamar" })).toMatchObject({
      status: "cancelado_cliente",
      optOut: true,
      followup: "clear",
      needsAttention: false,
      motivo: null,
    });
  });

  it("no_contesta: el lead no cambia", () => {
    expect(aplicar({ resultado: "no_contesta" })).toMatchObject({
      status: null,
      optOut: false,
      followup: "keep",
      needsAttention: false,
      handoffContext: null,
      captura: null,
    });
  });

  it("un resumen que dice «no me llamen» marca no contactar con cualquier resultado", () => {
    expect(aplicar({ resultado: "no_compra", motivo: "precio", resumen: "Dijo que no la vuelvan a llamar." }).optOut).toBe(true);
    expect(aplicar({ resultado: "no_contesta", resumen: "Contestó otra persona: no me llamen." })).toMatchObject({
      status: null,
      optOut: true,
    });
    expect(aplicar({ resultado: "no_compra", resumen: "No le interesa." }).optOut).toBe(false);
  });

  // El «sí» apaga también los WhatsApp automáticos: una frase que solo se
  // parece a «no me llamen» no puede dejar al lead sin contacto.
  it("pideNoContactar no se dispara con lo que solo se parece a un pedido", () => {
    for (const t of [
      "Dijo que no la llamaron antes.",
      "No llamar antes de las 10.",
      "Que no la llamen hasta el lunes.",
      "no lo llamen después de las 6",
      "Pide que no la llamen a las 3 porque trabaja.",
    ]) {
      expect(pideNoContactar(t), t).toBe(false);
    }
    for (const t of ["No me llamen más.", "Pidió que no la vuelvan a llamar", "no quiere que la llamen", "que no la sigan llamando"]) {
      expect(pideNoContactar(t), t).toBe(true);
    }
  });

  it("solo devuelve lo del catálogo: un dato que el agente agregue no viaja", () => {
    const body = { resultado: "atender_ahora", resumen: "ok", telefono: "51987654321" } as LeadResultInput;
    expect(JSON.stringify(aplicar(body))).not.toContain("987654321");
  });

  it("recorta resumen y nota", () => {
    const a = aplicar({ resultado: "no_compra", resumen: "r".repeat(3000) });
    expect(a.resumen).toHaveLength(1000);
    expect(a.note.length).toBeLessThanOrEqual(1200);
  });
});

describe("followupFrom", () => {
  it.each<[string | null, string | null, string | null]>([
    ["2026-10-13", "15:30", "2026-10-13T20:30:00.000Z"],
    ["2026-10-13", "9", "2026-10-13T14:00:00.000Z"],
    ["2026-10-13", null, "2026-10-13T15:00:00.000Z"], // sin hora, las 10:00
    ["2026-10-12", "12:30", "2026-10-12T17:30:00.000Z"], // hoy, más tarde
    ["2026-10-12", "12:00", null], // ahora mismo no es futuro
    ["2026-10-12", "10:00", null], // hoy, ya pasó
    ["2026-10-11", "15:00", null],
    ["2026-10-13", "25:00", null],
    ["2026-10-13", "10:75", null],
    ["2026-11-31", "10:00", null], // no existe: antes caía en el 1 de diciembre
    ["2027-02-29", "10:00", null], // 2027 no es bisiesto
    ["mañana", "10:00", null],
    ["13/10/2026", "10:00", null],
    [null, null, null],
  ])("%s %s ⇒ %s", (fecha, hora, esperado) => {
    expect(followupFrom(fecha, hora, NOW)).toBe(esperado);
  });

  it("el 29 de febrero de un año bisiesto sí existe", () => {
    expect(followupFrom("2028-02-29", "10:00", NOW)).toBe("2028-02-29T15:00:00.000Z");
  });
});

describe("leadPatchFor", () => {
  const NOW_ISO = NOW.toISOString();
  const DEF = "2026-10-13T14:00:00.000Z";
  const ctx = (currentFollowup: string | null = null) => ({ nowIso: NOW_ISO, defaultFollowup: DEF, currentFollowup });

  it("atender_ahora: casi cierra, «Atender ahora», handoff del agente y seguimiento automático", () => {
    const a = aplicar({ resultado: "atender_ahora", distrito: "Surco", resumen: "Quiere 2." });
    expect(leadPatchFor(a, ctx())).toEqual({
      status: "casi_cierra",
      category: "hot",
      needs_attention: true,
      last_interaction_at: NOW_ISO,
      handoff_reason: LEAD_VOICE_HANDOFF_REASON,
      handoff_context: a.handoffContext,
      handoff_at: NOW_ISO,
      next_followup_at: DEF,
    });
    expect(LEAD_VOICE_HANDOFF_REASON).toBe("agente_voz");
  });

  it("un seguimiento futuro que ya tenía se conserva; uno pasado se reemplaza", () => {
    const a = aplicar({ resultado: "atender_ahora" });
    expect(leadPatchFor(a, ctx(en(2 * H)))?.next_followup_at).toBe(en(2 * H));
    expect(leadPatchFor(a, ctx(hace(2 * H)))?.next_followup_at).toBe(DEF);
  });

  // Lo que llega de la base viene como «…+00:00», no como «….000Z»: la
  // comparación de texto tiene que seguir funcionando con ese formato.
  it("…también con el formato de Postgres", () => {
    const a = aplicar({ resultado: "atender_ahora" });
    expect(leadPatchFor(a, ctx("2026-10-12T19:00:00+00:00"))?.next_followup_at).toBe("2026-10-12T19:00:00+00:00");
    expect(leadPatchFor(a, ctx("2026-10-12T16:00:00+00:00"))?.next_followup_at).toBe(DEF);
    expect(leadPatchFor(a, ctx("2026-10-12T17:00:00+00:00"))?.next_followup_at).toBe(DEF);
  });

  it("volver_a_llamar con hora pedida la escribe aunque hubiera otra", () => {
    const a = aplicar({ resultado: "volver_a_llamar", fecha: "2026-10-13", hora: "15:30" });
    expect(leadPatchFor(a, ctx(en(5 * H)))).toEqual({
      status: "volver_a_llamar",
      category: "open",
      needs_attention: false,
      last_interaction_at: NOW_ISO,
      next_followup_at: "2026-10-13T20:30:00.000Z",
    });
  });

  it("volver_a_llamar sin hora válida: la futura que tenía o la automática", () => {
    const a = aplicar({ resultado: "volver_a_llamar" });
    expect(leadPatchFor(a, ctx(en(5 * H)))?.next_followup_at).toBe(en(5 * H));
    expect(leadPatchFor(a, ctx())?.next_followup_at).toBe(DEF);
  });

  it("no_compra: Perdidos y sin seguimiento, aunque tuviera uno futuro", () => {
    const a = aplicar({ resultado: "no_compra", motivo: "solo_miraba" });
    expect(leadPatchFor(a, ctx(en(H)))).toEqual({
      status: "solo_miraba",
      category: "lost",
      needs_attention: false,
      last_interaction_at: NOW_ISO,
      next_followup_at: null,
    });
  });

  it("no_llamar: no contactar además del estado", () => {
    expect(leadPatchFor(aplicar({ resultado: "no_llamar" }), ctx())).toEqual({
      contact_opt_out_at: NOW_ISO,
      status: "cancelado_cliente",
      category: "lost",
      needs_attention: false,
      last_interaction_at: NOW_ISO,
      next_followup_at: null,
    });
  });

  it("no_contesta: el lead no se toca", () => {
    expect(leadPatchFor(aplicar({ resultado: "no_contesta" }), ctx(en(H)))).toBeNull();
  });

  it("no_contesta con «no me llamen»: solo no contactar, sin estado ni última interacción", () => {
    expect(leadPatchFor(aplicar({ resultado: "no_contesta", resumen: "no me llamen" }), ctx())).toEqual({
      contact_opt_out_at: NOW_ISO,
    });
  });

  it("«keep» no toca el seguimiento", () => {
    const keep: Apply = { ...aplicar({ resultado: "volver_a_llamar" }), followup: "keep" };
    const patch = leadPatchFor(keep, ctx(en(H)));
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty("next_followup_at");
  });

  // categoryOf devuelve «open» para un código que no conoce: un estado mal
  // escrito dejaría a un lead perdido en la cola de las asesoras sin avisar.
  it("cada estado que escribe el agente es del catálogo de las asesoras", () => {
    for (const s of ["casi_cierra", "volver_a_llamar", "cancelado_cliente"]) expect(isValidStatus(s)).toBe(true);
    for (const s of Object.values(LEAD_VOICE_MOTIVO_STATUS)) {
      expect(isValidStatus(s)).toBe(true);
      expect(categoryOf(s)).toBe("lost");
    }
  });
});

describe("handoffContextFor", () => {
  const vacia: LeadCaptura = {
    nombre: "",
    distrito: "",
    provincia: "",
    departamento: "",
    direccion: "",
    referencia: "",
    promo: "",
    cantidad: null,
  };

  it("sin datos, solo la frase", () => {
    expect(handoffContextFor(vacia, "")).toBe("Agente de voz: quiere comprar.");
  });

  it("promo sola, cantidad sola en singular, y lugar con lo que haya", () => {
    expect(handoffContextFor({ ...vacia, promo: "3x2" }, "")).toBe("Agente de voz: quiere comprar. Pide: 3x2.");
    expect(handoffContextFor({ ...vacia, cantidad: 1 }, "")).toBe("Agente de voz: quiere comprar. Pide: 1 unidad.");
    expect(handoffContextFor({ ...vacia, provincia: "Arequipa" }, "Llamar hoy.")).toBe(
      "Agente de voz: quiere comprar. Lugar: Arequipa. Llamar hoy.",
    );
  });

  it("con tope de 1000 caracteres", () => {
    expect(handoffContextFor({ ...vacia, direccion: "d".repeat(200) }, "r".repeat(1000))).toHaveLength(1000);
  });
});

describe("noAnswerNote y el historial", () => {
  it("dice el intento y el tope, con el resumen si hay", () => {
    expect(noAnswerNote("", 1, 2)).toBe("Agente de voz · No contestó (intento 1 de 2)");
    expect(noAnswerNote("  Buzón   de voz ", 2, 2)).toBe("Agente de voz · No contestó (intento 2 de 2) · Buzón de voz");
    expect(noAnswerNote("x".repeat(500), 1, 2).length).toBeLessThanOrEqual("Agente de voz · No contestó (intento 1 de 2) · ".length + 300);
  });

  it("el título del historial lleva el estado aplicado, o nada si no hubo", () => {
    expect(leadVoiceTimelineTitle("casi_cierra")).toBe("🤖 Agente de voz · Casi cierra (dio datos)");
    expect(leadVoiceTimelineTitle(null)).toBe("🤖 Agente de voz");
  });
});

// ── Teléfono, ajustes y etiquetas ───────────────────────────────────────────

describe("leadVoicePhone", () => {
  it.each([
    ["987654321", "51987654321"],
    ["+51 987 654 321", "51987654321"],
    ["51987654321", "51987654321"],
    ["014567890", null], // fijo de Lima
    ["5114567890", null],
    ["98765432", null],
    ["", null],
    [null, null],
  ])("%s ⇒ %s", (phone, esperado) => {
    expect(leadVoicePhone(phone)).toBe(esperado);
  });
});

describe("leadVoiceSettingsFrom", () => {
  it("antes de 0247 (sin columnas) el agente queda apagado, con los defectos de la migración", () => {
    expect(leadVoiceSettingsFrom(null)).toEqual({
      enabled: false,
      auto: false,
      dailyCap: 40,
      maxAttempts: 2,
      waitMinutes: 120,
      maxAgeHours: 48,
      holdoutPct: 50,
      hourStart: 9,
      hourEnd: 20,
      campaignIds: [],
      product: "",
      offer: "",
    });
  });

  it("un 0 es un valor, no un hueco; las campañas se limpian", () => {
    const s = leadVoiceSettingsFrom({
      id: "t",
      name: "x",
      voice_lead_holdout_pct: 0,
      voice_lead_wait_minutes: 0,
      voice_lead_campaign_ids: [" 123 ", "", "456"],
      voice_lead_product: "  Shampoo ",
    });
    expect(s).toMatchObject({ holdoutPct: 0, waitMinutes: 0, campaignIds: ["123", "456"], product: "Shampoo" });
  });
});

describe("etiquetas del panel (lib/voice-lead-labels)", () => {
  // El módulo de etiquetas va aparte para el cliente; si se agrega un código
  // aquí y no allá, el panel mostraría el código crudo.
  it("cada exclusión, resultado y motivo tiene su texto", () => {
    expect(Object.keys(LEAD_VOICE_EXCLUSION_LABEL).sort()).toEqual([...LEAD_VOICE_EXCLUSIONS].sort());
    expect(Object.keys(LEAD_VOICE_OUTCOME_LABEL).sort()).toEqual([...LEAD_VOICE_OUTCOMES].sort());
    expect(Object.keys(LEAD_VOICE_MOTIVO_LABEL).sort()).toEqual([...LEAD_VOICE_MOTIVOS].sort());
  });
});
