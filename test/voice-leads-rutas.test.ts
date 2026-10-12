// Agente de voz para leads — las rutas (MOM §33): inicio de conversación, las
// dos tools, el aviso post-call y el barrido. La base es un doble con estado
// (`@/lib/db`) que anota cada escritura; se prueba con qué secreto entra cada
// una, a qué fila se ata y qué escribe (y qué NO, en modo prueba).

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Filter = [string, ...unknown[]];
interface Q {
  table: string;
  op: "select" | "insert" | "update" | "delete" | "upsert";
  cols?: string;
  value?: any;
  filters: Filter[];
}

const state = vi.hoisted(() => ({
  log: [] as Q[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  rows: {} as Record<string, Record<string, unknown>>,
  open: [] as Record<string, unknown>[],
  reservation: true,
  lead: null as Record<string, unknown> | null,
  stores: [] as Record<string, unknown>[],
  sweeps: 0,
  coverage: "lima" as string | null,
  metaAds: [] as Record<string, unknown>[],
}));

const val = (q: Q, col: string) => q.filters.find((f) => f[0] === "eq" && f[1] === col)?.[2];

vi.mock("@/lib/db", () => {
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
      state.log.push(q);
      if (q.table === "voice_calls" && q.op === "select") {
        const id = val(q, "id") as string | undefined;
        if (id) return { data: state.rows[id] ?? null, error: null };
        return { data: [], error: null };
      }
      if (q.table === "voice_calls" && q.op === "update") {
        // La reserva del registro: `outcome` solo, con la guarda de «en curso».
        if (Object.keys(q.value).length === 1 && "outcome" in q.value) {
          return { data: state.reservation ? [{ id: val(q, "id") }] : [], error: null };
        }
        return { data: [{ id: val(q, "id") }], error: null };
      }
      if (q.table === "voice_calls" && q.op === "insert") return { data: { id: "vc-new" }, error: null };
      if (q.table === "meta_ads") return { data: state.metaAds, error: null };
      if (q.table === "leads" && q.op === "select") return { data: state.lead, error: null };
      if (q.table === "leads" && q.op === "update") return { data: [{ id: "lead-1" }], error: null };
      if (q.table === "stores") {
        return { data: q.cols?.includes("voice_lead_enabled") ? state.stores : { timezone: "America/Lima" }, error: null };
      }
      return { data: [], error: null };
    };
    b.single = async () => run();
    b.maybeSingle = async () => run();
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
    return b;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      return { data: state.coverage, error: null };
    },
  };
  return { createAdminSupabase: () => admin, createServerSupabase: async () => admin };
});

vi.mock("@/lib/voice-recovery-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-recovery-server")>()),
  sweepStaleCalls: vi.fn(async () => {
    state.sweeps += 1;
  }),
  openCalls: vi.fn(async (_admin: unknown, purpose: string = "order") =>
    state.open.filter((c) => (c.purpose ?? "order") === purpose),
  ),
  loadDoNotCallPhones: vi.fn(async () => new Set<string>()),
  realCallsToday: vi.fn(async () => 0),
}));

import { POST as inicio } from "@/app/api/voice/leads/inicio/route";
import { POST as registrar } from "@/app/api/voice/leads/registrar/route";
import { POST as cobertura } from "@/app/api/voice/leads/cobertura/route";
import { POST as postCall } from "@/app/api/voice/elevenlabs/post-call/route";
import { GET as cron } from "@/app/api/cron/voice-leads/route";
import { POST as reproInicio } from "@/app/api/voice/elevenlabs/inicio/route";
import { LEAD_VOICE_VARS, leadVoiceArm, type LeadContext } from "@/lib/voice-leads";

const NOW = new Date("2026-10-12T17:00:00.000Z");
const XAI = "secreto-xai";
const ELEVEN = "secreto-elevenlabs";
const LEADS = "secreto-leads";
const WEBHOOK = "whsec_test";
const VC = "11111111-1111-4111-8111-111111111111";

const ficha = {
  modo: "real",
  tienda: "Kenku",
  nombre: "Ana",
  producto: "Shampoo Birú",
  oferta: "1 unidad S/ 85",
  consulta: "precio?",
  chat: "Cliente: precio?",
  distrito_chat: "",
  hoy: "2026-10-12",
  hoy_texto: "lunes 12 de octubre",
  saludo: "buenas tardes",
  intento: "1",
  es_volver_a_llamar: "no",
};
const leadContext: LeadContext = {
  ficha,
  estado_al_marcar: "nuevo",
  tipo: "primera",
  intento: 1,
  max_intentos: 2,
  campaign_id: "C1",
  chat_ok: true,
};
const row = (over: Record<string, unknown> = {}) => ({
  id: VC,
  store_id: "store",
  lead_id: "lead-1",
  purpose: "lead",
  mode: "real",
  status: "in_progress",
  outcome: null,
  dialed_at: "2026-10-12T16:58:00.000Z",
  started_at: "2026-10-12T16:58:20.000Z",
  lead_context: leadContext,
  ...over,
});
const open = (over: Record<string, unknown> = {}) => ({
  id: VC,
  agent_number: "leads",
  phone: "987654321",
  provider: "elevenlabs",
  purpose: "lead",
  status: "in_progress",
  dialed_at: "2026-10-12T16:58:00.000Z",
  started_at: "2026-10-12T16:58:20.000Z",
  ...over,
});

const req = (url: string, init: { secret?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://kapta.test${url}`, {
    method: "POST",
    headers: { ...(init.secret ? { "x-voice-secret": init.secret } : {}), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });

const writes = (table?: string) => state.log.filter((q) => q.op !== "select" && (!table || q.table === table));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("VOICE_TOOLS_SECRET", XAI);
  vi.stubEnv("VOICE_TOOLS_SECRET_ELEVENLABS", ELEVEN);
  vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", LEADS);
  vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", WEBHOOK);
  vi.stubEnv("CRON_SECRET", "cron");
  state.log = [];
  state.rpc = [];
  state.rows = { [VC]: row() };
  state.open = [open()];
  state.reservation = true;
  state.lead = { id: "lead-1", status: "nuevo", category: "open", has_order: false, order_id: null, next_followup_at: null };
  state.stores = [];
  state.sweeps = 0;
  state.coverage = "lima";
  state.metaAds = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ── Secretos: cada agente por su puerta ─────────────────────────────────────

describe("cada agente entra solo por su puerta", () => {
  it("las rutas de leads rechazan el secreto de Reproprovincia (y sin secreto)", async () => {
    for (const secret of [XAI, ELEVEN, undefined]) {
      expect((await inicio(req("/api/voice/leads/inicio", { secret }))).status).toBe(401);
      expect((await registrar(req("/api/voice/leads/registrar", { secret, body: { resultado: "no_compra" } }))).status).toBe(401);
      expect((await cobertura(req("/api/voice/leads/cobertura", { secret, body: { distrito: "Surco" } }))).status).toBe(401);
    }
    expect(state.log).toEqual([]);
  });

  it("y el inicio de Reproprovincia rechaza el secreto de leads", async () => {
    expect((await reproInicio(req("/api/voice/elevenlabs/inicio?agente=1-11", { secret: LEADS }))).status).toBe(401);
  });

  it("con el secreto de leads igual al de Reproprovincia, todo cerrado", async () => {
    vi.stubEnv("VOICE_LEADS_TOOLS_SECRET", ELEVEN);
    expect((await inicio(req("/api/voice/leads/inicio", { secret: ELEVEN }))).status).toBe(401);
  });
});

// ── Inicio de conversación ──────────────────────────────────────────────────

describe("inicio de conversación del agente de leads", () => {
  it("toma la llamada que marca, la pasa a «en curso» y da la ficha guardada", async () => {
    state.open = [open({ status: "dialing", started_at: null })];
    state.rows[VC] = row({ status: "dialing", started_at: null });
    const res = await inicio(req("/api/voice/leads/inicio", { secret: LEADS, body: {} }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(Object.keys(out.dynamic_variables).sort()).toEqual([...LEAD_VOICE_VARS].sort());
    expect(out.dynamic_variables).toMatchObject({ encontrada: "si", voice_call_id: VC, nombre: "Ana", producto: "Shampoo Birú" });
    expect(out.conversation_config_override.agent.first_message).toBe("Hola, buenas tardes. ¿Hablo con Ana?");
    const flip = writes("voice_calls")[0]!;
    expect(flip.value).toEqual({ status: "in_progress", started_at: NOW.toISOString() });
    expect(flip.filters).toContainEqual(["eq", "status", "dialing"]);
    expect(state.sweeps).toBe(1);
    // Ni Kapso ni nada sobre el lead: solo la fila de la llamada.
    expect(writes().every((q) => q.table === "voice_calls")).toBe(true);
  });

  it("solo ve llamadas de leads: con una de pedido marcando, «no encontrada»", async () => {
    state.open = [open({ purpose: "order", status: "dialing", agent_number: "1-11#elevenlabs" })];
    const out = await (await inicio(req("/api/voice/leads/inicio", { secret: LEADS }))).json();
    expect(out.dynamic_variables.encontrada).toBe("no");
    expect(Object.values(out.dynamic_variables).every((v) => typeof v === "string")).toBe(true);
    expect(writes()).toEqual([]);
  });
});

// ── registrar_resultado_lead ────────────────────────────────────────────────

describe("registrar_resultado_lead", () => {
  const body = { voice_call_id: VC, conversation_id: "conv_1", resultado: "atender_ahora", distrito: "Surco", nombre: "Ana", promo: "3x2", resumen: "Quiere el 3x2." };

  it("reserva la fila (en curso y sin resultado) ANTES de escribir sobre el lead", async () => {
    const res = await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body }))).json();
    expect(res).toEqual({ ok: true, modo: "real" });
    const w = writes();
    expect(w[0]!.table).toBe("voice_calls");
    expect(w[0]!.value).toEqual({ outcome: "atender_ahora" });
    expect(w[0]!.filters).toContainEqual(["eq", "status", "in_progress"]);
    expect(w[0]!.filters).toContainEqual(["is", "outcome", null]);
    // Modo real: el lead pasa a «Atender ahora» y queda la nota del agente.
    expect(writes("leads")[0]!.value).toMatchObject({ status: "casi_cierra", needs_attention: true, handoff_reason: "agente_voz" });
    expect(writes("lead_calls")[0]!.value).toMatchObject({ kind: "voice_agent", vendedora: null, new_status: "casi_cierra" });
    const close = writes("voice_calls").at(-1)!;
    expect(close.value).toMatchObject({ status: "completed", outcome: "atender_ahora", error: null, ended_at: NOW.toISOString() });
    expect(close.value.outcome_payload).toMatchObject({
      resultado: "atender_ahora",
      captura: { distrito: "Surco", nombre: "Ana", promo: "3x2" },
      no_llamar: false,
      aplicado: true,
      omitido: null,
      conversation_id: "conv_1",
    });
  });

  it("modo prueba: no escribe NADA sobre el lead", async () => {
    state.rows[VC] = row({ mode: "test" });
    const res = await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body: { ...body, resultado: "no_llamar" } }))).json();
    expect(res).toEqual({ ok: true, modo: "test" });
    expect(writes("leads")).toEqual([]);
    expect(writes("lead_calls")).toEqual([]);
    expect(writes().every((q) => q.table === "voice_calls")).toBe(true);
    // El teléfono era el de quien probaba: su «no me llamen» no entra a la
    // lista «no llamar» de la tienda, que leen los dos agentes.
    expect(writes("voice_calls").at(-1)!.value.outcome_payload.no_llamar).toBe(false);
  });

  it("el payload es lo traducido, nunca el cuerpo entero (un no_llamar suelto no entra a la lista)", async () => {
    await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body: { ...body, no_llamar: "true", telefono: "987654321", extra: "x" } }));
    const payload = writes("voice_calls").at(-1)!.value.outcome_payload;
    expect(Object.keys(payload).sort()).toEqual(
      ["aplicado", "captura", "conversation_id", "motivo", "no_llamar", "omitido", "resultado", "resumen"].sort(),
    );
    expect(payload.no_llamar).toBe(false);
  });

  it("si la fila ya se registró o se cerró, no escribe sobre el lead", async () => {
    state.reservation = false;
    const res = await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body }))).json();
    expect(res).toEqual({ ok: false, error: "la llamada ya se registró o se cerró" });
    expect(writes("leads")).toEqual([]);
    expect(writes("lead_calls")).toEqual([]);
    expect(writes("voice_calls")).toHaveLength(1);
  });

  it("un resultado inválido no reserva nada", async () => {
    const res = await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body: { ...body, resultado: "confirma" } }))).json();
    expect(res.ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("se ata por voice_call_id solo si está en curso, y nunca a una fila de pedido", async () => {
    state.rows[VC] = row({ status: "dialing" });
    expect((await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body }))).json()).ok).toBe(false);
    state.rows[VC] = row({ purpose: "order", lead_id: null, order_id: "order-1" });
    expect((await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body }))).json()).ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("sin voice_call_id: la única llamada de lead en curso", async () => {
    const { voice_call_id: _omit, ...sinId } = body;
    void _omit;
    expect(await (await registrar(req("/api/voice/leads/registrar", { secret: LEADS, body: sinId }))).json()).toEqual({ ok: true, modo: "real" });
  });
});

// ── consultar_cobertura ─────────────────────────────────────────────────────

describe("consultar_cobertura", () => {
  it("usa la tienda de la llamada y la cobertura del Master", async () => {
    state.coverage = "provincia_cod";
    const out = await (
      await cobertura(req("/api/voice/leads/cobertura", { secret: LEADS, body: { voice_call_id: VC, distrito: "Huancayo", provincia: "Huancayo", departamento: "Junín" } }))
    ).json();
    expect(out).toMatchObject({ ok: true, cobertura: "provincia_cod", pago: "contraentrega" });
    expect(state.rpc[0]).toMatchObject({ fn: "order_coverage_for", args: { p_store_id: "store", p_district: "Huancayo", p_region: "Junín" } });
    expect(writes()).toEqual([]);
  });

  it("sin llamada de lead abierta: «por revisar», sin preguntar a la base", async () => {
    state.open = [];
    const out = await (await cobertura(req("/api/voice/leads/cobertura", { secret: LEADS, body: { distrito: "Surco" } }))).json();
    expect(out).toMatchObject({ ok: false, cobertura: "por_revisar" });
    expect(state.rpc).toEqual([]);
  });
});

// ── post-call ───────────────────────────────────────────────────────────────

describe("aviso post-call de ElevenLabs", () => {
  const event = (vars: Record<string, unknown> = { voice_call_id: VC }, type = "post_call_transcription") =>
    JSON.stringify({
      type,
      data: {
        conversation_id: "conv_1",
        agent_id: "agent_leads",
        transcript: [
          { role: "agent", message: "Hola, buenas tardes.", time_in_call_secs: 0 },
          { role: "user", message: "Sí, dígame.", time_in_call_secs: 3 },
        ],
        metadata: { call_duration_secs: 95, cost: 380 },
        analysis: { transcript_summary: "Quiere el 3x2." },
        conversation_initiation_client_data: { dynamic_variables: vars },
      },
    });
  const signed = (raw: string, secret = WEBHOOK) => {
    const t = Math.floor(NOW.getTime() / 1000);
    return req("/api/voice/elevenlabs/post-call", {
      body: raw,
      headers: { "elevenlabs-signature": `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}` },
    });
  };

  it("sin secreto configurado o con firma mala: 401 y nada escrito", async () => {
    expect((await postCall(signed(event(), "otro"))).status).toBe(401);
    vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", "");
    expect((await postCall(signed(event(), ""))).status).toBe(401);
    expect(state.log).toEqual([]);
  });

  it("guarda la transcripción en la llamada de lead", async () => {
    const res = await postCall(signed(event()));
    expect(await res.json()).toEqual({ ok: true });
    const upd = writes("voice_calls")[0]!;
    expect(upd.filters).toContainEqual(["eq", "id", VC]);
    expect(upd.filters).toContainEqual(["eq", "purpose", "lead"]);
    expect(upd.value.transcript).toMatchObject({
      conversation_id: "conv_1",
      duracion_s: 95,
      costo: 380,
      resumen: "Quiere el 3x2.",
      turnos: [
        { rol: "agente", texto: "Hola, buenas tardes.", t: 0 },
        { rol: "cliente", texto: "Sí, dígame.", t: 3 },
      ],
    });
  });

  it("una llamada de pedido, sin voice_call_id u otro tipo de aviso: 200 sin escribir", async () => {
    state.rows[VC] = row({ purpose: "order" });
    expect((await postCall(signed(event()))).status).toBe(200);
    expect((await postCall(signed(event({})))).status).toBe(200);
    expect((await postCall(signed(event({ voice_call_id: VC }, "post_call_audio")))).status).toBe(200);
    expect(writes()).toEqual([]);
  });
});

// ── El barrido ──────────────────────────────────────────────────────────────

describe("barrido /api/cron/voice-leads", () => {
  const cronReq = (q = "", auth = "Bearer cron") =>
    new NextRequest(`https://kapta.test/api/cron/voice-leads${q}`, { headers: auth ? { authorization: auth } : {} });

  it("sin el secreto del cron: 401", async () => {
    expect((await cron(cronReq("", ""))).status).toBe(401);
  });

  it("fuera de producción no llama (sin ?dry=1)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await (await cron(cronReq())).json()).toEqual({ skipped: "not_production" });
    expect(state.log).toEqual([]);
  });

  it("?dry=1 arma la cola sin escribir, sin barrer y sin sortear", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    state.stores = [{ id: "store", name: "Kenku Peru", voice_lead_enabled: true, voice_lead_auto: false, voice_lead_campaign_ids: ["C1"] }];
    state.lead = [] as never; // ningún lead en la ventana
    const out = await (await cron(cronReq("?dry=1"))).json();
    expect(out.stores).toEqual([{ store: "Kenku Peru", action: "dry", queue: 0, excluded: {} }]);
    expect(writes()).toEqual([]);
    expect(state.sweeps).toBe(0);
  });

  it("encendida sin automático: solo repone los «Atender ahora» del agente", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    state.stores = [{ id: "store", name: "Kenku Peru", voice_lead_enabled: true, voice_lead_auto: false }];
    const out = await (await cron(cronReq())).json();
    expect(out.stores[0]).toMatchObject({ action: "manual", reflagged: 1 });
    expect(writes().map((q) => q.table)).toEqual(["leads"]);
  });

  it("en automático, en horario y con el carril libre: sortea y llama al primero por Telnyx", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    for (const [k, v] of Object.entries({
      TELNYX_API_KEY: "k",
      TELNYX_CONNECTION_ID: "conn",
      TELNYX_FROM_NUMBER: "+15550000001",
      TELNYX_XAI_SIP_URI: "sip:xai@x",
      TELNYX_LEADS_SIP_URI: "sip:leads@x",
      TELNYX_LEADS_FROM_NUMBER: "+51100000000",
    })) vi.stubEnv(k, v);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "cc-9" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let id = "";
    for (let i = 0; !id; i++) {
      const c = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      if (leadVoiceArm(c, 50) === "tratamiento") id = c;
    }
    state.open = [];
    state.stores = [{ id: "store", name: "Kenku Peru", voice_lead_enabled: true, voice_lead_auto: true, voice_lead_campaign_ids: ["C1"] }];
    state.metaAds = [{ ad_id: "ad1", campaign_id: "C1" }];
    state.lead = [
      {
        id,
        store_id: "store",
        phone: "51987654321",
        name: "Ana",
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
        first_inbound_text: "precio?",
        district: null,
        ad_headline: null,
        kapso_conversation_id: null,
      },
    ] as never;
    try {
      const out = await (await cron(cronReq())).json();
      expect(out.stores[0]).toMatchObject({ action: "llamada", queue: 1, assigned: 1, tries: 1, called: { kind: "primera", attempt: 1 } });
      expect(writes("lead_experiments")[0]!.value).toEqual([{ lead_id: id, store_id: "store", experiment: "agente_voz_leads_v1", arm: "tratamiento" }]);
      expect(writes("voice_calls").find((q) => q.op === "insert")!.value).toMatchObject({ lead_id: id, purpose: "lead", mode: "real", triggered_by: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // El log del barrido no lleva el teléfono ni el nombre del lead.
      expect(JSON.stringify(out)).not.toContain("987654321");
      expect(JSON.stringify(out)).not.toContain("Ana");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("el orden de las rejas: horario, tope propio, carril libre y recién ahí el sorteo", () => {
    const src = readFileSync(resolve(__dirname, "../app/api/cron/voice-leads/route.ts"), "utf8");
    const at = (s: string) => {
      const i = src.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at("reflagAgentHandoffs(admin, store.id, now)")).toBeLessThan(at("withinVoiceHours(now, s.hourStart, s.hourEnd)"));
    expect(at("withinVoiceHours(now, s.hourStart, s.hourEnd)")).toBeLessThan(at('realCallsToday(admin, store.id, now, "lead")'));
    expect(at('realCallsToday(admin, store.id, now, "lead")')).toBeLessThan(at("if (laneBusy)"));
    expect(at("if (laneBusy)")).toBeLessThan(at("loadLeadVoiceQueue(admin, store, now, { assign: true })"));
    expect(src).toContain('await openCalls(admin, "lead")');
    expect(src).toContain('if (process.env.VERCEL_ENV !== "production" && !dry)');
    expect(src).toContain("if (!dry) await sweepStaleCalls(admin, now);");
    expect(src).toContain('mode: "real"');
    expect(src).toContain("triggeredBy: null");
  });

  it("vercel.json corre el barrido desfasado dos minutos del de Reproprovincia", () => {
    const vercel = JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons).toContainEqual({ path: "/api/cron/voice-leads", schedule: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *" });
  });
});
