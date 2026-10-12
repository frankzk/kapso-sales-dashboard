// Agente de voz para leads — el servidor (MOM §33): la cola con su sorteo, lo
// que se escribe sobre el lead, la llamada por Telnyx y el tablero del piloto.
// La base es un doble que anota cada consulta: se prueba QUÉ se escribe y con
// qué guardas, sin red ni Supabase.

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dnc: new Set<string>(),
  telnyxCfg: {
    apiKey: "k",
    connectionId: "conn",
    fromNumber: "+15550000001",
    xaiSipUri: "sip:xai@x",
    elevenLabsSipUri: "sip:el@x",
  } as Record<string, string> | { error: string },
  dial: { ok: true, callControlId: "cc-1" } as { ok: boolean; callControlId?: string; error?: string; response?: unknown },
  dialCalls: [] as { cfg: { fromNumber: string }; body: Record<string, unknown> }[],
  sweeps: 0,
}));

vi.mock("@/lib/voice-recovery-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-recovery-server")>()),
  sweepStaleCalls: vi.fn(async () => {
    mocks.sweeps += 1;
  }),
  telnyxConfig: vi.fn(() => mocks.telnyxCfg),
  loadDoNotCallPhones: vi.fn(async () => mocks.dnc),
}));
vi.mock("@/lib/telnyx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telnyx")>()),
  dialTelnyx: vi.fn(async (cfg: { fromNumber: string }, body: Record<string, unknown>) => {
    mocks.dialCalls.push({ cfg, body });
    return mocks.dial;
  }),
}));
vi.mock("@/lib/crypto", () => ({ decryptOrNull: (v: string | null | undefined) => (v ? "kapso-key" : null) }));

import { voiceToolAuthorized } from "@/lib/voice-recovery-server";
import {
  buildLeadContext,
  leadToolAuthorized,
  leadTranscriptFrom,
  leadVoiceConfigured,
  leadVoiceCoverage,
  loadLeadVoicePilotReport,
  loadLeadVoiceQueue,
  placeLeadCall,
  reflagAgentHandoffs,
  verifyElevenLabsSignature,
  type LeadVoiceQueueEntry,
  type LeadVoiceStore,
} from "@/lib/voice-leads-server";
import { applyLeadVoiceResult, loadLeadCall, writeLeadNoAnswer, type LeadCallRow } from "@/lib/voice-leads-writeback";
import {
  LEAD_VOICE_EXPERIMENT,
  leadVoiceArm,
  leadVoiceSettingsFrom,
  translateLeadResult,
  type LeadContext,
  type LeadResultAction,
} from "@/lib/voice-leads";

// ── Doble de Supabase ───────────────────────────────────────────────────────

type Filter = [string, ...unknown[]];
interface Q {
  table: string;
  op: "select" | "insert" | "update" | "delete" | "upsert";
  cols?: string;
  value?: any;
  filters: Filter[];
}
type Reply = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };

function fakeAdmin(respond: (q: Q) => Reply = () => ({}), rpcReply: Reply = {}) {
  const log: Q[] = [];
  const rpc: { fn: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const q: Q = { table, op: "select", filters: [] };
    const b: any = {};
    b.select = (cols: string) => {
      if (q.op === "select") q.cols = cols;
      return b;
    };
    for (const m of ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "not", "or"]) {
      b[m] = (...args: unknown[]) => {
        q.filters.push([m, ...args]);
        return b;
      };
    }
    for (const m of ["order", "limit", "range"]) b[m] = () => b;
    for (const m of ["insert", "update", "delete", "upsert"]) {
      b[m] = (v: unknown) => {
        q.op = m as Q["op"];
        q.value = v;
        return b;
      };
    }
    const run = () => {
      log.push(q);
      const r = respond(q);
      return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
    };
    b.single = async () => run();
    b.maybeSingle = async () => run();
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
    return b;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      return { data: rpcReply.data ?? null, error: rpcReply.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { admin, log, rpc };
}

const has = (q: Q, ...f: Filter) => q.filters.some((g) => JSON.stringify(g) === JSON.stringify(f));
const writes = (log: Q[], table?: string) => log.filter((q) => q.op !== "select" && (!table || q.table === table));

// ── Datos ───────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-12T17:00:00.000Z"); // 12:00 en Lima
const XAI = "secreto-xai";
const ELEVEN = "secreto-elevenlabs";
const LEADS = "secreto-leads";

beforeEach(() => {
  vi.stubEnv("VOICE_TOOLS_SECRET", XAI);
  vi.stubEnv("VOICE_TOOLS_SECRET_ELEVENLABS", ELEVEN);
  vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", LEADS);
  vi.stubEnv("TELNYX_LEADS_SIP_URI", "sip:leads@sip.rtc.elevenlabs.io");
  vi.stubEnv("TELNYX_LEADS_FROM_NUMBER", "+51100000000");
  vi.stubEnv("TELNYX_FROM_NUMBER", "+15550000001");
  mocks.dnc = new Set();
  mocks.telnyxCfg = { apiKey: "k", connectionId: "conn", fromNumber: "+15550000001", xaiSipUri: "sip:xai@x", elevenLabsSipUri: "sip:el@x" };
  mocks.dial = { ok: true, callControlId: "cc-1" };
  mocks.dialCalls = [];
  mocks.sweeps = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ctx = (over: Partial<LeadContext> = {}): LeadContext => ({
  ficha: {} as LeadContext["ficha"],
  estado_al_marcar: "nuevo",
  tipo: "primera",
  intento: 1,
  max_intentos: 2,
  campaign_id: "C1",
  chat_ok: true,
  ...over,
});

const call = (over: Partial<LeadCallRow> = {}): LeadCallRow => ({
  id: "vc-1",
  store_id: "store",
  lead_id: "lead-1",
  mode: "real",
  status: "in_progress",
  outcome: "atender_ahora",
  dialed_at: "2026-10-12T16:58:00.000Z",
  started_at: "2026-10-12T16:58:20.000Z",
  lead_context: ctx(),
  ...over,
});

const apply = (input: Parameters<typeof translateLeadResult>[0]) =>
  translateLeadResult(input, NOW) as Extract<LeadResultAction, { kind: "apply" }>;

// ── Autenticación ───────────────────────────────────────────────────────────

describe("la puerta del agente de leads (secreto propio)", () => {
  const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

  it("entra con VOICE_LEADS_TOOLS_SECRET, por x-voice-secret o Bearer", () => {
    expect(leadToolAuthorized(req({ "x-voice-secret": LEADS }))).toBe(true);
    expect(leadToolAuthorized(req({ authorization: `Bearer ${LEADS}` }))).toBe(true);
  });

  it("rechaza los secretos de Reproprovincia", () => {
    expect(leadToolAuthorized(req({ "x-voice-secret": XAI }))).toBe(false);
    expect(leadToolAuthorized(req({ "x-voice-secret": ELEVEN }))).toBe(false);
  });

  it("y las tools de Reproprovincia no aceptan el de leads", () => {
    expect(voiceToolAuthorized(req({ "x-voice-secret": LEADS }) as never)).toBe(false);
    expect(voiceToolAuthorized(req({ "x-voice-secret": ELEVEN }) as never)).toBe(true);
  });

  it("cerrado si el secreto falta o es el mismo que uno de Reproprovincia", () => {
    vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", "");
    expect(leadToolAuthorized(req({ "x-voice-secret": "" }))).toBe(false);
    vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", XAI);
    expect(leadToolAuthorized(req({ "x-voice-secret": XAI }))).toBe(false);
    vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", ELEVEN);
    expect(leadToolAuthorized(req({ "x-voice-secret": ELEVEN }))).toBe(false);
  });

  it("configurado = Telnyx + puerta SIP de leads + secreto propio", () => {
    expect(leadVoiceConfigured()).toBe(true);
    vi.stubEnv("TELNYX_LEADS_SIP_URI", "");
    expect(leadVoiceConfigured()).toBe(false);
    vi.stubEnv("TELNYX_LEADS_SIP_URI", "sip:leads@x");
    vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", XAI);
    expect(leadVoiceConfigured()).toBe(false);
    vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", LEADS);
    mocks.telnyxCfg = { error: "Falta configurar Telnyx" };
    expect(leadVoiceConfigured()).toBe(false);
  });
});

// ── Firma del aviso post-call ───────────────────────────────────────────────

describe("firma HMAC del aviso post-call de ElevenLabs", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "c1" } });
  const t = Math.floor(NOW.getTime() / 1000);
  const sign = (ts: number, raw = body, key = secret) =>
    `t=${ts},v0=${createHmac("sha256", key).update(`${ts}.${raw}`).digest("hex")}`;

  it("acepta la firma correcta", () => {
    expect(verifyElevenLabsSignature(body, sign(t), secret, NOW)).toBe(true);
    expect(verifyElevenLabsSignature(body, sign(t - 29 * 60), secret, NOW)).toBe(true);
  });

  it("rechaza cuerpo cambiado, otro secreto, firma vieja y cabeceras rotas", () => {
    expect(verifyElevenLabsSignature(`${body} `, sign(t), secret, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, sign(t, body, "otro"), secret, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, sign(t - 31 * 60), secret, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, `v0=${"a".repeat(64)}`, secret, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, "basura", secret, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, null, secret, NOW)).toBe(false);
  });

  it("sin secreto configurado no autoriza nada", () => {
    expect(verifyElevenLabsSignature(body, sign(t, body, ""), "", NOW)).toBe(false);
  });
});

describe("lo que se guarda de la transcripción", () => {
  it("turnos con rol en castellano, sin turnos vacíos, tope de 80 (los últimos) y 500 caracteres", () => {
    const transcript = [
      { role: "agent", message: "Hola, buenas tardes.", time_in_call_secs: 0 },
      { role: "user", message: null, time_in_call_secs: 2 },
      ...Array.from({ length: 90 }, (_, i) => ({ role: i % 2 ? "agent" : "user", message: `turno ${i} ${"x".repeat(600)}`, time_in_call_secs: i + 3 })),
    ];
    const out = leadTranscriptFrom({
      conversation_id: "conv_1",
      agent_id: "agent_leads",
      transcript,
      metadata: { call_duration_secs: 143, cost: 512 },
      analysis: { transcript_summary: "Quiere el 3x2." },
    });
    expect(out.turnos).toHaveLength(80);
    expect(out.turnos[79]!.texto.startsWith("turno 89")).toBe(true);
    expect(out.turnos.every((t) => t.texto.length <= 500)).toBe(true);
    expect(out.turnos[0]!.rol).toBe("cliente");
    expect(out).toMatchObject({ conversation_id: "conv_1", agent_id: "agent_leads", duracion_s: 143, costo: 512, resumen: "Quiere el 3x2." });
  });

  it("un aviso sin datos no rompe", () => {
    expect(leadTranscriptFrom(null)).toEqual({
      conversation_id: null,
      agent_id: null,
      duracion_s: null,
      costo: null,
      turnos: [],
      resumen: null,
    });
  });
});

// ── La fila de la llamada ───────────────────────────────────────────────────

describe("loadLeadCall", () => {
  it("una fila de pedido no es una llamada de lead", async () => {
    const { admin } = fakeAdmin(() => ({ data: { id: "vc", store_id: "s", lead_id: null, purpose: "order", mode: "real", status: "in_progress" } }));
    expect(await loadLeadCall(admin, "vc")).toBeNull();
  });

  it("una de lead vuelve con su contexto", async () => {
    const { admin, log } = fakeAdmin(() => ({
      data: { id: "vc", store_id: "s", lead_id: "l", purpose: "lead", mode: "test", status: "in_progress", outcome: null, dialed_at: null, started_at: null, lead_context: ctx() },
    }));
    expect(await loadLeadCall(admin, "vc")).toMatchObject({ id: "vc", lead_id: "l", mode: "test", lead_context: { estado_al_marcar: "nuevo" } });
    expect(log[0]!.cols).toContain("purpose");
  });
});

// ── Lo que se escribe sobre el lead ─────────────────────────────────────────

describe("applyLeadVoiceResult", () => {
  const leadRow = { id: "lead-1", status: "nuevo", category: "open", has_order: false, order_id: null, next_followup_at: null };
  const db = (opts: { lead?: object | null; human?: boolean; updated?: number } = {}) =>
    fakeAdmin((q) => {
      if (q.table === "leads" && q.op === "select") return { data: opts.lead === undefined ? leadRow : opts.lead };
      if (q.table === "stores") return { data: { timezone: "America/Lima", voice_lead_max_attempts: 2 } };
      if (q.table === "lead_calls" && q.op === "select") return { data: opts.human ? [{ id: "lc" }] : [] };
      if (q.table === "leads" && q.op === "update") {
        return { data: q.value.contact_opt_out_at && Object.keys(q.value).length === 1 ? null : Array.from({ length: opts.updated ?? 1 }, () => ({ id: "lead-1" })) };
      }
      return {};
    });

  it("modo prueba: no toca nada", async () => {
    const { admin, log } = db();
    const r = await applyLeadVoiceResult(admin, call({ mode: "test" }), apply({ resultado: "atender_ahora", resumen: "x" }), NOW);
    expect(r).toEqual({ applied: false, skipped: null, error: null });
    expect(log).toEqual([]);
  });

  it("«quiere comprar»: casi cierra en «Atender ahora», con guardas, y la captura NO va a leads", async () => {
    const { admin, log } = db();
    const r = await applyLeadVoiceResult(
      admin,
      call(),
      apply({ resultado: "atender_ahora", distrito: "Surco", direccion: "Av. Siempre Viva 123", nombre: "Ana", promo: "3x2", resumen: "Quiere el 3x2." }),
      NOW,
    );
    expect(r).toEqual({ applied: true, skipped: null, error: null });
    const upd = writes(log, "leads");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.value).toMatchObject({
      status: "casi_cierra",
      category: "hot",
      needs_attention: true,
      handoff_reason: "agente_voz",
      handoff_at: NOW.toISOString(),
    });
    expect(upd[0]!.value.handoff_context).toContain("Surco");
    for (const col of ["address1", "district", "province", "referencia", "ship_name"]) expect(upd[0]!.value).not.toHaveProperty(col);
    // La guarda: mismo estado que al marcar, abierto o caliente, sin pedido.
    expect(has(upd[0]!, "eq", "status", "nuevo")).toBe(true);
    expect(has(upd[0]!, "in", "category", ["open", "hot"])).toBe(true);
    expect(has(upd[0]!, "eq", "has_order", false)).toBe(true);
    expect(has(upd[0]!, "eq", "store_id", "store")).toBe(true);
    // Y antes miró si una asesora firmó algo después de marcar.
    const human = log.find((q) => q.table === "lead_calls" && q.op === "select")!;
    expect(has(human, "not", "vendedora", "is", null)).toBe(true);
    expect(has(human, "gt", "occurred_at", "2026-10-12T16:58:00.000Z")).toBe(true);

    const note = writes(log, "lead_calls")[0]!.value;
    expect(note).toMatchObject({ kind: "voice_agent", vendedora: null, new_status: "casi_cierra", lead_id: "lead-1", store_id: "store" });
    expect(note.next_followup_at).toBeTruthy();
    expect(note.note.startsWith("Agente de voz")).toBe(true);
  });

  it("una asesora lo gestionó durante la llamada: no se aplica, pero la nota queda", async () => {
    const { admin, log } = db({ human: true });
    const r = await applyLeadVoiceResult(admin, call(), apply({ resultado: "no_compra", motivo: "precio", resumen: "Caro." }), NOW);
    expect(r).toEqual({ applied: false, skipped: "gestion_humana_posterior", error: null });
    expect(writes(log, "leads")).toEqual([]);
    const note = writes(log, "lead_calls")[0]!.value;
    expect(note.new_status).toBeNull();
    expect(note.next_followup_at).toBeNull();
    expect(note.note.startsWith("(no aplicado: una asesora lo gestionó durante la llamada) Agente de voz")).toBe(true);
  });

  it("el estado cambió (el update condicional no tocó nada): estado_cambio", async () => {
    const { admin, log } = db({ updated: 0 });
    const r = await applyLeadVoiceResult(admin, call(), apply({ resultado: "volver_a_llamar", resumen: "Mañana." }), NOW);
    expect(r.skipped).toBe("estado_cambio");
    expect(writes(log, "lead_calls")[0]!.value.note).toContain("(no aplicado: el lead cambió de estado durante la llamada)");
  });

  it("un lead ya ganado no se toca", async () => {
    const { admin, log } = db({ lead: { ...leadRow, has_order: true, category: "won" } });
    const r = await applyLeadVoiceResult(admin, call(), apply({ resultado: "no_compra", resumen: "" }), NOW);
    expect(r.skipped).toBe("ganado");
    expect(writes(log, "leads")).toEqual([]);
  });

  it("«no me llamen» marca no contactar AUNQUE la guarda de estado no deje aplicar", async () => {
    const { admin, log } = db({ human: true });
    const r = await applyLeadVoiceResult(admin, call(), apply({ resultado: "no_llamar", resumen: "No me llamen." }), NOW);
    expect(r.applied).toBe(false);
    const upd = writes(log, "leads");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.value).toEqual({ contact_opt_out_at: NOW.toISOString() });
    expect(has(upd[0]!, "eq", "id", "lead-1")).toBe(true);
  });

  it("no contestó (lo registró el agente): el lead no cambia, solo la nota con el intento", async () => {
    const { admin, log } = db();
    const r = await applyLeadVoiceResult(admin, call({ lead_context: ctx({ intento: 2, max_intentos: 3 }) }), apply({ resultado: "no_contesta", resumen: "Buzón." }), NOW);
    expect(r).toEqual({ applied: false, skipped: null, error: null });
    expect(writes(log, "leads")).toEqual([]);
    const note = writes(log, "lead_calls")[0]!.value;
    expect(note).toMatchObject({ kind: "voice_agent", vendedora: null, new_status: null });
    expect(note.note).toContain("No contestó (intento 2 de 3)");
  });

  it("sin estado al marcar no hay guarda posible: no se aplica", async () => {
    const { admin, log } = db();
    const r = await applyLeadVoiceResult(admin, call({ lead_context: null }), apply({ resultado: "atender_ahora", resumen: "" }), NOW);
    expect(r.skipped).toBe("estado_cambio");
    expect(writes(log, "leads")).toEqual([]);
  });
});

describe("writeLeadNoAnswer (la línea o el vigilante)", () => {
  it("modo prueba: nada", async () => {
    const { admin, log } = fakeAdmin();
    await writeLeadNoAnswer(admin, { id: "vc", store_id: "s", lead_id: "l", mode: "test" }, "No contestó.", NOW);
    expect(log).toEqual([]);
  });

  it("cuenta los intentos que marcaron y no toca el lead", async () => {
    const { admin, log } = fakeAdmin((q) => {
      if (q.table === "voice_calls" && q.cols === "lead_context") return { data: { lead_context: ctx({ max_intentos: 3 }) } };
      if (q.table === "voice_calls") {
        return {
          data: [
            { queued_at: "2026-10-12T10:00:00Z", status: "completed", outcome: "no_contesta" },
            { queued_at: "2026-10-12T13:00:00Z", status: "cancelled", outcome: "sin_resultado" },
            { queued_at: "2026-10-12T16:58:00Z", status: "completed", outcome: "no_contesta" },
          ],
        };
      }
      return {};
    });
    await writeLeadNoAnswer(admin, { id: "vc", store_id: "s", lead_id: "l", mode: "real" }, "No contestó: la llamada no llegó al agente.", NOW);
    const attemptsQ = log.find((q) => q.table === "voice_calls" && q.cols !== "lead_context")!;
    expect(has(attemptsQ, "eq", "purpose", "lead")).toBe(true);
    expect(has(attemptsQ, "eq", "mode", "real")).toBe(true);
    expect(writes(log, "leads")).toEqual([]);
    const note = writes(log, "lead_calls")[0]!.value;
    expect(note).toMatchObject({ kind: "voice_agent", vendedora: null, new_status: null, lead_id: "l", store_id: "s" });
    expect(note.note).toContain("No contestó (intento 2 de 3)");
  });
});

// ── La cola ─────────────────────────────────────────────────────────────────

function idFor(arm: "tratamiento" | "control", skip = 0): string {
  for (let i = 0, found = 0; i < 10_000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    if (leadVoiceArm(id, 50) === arm && found++ === skip) return id;
  }
  throw new Error("sin id");
}

const store = (over: Record<string, unknown> = {}): LeadVoiceStore => {
  const row = {
    id: "store",
    name: "Kenku Peru",
    timezone: "America/Lima",
    voice_lead_enabled: true,
    voice_lead_auto: true,
    voice_lead_campaign_ids: ["C1"],
    voice_lead_product: "Shampoo Birú anticaspa",
    voice_lead_offer: "1 unidad S/ 85",
    ...over,
  };
  return { ...row, settings: leadVoiceSettingsFrom(row) };
};

const lead = (id: string, phone: string, over: Record<string, unknown> = {}) => ({
  id,
  store_id: "store",
  phone,
  name: "Ana Pérez",
  status: "nuevo",
  category: "open",
  has_order: false,
  order_id: null,
  source: "meta_ad",
  ad_id: "ad1",
  inbound_count: 3,
  first_seen_at: "2026-10-12T10:00:00.000Z",
  last_inbound_at: "2026-10-12T12:00:00.000Z",
  claimed_at: null,
  next_followup_at: null,
  contact_opt_out_at: null,
  first_inbound_text: "Hola, ¿precio?",
  district: null,
  ad_headline: "Biru",
  kapso_conversation_id: "conv-1",
  ...over,
});

describe("loadLeadVoiceQueue", () => {
  const T1 = idFor("tratamiento");
  const T2 = idFor("tratamiento", 1);
  const C1 = idFor("control");
  const TOUCHED = idFor("tratamiento", 2);
  const DNC = idFor("tratamiento", 3);

  const queueDb = (o: { insertError?: { message: string; code?: string }; perRowArm?: string; failTouches?: boolean; stored?: { lead_id: string; arm: string }[] } = {}) =>
    fakeAdmin((q) => {
      if (q.table === "leads") {
        return {
          data: [
            lead(T1, "51911111111", { last_inbound_at: "2026-10-12T13:00:00.000Z" }),
            lead(T2, "51922222222"),
            lead(C1, "51933333333"),
            lead(TOUCHED, "51944444444"),
            lead(DNC, "51955555555"),
          ],
        };
      }
      if (q.table === "meta_ads") return { data: [{ ad_id: "ad1", campaign_id: "C1" }] };
      if (q.table === "lead_calls") {
        if (o.failTouches) return { error: { message: "timeout" } };
        return { data: [{ lead_id: TOUCHED, occurred_at: "2026-10-12T11:00:00.000Z" }] };
      }
      if (q.table === "voice_calls") return { data: [] };
      if (q.table === "lead_experiments" && q.op === "select") {
        if (q.cols === "arm") return { data: { arm: o.perRowArm ?? "control" } };
        return { data: o.stored ?? [] };
      }
      if (q.table === "lead_experiments" && q.op === "insert") {
        if (o.insertError && Array.isArray(q.value)) return { error: o.insertError };
        if (o.insertError && !Array.isArray(q.value) && q.value.lead_id === T2) return { error: { message: "dup", code: "23505" } };
        return {};
      }
      return {};
    });

  beforeEach(() => {
    mocks.dnc = new Set(["955555555"]);
  });

  it("con sorteo: guarda el brazo de los elegibles (control incluido) y solo llama al tratamiento", async () => {
    const { admin, log } = queueDb();
    const q = await loadLeadVoiceQueue(admin, store(), NOW, { assign: true });
    expect(q.seen).toBe(5);
    expect(q.candidates.map((c) => c.lead.id)).toEqual([T1, T2]); // el que escribió más reciente primero
    expect(q.candidates[0]).toMatchObject({ kind: "primera", arm: "tratamiento", attempt: 1, campaignId: "C1" });
    expect(q.reasons).toEqual({ [C1]: "grupo_control", [TOUCHED]: "atendido_por_asesora", [DNC]: "no_contactar" });
    const insert = writes(log, "lead_experiments")[0]!;
    expect(insert.value.map((r: { lead_id: string }) => r.lead_id).sort()).toEqual([T1, T2, C1].sort());
    expect(insert.value.every((r: { experiment: string; store_id: string }) => r.experiment === LEAD_VOICE_EXPERIMENT && r.store_id === "store")).toBe(true);
    expect(q.assigned).toBe(3);
    expect(q.arms).toMatchObject({ [T1]: "tratamiento", [C1]: "control" });
    // La ventana va en la consulta; meta_ads con la llave de servicio.
    const leadsQ = log.find((x) => x.table === "leads")!;
    expect(leadsQ.filters.some((f) => f[0] === "or")).toBe(true);
    expect(has(leadsQ, "eq", "source", "meta_ad")).toBe(true);
    expect(has(leadsQ, "gte", "inbound_count", 2)).toBe(true);
    // Toques humanos: solo los firmados de llamada, mensaje o venta.
    const touches = log.find((x) => x.table === "lead_calls")!;
    expect(has(touches, "in", "kind", ["call", "message", "sale"])).toBe(true);
    expect(has(touches, "not", "vendedora", "is", null)).toBe(true);
    // Intentos: solo llamadas reales de lead.
    const attempts = log.find((x) => x.table === "voice_calls")!;
    expect(has(attempts, "eq", "purpose", "lead")).toBe(true);
    expect(has(attempts, "eq", "mode", "real")).toBe(true);
  });

  it("sin sorteo no escribe nada (panel, prueba en seco)", async () => {
    const { admin, log } = queueDb();
    const q = await loadLeadVoiceQueue(admin, store(), NOW);
    expect(writes(log)).toEqual([]);
    expect(q.assigned).toBe(0);
    expect(q.arms).toEqual({});
    expect(q.candidates).toHaveLength(2);
  });

  it("el brazo ya guardado manda sobre el sorteo", async () => {
    const { admin } = queueDb({ stored: [{ lead_id: T1, arm: "control" }] });
    const q = await loadLeadVoiceQueue(admin, store(), NOW, { assign: true });
    expect(q.candidates.map((c) => c.lead.id)).toEqual([T2]);
    expect(q.reasons[T1]).toBe("grupo_control");
  });

  it("otra pasada lo sorteó a la vez (23505): se lee el guardado; si no se pudo guardar, no se llama", async () => {
    const { admin } = queueDb({ insertError: { message: "dup", code: "23505" }, perRowArm: "control" });
    const q = await loadLeadVoiceQueue(admin, store(), NOW, { assign: true });
    // T2 chocó y quedó control en la base: no se llama.
    expect(q.candidates.map((c) => c.lead.id)).toEqual([T1]);
    expect(q.reasons[T2]).toBe("grupo_control");
    expect(q.arms[T2]).toBe("control");
  });

  it("falla cerrado: si una lectura falla, lanza (no hay candidatos)", async () => {
    const { admin } = queueDb({ failTouches: true });
    await expect(loadLeadVoiceQueue(admin, store(), NOW, { assign: true })).rejects.toThrow(/lead_calls/);
  });

  it("con un lead: sin ventana, y dice por qué no entra", async () => {
    const { admin, log } = fakeAdmin((q) => {
      if (q.table === "leads") return { data: [lead(T1, "51911111111", { status: "casi_cierra", category: "hot" })] };
      if (q.table === "meta_ads") return { data: [{ ad_id: "ad1", campaign_id: "C1" }] };
      return { data: [] };
    });
    const q = await loadLeadVoiceQueue(admin, store(), NOW, { leadId: T1 });
    const leadsQ = log.find((x) => x.table === "leads")!;
    expect(has(leadsQ, "eq", "id", T1)).toBe(true);
    expect(leadsQ.filters.some((f) => f[0] === "or")).toBe(false);
    expect(q.reasons[T1]).toBe("estado");
  });

  it("agente apagado en la tienda: nadie entra", async () => {
    const { admin } = queueDb();
    const q = await loadLeadVoiceQueue(admin, store({ voice_lead_enabled: false }), NOW, { assign: true });
    expect(q.candidates).toEqual([]);
    expect(new Set(Object.values(q.reasons))).toEqual(new Set(["agente_apagado"]));
  });
});

// ── Lo que el agente escucha ────────────────────────────────────────────────

describe("buildLeadContext", () => {
  const entry = (over: Record<string, unknown> = {}): LeadVoiceQueueEntry => ({
    lead: lead("lead-1", "51911111111", over) as never,
    kind: "primera",
    arm: "tratamiento",
    attempt: 1,
    campaignId: "C1",
  });
  const db = () => fakeAdmin((q) => (q.table === "stores" ? { data: { kapso_api_key_enc: "enc" } } : {}));

  it("con Kapso: la conversación va en la ficha", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "m1", direction: "inbound", timestamp: "2026-10-12T12:00:00Z", type: "text", text: { body: "Hola, ¿cuánto cuesta?" } },
            { id: "m2", direction: "outbound", timestamp: "2026-10-12T12:01:00Z", type: "text", text: { body: "S/ 85 https://tienda.pe/x" } },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const c = await buildLeadContext(db().admin, store(), entry(), NOW, "real");
    expect(c.chat_ok).toBe(true);
    expect(c.ficha.chat).toContain("Cliente: Hola, ¿cuánto cuesta?");
    expect(c.ficha.chat).not.toContain("https://");
    expect(c).toMatchObject({ estado_al_marcar: "nuevo", tipo: "primera", intento: 1, max_intentos: 2, campaign_id: "C1" });
    expect(c.ficha).toMatchObject({ modo: "real", nombre: "Ana", producto: "Shampoo Birú anticaspa", oferta: "1 unidad S/ 85" });
  });

  it("si Kapso falla, se llama igual sin chat (chat_ok = false)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    const c = await buildLeadContext(db().admin, store(), entry(), NOW, "test");
    expect(c.chat_ok).toBe(false);
    expect(c.ficha.chat).toBe("");
    expect(c.ficha.consulta).toBe("Hola, ¿precio?");
    expect(c.ficha.modo).toBe("test");
  });

  it("sin conversación de Kapso no se pregunta a Kapso", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = await buildLeadContext(db().admin, store(), entry({ kapso_conversation_id: null }), NOW, "real");
    expect(c.chat_ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── La llamada ──────────────────────────────────────────────────────────────

describe("placeLeadCall", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    storeId: "store",
    leadId: "lead-1",
    phone: "+51 987 654 321",
    mode: "real" as const,
    triggeredBy: null,
    context: ctx(),
    ...over,
  });

  it("marca por Telnyx con la fila de lead en su carril y el número de leads", async () => {
    const { admin, log } = fakeAdmin((q) => (q.op === "insert" ? { data: { id: "vc-9" } } : {}));
    const r = await placeLeadCall(admin, input(), NOW);
    expect(r).toEqual({ ok: true, callId: "vc-9", from: "+51100000000" });
    expect(mocks.sweeps).toBe(1);
    const ins = writes(log, "voice_calls")[0]!.value;
    expect(ins).toMatchObject({
      store_id: "store",
      lead_id: "lead-1",
      order_id: null,
      purpose: "lead",
      mode: "real",
      telephony: "telnyx",
      provider: "elevenlabs",
      agent_number: "leads",
      phone: "987654321",
      status: "dialing",
      dialed_at: NOW.toISOString(),
    });
    expect(ins.lead_context.estado_al_marcar).toBe("nuevo");
    expect(mocks.dialCalls[0]!.cfg.fromNumber).toBe("+51100000000");
    expect(mocks.dialCalls[0]!.body).toMatchObject({ to: "+51987654321", from: "+51100000000" });
    expect(writes(log, "voice_calls")[1]!.value).toEqual({ provider_call_id: "cc-1", telephony_response: { cliente: "cc-1", eventos: [] } });
  });

  it("sin la puerta SIP de leads no escribe ni marca", async () => {
    vi.stubEnv("TELNYX_LEADS_SIP_URI", "");
    const { admin, log } = fakeAdmin();
    const r = await placeLeadCall(admin, input(), NOW);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect((r as { error: string }).error).toContain("Falta TELNYX_LEADS_SIP_URI");
    expect(log).toEqual([]);
    expect(mocks.dialCalls).toEqual([]);
  });

  it("un teléfono que no es celular peruano no se marca", async () => {
    const { admin, log } = fakeAdmin();
    expect(await placeLeadCall(admin, input({ phone: "014567890" }), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(log).toEqual([]);
  });

  it("carril ocupado (23505): 409", async () => {
    const { admin } = fakeAdmin((q) => (q.op === "insert" ? { error: { message: "dup", code: "23505" } } : {}));
    expect(await placeLeadCall(admin, input(), NOW)).toEqual({ ok: false, status: 409, error: "El agente de leads ya está en otra llamada." });
    expect(mocks.dialCalls).toEqual([]);
  });

  it("Telnyx no marcó: la fila queda cancelled / sin_resultado (no gasta intento)", async () => {
    mocks.dial = { ok: false, error: "Telnyx rechazó la llamada (422)" };
    const { admin, log } = fakeAdmin((q) => (q.op === "insert" ? { data: { id: "vc-9" } } : {}));
    const r = await placeLeadCall(admin, input(), NOW);
    expect(r).toMatchObject({ ok: false, status: 502, callId: "vc-9" });
    expect(writes(log, "voice_calls")[1]!.value).toMatchObject({ status: "cancelled", outcome: "sin_resultado" });
  });
});

// ── Lo demás ────────────────────────────────────────────────────────────────

describe("reflagAgentHandoffs", () => {
  it("repone solo los «Atender ahora» del agente de las últimas 24 h que el sync dejó en nuevo", async () => {
    const { admin, log } = fakeAdmin(() => ({ data: [{ id: "a" }, { id: "b" }] }));
    expect(await reflagAgentHandoffs(admin, "store", NOW)).toBe(2);
    const q = log[0]!;
    expect(q.value).toEqual({ status: "casi_cierra", category: "hot", needs_attention: true });
    expect(has(q, "eq", "handoff_reason", "agente_voz")).toBe(true);
    expect(has(q, "gt", "handoff_at", "2026-10-11T17:00:00.000Z")).toBe(true);
    expect(has(q, "eq", "status", "nuevo")).toBe(true);
    expect(has(q, "eq", "needs_attention", false)).toBe(true);
  });
});

describe("leadVoiceCoverage", () => {
  it("pregunta a order_coverage_for con el día de Lima", async () => {
    const { admin, rpc } = fakeAdmin(undefined, { data: "agencia" });
    const c = await leadVoiceCoverage(admin, "store", { distrito: "Huancayo", provincia: "Huancayo", departamento: "Junín" }, NOW);
    expect(rpc[0]).toEqual({
      fn: "order_coverage_for",
      args: { p_store_id: "store", p_region: "Junín", p_province: "Huancayo", p_district: "Huancayo", p_day: "2026-10-12" },
    });
    expect(c.cobertura).toBe("agencia");
    expect(c.pago).toBe("adelanto");
  });

  it("si la base falla, «por revisar»", async () => {
    const { admin } = fakeAdmin(undefined, { error: { message: "boom" } });
    expect((await leadVoiceCoverage(admin, "store", { distrito: "X" }, NOW)).cobertura).toBe("por_revisar");
  });
});

describe("loadLeadVoicePilotReport", () => {
  it("por brazo e intención de tratar, y la línea del agente", async () => {
    const { admin } = fakeAdmin((q) => {
      if (q.table === "lead_experiments") {
        return {
          data: [
            { lead_id: "t1", arm: "tratamiento", assigned_at: "2026-10-12T10:00:00Z" },
            { lead_id: "t2", arm: "tratamiento", assigned_at: "2026-10-12T11:00:00Z" },
            { lead_id: "c1", arm: "control", assigned_at: "2026-10-12T09:00:00Z" },
          ],
        };
      }
      if (q.table === "leads") {
        return {
          data: [
            { id: "t1", category: "won", has_order: true, order_id: "o1" },
            { id: "t2", category: "lost", has_order: false, order_id: null },
            { id: "c1", category: "open", has_order: false, order_id: null },
          ],
        };
      }
      if (q.table === "voice_calls") {
        return {
          data: [
            { lead_id: "t1", status: "completed", queued_at: "a", started_at: "s", outcome: "atender_ahora", error: null, motivo: null, costo: 0.05 },
            { lead_id: "t2", status: "completed", queued_at: "b", started_at: "s", outcome: "no_compra", error: null, motivo: "precio", costo: 0.03 },
            { lead_id: "t2", status: "completed", queued_at: "c", started_at: null, outcome: "no_contesta", error: null, motivo: null, costo: null },
            { lead_id: "t2", status: "completed", queued_at: "d", started_at: "s", outcome: "no_contesta", error: "sin registrar_gestion: se cortó la llamada", motivo: null, costo: 0.01 },
            { lead_id: "t2", status: "cancelled", queued_at: "e", started_at: null, outcome: "sin_resultado", error: "Telnyx", motivo: null, costo: null },
          ],
        };
      }
      if (q.table === "lead_calls") {
        return { data: [{ lead_id: "t1", occurred_at: "2026-10-12T12:00:00Z" }, { lead_id: "c1", occurred_at: "2026-10-12T08:00:00Z" }] };
      }
      return {};
    });
    const r = await loadLeadVoicePilotReport(admin, "store", NOW);
    expect(r.since).toBe("2026-10-12T09:00:00Z");
    const [t, c] = r.arms;
    expect(t).toEqual({ arm: "tratamiento", leads: 2, llamados: 2, contestaron: 2, atenderAhora: 1, tocadosPorAsesora: 1, ventas: 1, conversion: 50 });
    // El toque de c1 fue ANTES del sorteo: no cuenta.
    expect(c).toEqual({ arm: "control", leads: 1, llamados: 0, contestaron: 0, atenderAhora: 0, tocadosPorAsesora: 0, ventas: 0, conversion: 0 });
    expect(r.agente).toEqual({
      llamadas: 4, // la que Telnyx rechazó no cuenta
      contestadas: 3,
      atenderAhora: 1,
      volverALlamar: 0,
      noCompra: 1,
      noLlamar: 0,
      noContesta: 2,
      sinGestion: 1,
      costoLinea: 0.09,
      conCosto: 3,
    });
    expect(r.motivos).toEqual([{ motivo: "precio", n: 1 }]);
  });
});
