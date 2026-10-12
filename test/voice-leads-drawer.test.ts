// Agente de voz para leads — el lado de Leads (MOM §33, 12-10-2026).
//
// Lo que ve y hace la asesora en el drawer (panel, historial, «Resumen del
// agente de voz», «No contactar»), lo que el agente deja listo para «Generar
// pedido», y que quien pidió no ser contactado no reciba más plantillas
// automáticas. Las acciones se prueban con la base y el servidor del agente
// simulados: aquí se mira el lado de Leads, no la telefonía.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Filter = [method: string, column: string, value: unknown];
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  cols?: string;
  payload?: unknown;
  filters: Filter[];
}
type Reply = { data: unknown; error: { message: string } | null };

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  reply: (_c: Call): Reply => ({ data: null, error: null }),
  access: true,
  canEdit: true,
  leadWithCalls: null as unknown,
  names: {} as Record<string, string>,
  store: null as unknown,
  queue: null as unknown,
  queueError: null as Error | null,
  callsToday: 0,
  placed: { ok: true, callId: "vc-1", from: "+5110000000" } as unknown,
  configured: true,
  loadQueue: [] as unknown[][],
  built: [] as unknown[][],
  placeArgs: [] as unknown[][],
  todayArgs: [] as unknown[][],
  revalidate: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => st.revalidate.push(a) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (p: string) => { throw new Error(`redirect:${p}`); } }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: vi.fn(), resolveAgentNames: async () => st.names }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => st.canEdit }) }));
vi.mock("@/lib/leads-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads-access")>()),
  getLeadWithCalls: async () => st.leadWithCalls,
}));
vi.mock("@/lib/voice-recovery-server", () => ({
  realCallsToday: async (...a: unknown[]) => {
    st.todayArgs.push(a);
    return st.callsToday;
  },
}));
vi.mock("@/lib/voice-leads-server", () => ({
  leadVoiceConfigured: () => st.configured,
  loadLeadVoiceStore: async () => st.store,
  loadLeadVoiceQueue: async (...a: unknown[]) => {
    st.loadQueue.push(a);
    if (st.queueError) throw st.queueError;
    return st.queue;
  },
  buildLeadContext: async (...a: unknown[]) => {
    st.built.push(a);
    return { ficha: { modo: a[4] }, estado_al_marcar: "nuevo" };
  },
  placeLeadCall: async (...a: unknown[]) => {
    st.placeArgs.push(a);
    return st.placed;
  },
}));
vi.mock("@/lib/db", () => {
  const builder = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    const q: Record<string, unknown> = {};
    q.select = (cols: string) => {
      if (call.op === "select") call.cols = cols;
      return q;
    };
    for (const op of ["insert", "update", "upsert", "delete"] as const) {
      q[op] = (p: unknown) => {
        call.op = op;
        call.payload = p;
        return q;
      };
    }
    for (const m of ["eq", "neq", "in", "is", "not", "gte", "lte", "gt", "lt", "order", "limit", "or", "match"]) {
      q[m] = (column: string, value: unknown) => {
        call.filters.push([m, String(column), value]);
        return q;
      };
    }
    const run = () => {
      st.calls.push(call);
      return st.reply(call);
    };
    q.maybeSingle = q.single = async () => run();
    q.then = (res: (r: Reply) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
    return q;
  };
  return {
    createAdminSupabase: () => ({ from: builder }),
    createServerSupabase: async () => ({
      auth: { getClaims: async () => ({ data: { claims: { sub: "asesora-1" } } }) },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: st.access
                ? { store_id: "store-1", phone: "51987654321", kapso_conversation_id: null, wa_phone_number_id: null }
                : null,
            }),
          }),
        }),
      }),
    }),
  };
});

import {
  llamarLeadConAgente,
  loadLeadDetail,
  loadLeadVoicePanel,
  loadOrderDraft,
  probarAgenteLeadEnMiTelefono,
} from "@/app/dashboard/leads/actions";
import {
  LEAD_VOICE_AGENT_HANDOFF,
  LEAD_VOICE_AGENT_KIND,
  LEAD_VOICE_AGENT_NAME,
  leadVoiceAgentTitle,
  leadVoicePanelView,
} from "@/components/lead-voice-agent-panel";
import {
  LEAD_VOICE_HANDOFF_REASON,
  LEAD_VOICE_KIND,
  LEAD_VOICE_NOTE_SIGNER,
  leadVoiceTimelineTitle,
} from "@/lib/voice-leads";
import { LEAD_VOICE_EXCLUSION_LABEL, type LeadVoicePanelData } from "@/lib/voice-lead-labels";
import { isSalesTouch } from "@/lib/productivity";
import { cartSeqSkipReason, runCartSequence } from "@/lib/cart-sequence";
import { dripSkipReason, lastDispositionAtByPhone, processWinback, sendSeguimientoDrip } from "@/lib/leads-ingest";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const LEAD = "4f5e7c8a-1111-4222-8333-944455556666";
const filtersOf = (c: Call | undefined) => c?.filters ?? [];
const has = (c: Call | undefined, m: string, col: string, v?: unknown) =>
  filtersOf(c).some(([fm, fc, fv]) => fm === m && fc === col && (v === undefined || JSON.stringify(fv) === JSON.stringify(v)));
const callsTo = (table: string) => st.calls.filter((c) => c.table === table);

const SETTINGS = {
  enabled: true,
  auto: false,
  dailyCap: 40,
  maxAttempts: 2,
  waitMinutes: 120,
  maxAgeHours: 48,
  holdoutPct: 50,
  hourStart: 9,
  hourEnd: 20,
  campaignIds: ["120248136956710056"],
  product: "Shampoo Birú",
  offer: "",
};
const entryFor = (over: Record<string, unknown> = {}) => ({
  lead: { id: LEAD, store_id: "store-1", phone: "51987654321", name: "Rosa", status: "nuevo", category: "open", ...over },
  kind: "primera",
  arm: "tratamiento",
  attempt: 1,
  campaignId: "120248136956710056",
});

beforeEach(() => {
  // Martes 14-10-2026, 10:00 en Lima: dentro del horario del agente.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
  st.calls = [];
  st.reply = () => ({ data: null, error: null });
  st.access = true;
  st.canEdit = true;
  st.leadWithCalls = null;
  st.names = {};
  st.store = { id: "store-1", name: "Kenku Perú", settings: { ...SETTINGS } };
  st.queue = { candidates: [entryFor()], reasons: {}, arms: { [LEAD]: "tratamiento" }, assigned: 0, seen: 1 };
  st.queueError = null;
  st.callsToday = 0;
  st.placed = { ok: true, callId: "vc-1", from: "+5110000000" };
  st.configured = true;
  st.loadQueue = [];
  st.built = [];
  st.placeArgs = [];
  st.todayArgs = [];
  st.revalidate = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Lo que el cliente no puede importar, atado a su original ────────────────

describe("las constantes del drawer son las del agente", () => {
  it("kind, handoff y firma son los de lib/voice-leads", () => {
    expect(LEAD_VOICE_AGENT_KIND).toBe(LEAD_VOICE_KIND);
    expect(LEAD_VOICE_AGENT_KIND).toBe("voice_agent");
    expect(LEAD_VOICE_AGENT_HANDOFF).toBe(LEAD_VOICE_HANDOFF_REASON);
    expect(LEAD_VOICE_AGENT_NAME).toBe(LEAD_VOICE_NOTE_SIGNER);
  });

  it.each([null, "casi_cierra", "volver_a_llamar", "cancelado_cliente", "ya_compro_otro_lado", "fuera_de_ciudad"])(
    "el título del historial es leadVoiceTimelineTitle(%s)",
    (status) => {
      expect(leadVoiceAgentTitle(status)).toBe(leadVoiceTimelineTitle(status));
    },
  );

  it("ni el drawer ni el panel importan lib/voice-leads (arrastra node:crypto al cliente)", () => {
    for (const file of [read("components", "leads-drawer.tsx"), read("components", "lead-voice-agent-panel.tsx")]) {
      expect(file).not.toMatch(/from "@\/lib\/voice-leads"/);
      expect(file).not.toMatch(/from "@\/lib\/voice-leads-server"/);
    }
  });
});

// ── El panel ────────────────────────────────────────────────────────────────

describe("leadVoicePanelView: cuándo hay botón y qué se dice si no", () => {
  const data = (over: Partial<LeadVoicePanelData> = {}): LeadVoicePanelData => ({
    enabled: true,
    configured: true,
    eligible: true,
    reason: null,
    arm: "tratamiento",
    optOut: false,
    calls: [],
    ...over,
  });

  it("solo con el agente encendido, la línea configurada y el lead en la cola", () => {
    expect(leadVoicePanelView(data())).toEqual({ puedeLlamar: true, porQueNo: null });
    expect(leadVoicePanelView(data({ eligible: false, reason: "Grupo de control" })).puedeLlamar).toBe(false);
    expect(leadVoicePanelView(data({ enabled: false })).puedeLlamar).toBe(false);
    expect(leadVoicePanelView(data({ configured: false })).puedeLlamar).toBe(false);
  });

  it("primero lo que falta configurar, después el interruptor, al final la razón de la cola", () => {
    const todo = data({ configured: false, enabled: false, eligible: false, reason: "x" });
    expect(leadVoicePanelView(todo).porQueNo).toContain("Vercel");
    expect(leadVoicePanelView({ ...todo, configured: true }).porQueNo).toContain("apagado");
    expect(leadVoicePanelView({ ...todo, configured: true, enabled: true }).porQueNo).toBe("x");
  });

  it("el drawer lo monta en su tarjeta, antes del resultado de la llamada y solo con teléfono", () => {
    const drawer = read("components", "leads-drawer.tsx");
    expect(drawer).toMatch(
      /\{canCall && \(\s*<div className=\{SECTION_CARD\}>\s*<LeadVoiceAgentPanel key=\{lead\.id\} leadId=\{lead\.id\} onChanged=\{\(\) => onRegistered\(\)\} \/>/,
    );
    expect(drawer.indexOf("<LeadVoiceAgentPanel")).toBeLessThan(drawer.indexOf("<CallForm key={lead.id}"));
  });

  it("el panel lee por /api/leads/read y muta con las acciones de leads", () => {
    const panel = read("components", "lead-voice-agent-panel.tsx");
    expect(panel).toContain('import { loadLeadVoicePanel } from "@/lib/leads-read-client";');
    expect(panel).toContain("llamarLeadConAgente(leadId)");
    expect(panel).toContain("probarAgenteLeadEnMiTelefono(leadId, telefono)");
    for (const text of ["En la cola del agente", "Fuera de la cola", "Grupo de control", "Pidió no ser contactado", "Llamar con el agente", "Probar en mi teléfono", "Prueba"]) {
      expect(panel).toContain(text);
    }
    const client = read("lib", "leads-read-client.ts");
    expect(client).toContain('readLeadData("loadLeadVoicePanel", args)');
    expect(read("app", "api", "leads", "read", "route.ts")).toContain("loadLeadVoicePanel: lead,");
  });
});

describe("el historial y la ficha del lead", () => {
  it("una fila del agente se titula «🤖 Agente de voz · estado» y se firma «Agente de voz»", () => {
    const drawer = read("components", "leads-drawer.tsx");
    expect(drawer).toContain("c.kind === LEAD_VOICE_AGENT_KIND ? (");
    expect(drawer).toContain("leadVoiceAgentTitle(c.new_status)");
    expect(drawer).toContain("` · ${LEAD_VOICE_AGENT_NAME}`");
  });

  it("«Resumen del agente de voz» cuando el handoff es suyo, y el chip «No contactar»", () => {
    const drawer = read("components", "leads-drawer.tsx");
    expect(drawer).toContain('lead.handoff_reason === LEAD_VOICE_AGENT_HANDOFF ? "Resumen del agente de voz" : "Resumen del bot"');
    expect(drawer).toContain("lead.contact_opt_out_at && (");
    expect(drawer).toContain("🚫 No contactar");
  });

  it("el Master de Pedidos nombra sus filas", () => {
    expect(read("components", "order-master-shared.tsx")).toContain('lead_voice_agent: "Agente de voz (leads)"');
  });

  it("loadLeadDetail firma «Agente de voz» las filas del agente, y solo esas sin vendedora", async () => {
    st.names = { u1: "Ana" };
    st.leadWithCalls = {
      lead: { id: LEAD },
      calls: [
        { kind: LEAD_VOICE_KIND, vendedora: null, new_status: "casi_cierra" },
        { kind: "system", vendedora: null, new_status: null },
        { kind: "call", vendedora: "u1", new_status: "no_responde" },
      ],
    };
    const res = await loadLeadDetail(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.calls.map((c) => c.vendedora_name)).toEqual(["Agente de voz", null, "Ana"]);
  });

  it("el agente escribe su historial con kind voice_agent y sin vendedora, nunca como «call»", () => {
    const writeback = read("lib", "voice-leads-writeback.ts");
    expect(writeback).toContain("kind: LEAD_VOICE_KIND");
    expect(writeback).toContain("vendedora: null");
    expect(writeback).not.toMatch(/kind:\s*"call"/);
  });
});

// ── Acciones del panel ──────────────────────────────────────────────────────

describe("loadLeadVoicePanel", () => {
  beforeEach(() => {
    st.reply = (c) => {
      if (c.table === "voice_calls") {
        return {
          data: [
            {
              id: "vc-2",
              mode: "real",
              status: "completed",
              outcome: "no_compra",
              queued_at: "2026-10-14T14:00:00Z",
              outcome_payload: { resumen: "  Dice que está caro.  ", motivo: "precio", no_llamar: false },
              error: null,
            },
            { id: "vc-1", mode: "test", status: "completed", outcome: null, queued_at: "2026-10-13T14:00:00Z", outcome_payload: {}, error: null },
          ],
          error: null,
        };
      }
      if (c.table === "leads") return { data: { contact_opt_out_at: null }, error: null };
      return { data: null, error: null };
    };
  });

  it("dice si entra, su brazo y sus llamadas, sin sortear (sin assign)", async () => {
    const res = await loadLeadVoicePanel(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.data).toMatchObject({ enabled: true, configured: true, eligible: true, reason: null, arm: "tratamiento", optOut: false });
    expect(res.data.calls[0]).toEqual({
      id: "vc-2",
      mode: "real",
      status: "completed",
      outcome: "no_compra",
      queued_at: "2026-10-14T14:00:00Z",
      resumen: "Dice que está caro.",
      motivo: "precio",
      error: null,
    });
    expect(res.data.calls[1]).toMatchObject({ mode: "test", resumen: null, motivo: null });
    expect(st.loadQueue[0]![3]).toEqual({ leadId: LEAD });
    // Solo las llamadas de LEADS de este lead: las de Reproprovincia no son suyas.
    const vc = callsTo("voice_calls")[0];
    expect(has(vc, "eq", "lead_id", LEAD)).toBe(true);
    expect(has(vc, "eq", "purpose", "lead")).toBe(true);
    expect(st.placeArgs).toHaveLength(0);
  });

  it("grupo de control y «no contactar», con la frase de la cola", async () => {
    st.queue = { candidates: [], reasons: { [LEAD]: "grupo_control" }, arms: { [LEAD]: "control" }, assigned: 0, seen: 1 };
    const base = st.reply;
    st.reply = (c) => (c.table === "leads" ? { data: { contact_opt_out_at: "2026-10-12T15:00:00Z" }, error: null } : base(c));
    const res = await loadLeadVoicePanel(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.data).toMatchObject({
      eligible: false,
      reason: LEAD_VOICE_EXCLUSION_LABEL.grupo_control,
      arm: "control",
      optOut: true,
    });
  });

  it("si la cola no se puede leer, queda fuera (cerrado) y las llamadas igual se ven", async () => {
    st.queueError = new Error("timeout");
    const res = await loadLeadVoicePanel(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.data.eligible).toBe(false);
    expect(res.data.reason).toContain("No se pudo leer la cola");
    expect(res.data.calls).toHaveLength(2);
  });

  it("pre-0247 (sin columnas) el panel no se cae: sin llamadas y sin opt-out", async () => {
    st.reply = () => ({ data: null, error: { message: "column voice_calls.lead_id does not exist" } });
    const res = await loadLeadVoicePanel(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.data).toMatchObject({ optOut: false, calls: [] });
  });

  it("sin acceso al lead no lee nada privilegiado", async () => {
    st.access = false;
    expect(await loadLeadVoicePanel(LEAD)).toEqual({ error: "Sin acceso a este lead." });
    expect(st.calls).toHaveLength(0);
    expect(st.loadQueue).toHaveLength(0);
  });
});

describe("llamarLeadConAgente", () => {
  it("llama al lead de la cola: modo real, quién lo pidió, su teléfono; sin revalidatePath", async () => {
    const res = await llamarLeadConAgente(LEAD);
    expect(res).toEqual({ notice: "Llamando. Cuando conteste, lo atiende el agente de leads." });
    expect(st.loadQueue[0]![3]).toEqual({ leadId: LEAD, assign: true });
    expect(st.todayArgs[0]![1]).toBe("store-1");
    expect(st.todayArgs[0]![3]).toBe("lead"); // el tope es del carril de leads
    expect(st.built[0]![4]).toBe("real");
    expect(st.placeArgs[0]![1]).toEqual({
      storeId: "store-1",
      leadId: LEAD,
      phone: "51987654321",
      mode: "real",
      triggeredBy: "asesora-1",
      context: { ficha: { modo: "real" }, estado_al_marcar: "nuevo" },
    });
    expect(st.revalidate).toHaveLength(0);
  });

  it("el grupo de control NUNCA se llama, ni a mano", async () => {
    st.queue = { candidates: [], reasons: { [LEAD]: "grupo_control" }, arms: { [LEAD]: "control" }, assigned: 1, seen: 1 };
    expect(await llamarLeadConAgente(LEAD)).toEqual({ error: LEAD_VOICE_EXCLUSION_LABEL.grupo_control });
    expect(st.placeArgs).toHaveLength(0);
    expect(st.built).toHaveLength(0);
  });

  it("quien pidió no ser contactado tampoco", async () => {
    st.queue = { candidates: [], reasons: { [LEAD]: "no_contactar" }, arms: {}, assigned: 0, seen: 1 };
    expect(await llamarLeadConAgente(LEAD)).toEqual({ error: LEAD_VOICE_EXCLUSION_LABEL.no_contactar });
    expect(st.placeArgs).toHaveLength(0);
  });

  it("agente apagado, línea sin configurar, fuera de horario o tope del día: no mira la cola ni marca", async () => {
    st.store = { id: "store-1", name: "Kenku", settings: { ...SETTINGS, enabled: false } };
    expect((await llamarLeadConAgente(LEAD)).error).toContain("no está habilitado");

    st.store = { id: "store-1", name: "Kenku", settings: { ...SETTINGS } };
    st.configured = false;
    expect((await llamarLeadConAgente(LEAD)).error).toContain("Falta configurar la línea");
    st.configured = true;

    st.store = { id: "store-1", name: "Kenku", settings: { ...SETTINGS } };
    vi.setSystemTime(new Date("2026-10-14T03:00:00Z")); // 22:00 en Lima
    expect((await llamarLeadConAgente(LEAD)).error).toBe(
      "El agente de leads llama de 9:00 a 20:00; los domingos, desde las 11:00.",
    );

    vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
    st.callsToday = 40;
    expect((await llamarLeadConAgente(LEAD)).error).toContain("tope de llamadas del agente de leads");

    expect(st.loadQueue).toHaveLength(0);
    expect(st.placeArgs).toHaveLength(0);
  });

  it("sin permiso de edición del Master no hace nada", async () => {
    st.canEdit = false;
    expect((await llamarLeadConAgente(LEAD)).error).toContain("Tu rol no permite");
    expect(st.loadQueue).toHaveLength(0);
    expect(st.placeArgs).toHaveLength(0);
  });

  it("devuelve el error de la línea tal cual", async () => {
    st.placed = { ok: false, status: 409, error: "El agente de leads ya está en otra llamada." };
    expect(await llamarLeadConAgente(LEAD)).toEqual({ error: "El agente de leads ya está en otra llamada." });
  });
});

describe("probarAgenteLeadEnMiTelefono", () => {
  beforeEach(() => {
    st.reply = (c) =>
      c.table === "leads"
        ? {
            data: {
              id: LEAD,
              store_id: "store-1",
              phone: "51987654321",
              name: "Rosa",
              status: "volver_a_llamar",
              category: "open",
              first_inbound_text: "Precio del shampoo?",
              kapso_conversation_id: "conv-1",
            },
            error: null,
          }
        : { data: null, error: null };
  });

  it("llama al teléfono de quien prueba, en modo prueba, con la ficha de este lead", async () => {
    st.store = { id: "store-1", name: "Kenku", settings: { ...SETTINGS, enabled: false } }; // no exige encendido
    const res = await probarAgenteLeadEnMiTelefono(LEAD, "911 222 333");
    expect(res).toEqual({ notice: "Te llama el agente de leads. Es una prueba: nada se escribe sobre el lead." });
    expect(st.loadQueue).toHaveLength(0); // ni elegibilidad ni sorteo
    const entry = st.built[0]![2] as { lead: Record<string, unknown>; kind: string; attempt: number; arm: string };
    expect(entry).toMatchObject({ kind: "primera", attempt: 1, arm: "tratamiento" });
    expect(entry.lead).toMatchObject({ id: LEAD, name: "Rosa", kapso_conversation_id: "conv-1", contact_opt_out_at: null });
    expect(st.built[0]![4]).toBe("test");
    expect(st.placeArgs[0]![1]).toMatchObject({ phone: "51911222333", mode: "test", leadId: LEAD, triggeredBy: "asesora-1" });
    // La prueba no escribe sobre el lead.
    expect(st.calls.filter((c) => c.op !== "select")).toHaveLength(0);
  });

  it("rechaza un teléfono que no es celular peruano antes de marcar", async () => {
    expect((await probarAgenteLeadEnMiTelefono(LEAD, "12345")).error).toContain("celular peruano");
    expect(st.placeArgs).toHaveLength(0);
  });

  it("sin permiso de edición del Master no prueba", async () => {
    st.canEdit = false;
    expect((await probarAgenteLeadEnMiTelefono(LEAD, "911222333")).error).toContain("Tu rol no permite");
    expect(st.placeArgs).toHaveLength(0);
  });
});

// ── «Generar pedido» viene relleno ──────────────────────────────────────────

describe("loadOrderDraft superpone la captura del agente", () => {
  const CAPTURA = {
    nombre: "Rosa Quispe",
    distrito: "Cayma",
    provincia: "Arequipa",
    departamento: "Arequipa",
    direccion: "Calle Los Pinos 123",
    referencia: "frente al parque",
    promo: "3x2",
    cantidad: 3,
  };
  const leadRow = (over: Record<string, unknown> = {}) => ({
    phone: "51987654321",
    name: "🌸",
    draft_order_gid: null,
    address1: null,
    district: null,
    province: null,
    referencia: null,
    kapso_conversation_id: null,
    ...over,
  });
  const reply = (lead: Record<string, unknown>, voice: Reply) => (c: Call): Reply =>
    c.table === "leads" ? { data: lead, error: null } : c.table === "voice_calls" ? voice : { data: null, error: null };

  it("llena lo vacío con la captura y no inventa productos", async () => {
    st.reply = reply(leadRow(), { data: { outcome_payload: { resultado: "atender_ahora", captura: CAPTURA } }, error: null });
    const res = await loadOrderDraft(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res).toMatchObject({
      address1: "Calle Los Pinos 123",
      district: "Cayma",
      province: "Arequipa",
      referencia: "frente al parque",
      customerName: "🌸", // el nombre del lead ya estaba: no se pisa
      lineItems: [],
    });
  });

  it("lo que ya trae el lead manda; el nombre se toma solo si falta", async () => {
    st.reply = reply(leadRow({ name: null, address1: "Jr. Lima 456", district: "Yanahuara" }), {
      data: { outcome_payload: { captura: CAPTURA } },
      error: null,
    });
    const res = await loadOrderDraft(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res).toMatchObject({ address1: "Jr. Lima 456", district: "Yanahuara", customerName: "Rosa Quispe" });
  });

  it("la región sale del departamento; la provincia es el respaldo", async () => {
    st.reply = reply(leadRow(), {
      data: { outcome_payload: { captura: { ...CAPTURA, provincia: "Huaral", departamento: "Lima" } } },
      error: null,
    });
    let res = await loadOrderDraft(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.province).toBe("Lima");
    st.reply = reply(leadRow(), {
      data: { outcome_payload: { captura: { ...CAPTURA, provincia: "Arequipa", departamento: "" } } },
      error: null,
    });
    res = await loadOrderDraft(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res.province).toBe("Arequipa");
  });

  it("solo la última llamada REAL de leads que terminó en «quiere comprar», de los últimos 7 días", async () => {
    st.reply = reply(leadRow(), { data: null, error: null });
    await loadOrderDraft(LEAD);
    const vc = callsTo("voice_calls")[0];
    expect(has(vc, "eq", "store_id", "store-1")).toBe(true);
    expect(has(vc, "eq", "lead_id", LEAD)).toBe(true);
    expect(has(vc, "eq", "purpose", "lead")).toBe(true);
    expect(has(vc, "eq", "mode", "real")).toBe(true);
    expect(has(vc, "eq", "outcome", "atender_ahora")).toBe(true);
    expect(has(vc, "gte", "queued_at", "2026-10-07T15:00:00.000Z")).toBe(true);
    expect(has(vc, "order", "queued_at")).toBe(true);
  });

  it("un lead sin carrito lleva su address1 (antes era null fijo); sin captura queda igual", async () => {
    st.reply = reply(leadRow({ address1: "Av. Ejército 700" }), { data: null, error: { message: "column voice_calls.lead_id does not exist" } });
    const res = await loadOrderDraft(LEAD);
    if ("error" in res) throw new Error(res.error);
    expect(res).toMatchObject({ address1: "Av. Ejército 700", district: null, province: null });
    expect(callsTo("leads")[0]!.cols).toContain("address1");
  });
});

// ── Pidió no ser contactado: nada automático le escribe ─────────────────────

describe("opt-out: drip, secuencia de carritos y winback", () => {
  const dripLead = (over: Record<string, unknown> = {}) => ({
    id: "L1",
    phone: "51999888777",
    name: "Ana",
    status: "no_responde",
    needs_attention: false,
    next_followup_at: null,
    last_interaction_at: "2026-10-13T10:00:00Z",
    last_inbound_at: "2026-10-12T10:00:00Z",
    drip_touches: 0,
    last_drip_at: null,
    ...over,
  });
  const NOW = Date.parse("2026-10-14T15:00:00Z");

  it("dripSkipReason lo salta antes que cualquier otra regla", () => {
    expect(dripSkipReason(dripLead(), NOW)).toBeNull();
    expect(dripSkipReason(dripLead({ contact_opt_out_at: "2026-10-12T15:00:00Z" }), NOW)).toBe("no_contactar");
    expect(dripSkipReason(dripLead({ contact_opt_out_at: "2026-10-12T15:00:00Z", status: "nuevo" }), NOW)).toBe("no_contactar");
  });

  it("cartSeqSkipReason lo salta aunque llegue un carrito nuevo", () => {
    const lead = {
      id: "L1",
      phone: "51999888777",
      name: "Ana",
      category: "open",
      has_order: false,
      draft_order_gid: "gid://shopify/DraftOrder/1",
      draft_order_status: "open",
      last_inbound_at: null,
      cart_seq_touches: 0,
      last_cart_seq_at: null,
      cart_seq_gid: null,
    };
    const cfg = { hours1: 3, hours2: 24 };
    expect(cartSeqSkipReason(lead, "2026-10-14T08:00:00Z", NOW, cfg)).toBeNull();
    expect(cartSeqSkipReason({ ...lead, contact_opt_out_at: "2026-10-12T15:00:00Z" }, "2026-10-14T08:00:00Z", NOW, cfg)).toBe(
      "no_contactar",
    );
  });

  /** Supabase de mentira para los envíos: responde selects de leads con `rows`. */
  function sender(rows: unknown[], selectError?: (cols: string) => string | null) {
    const selects: string[] = [];
    const writes: { table: string; op: string; payload: unknown }[] = [];
    const from = (table: string) => {
      let op = "select";
      let cols = "";
      let payload: unknown;
      const q: Record<string, unknown> = {};
      q.select = (c: string) => {
        if (op === "select") cols = c;
        return q;
      };
      for (const w of ["insert", "update", "upsert"]) {
        q[w] = (p: unknown) => {
          op = w;
          payload = p;
          return q;
        };
      }
      for (const m of ["eq", "in", "is", "not", "lt", "lte", "gte", "order", "limit", "match"]) q[m] = () => q;
      const run = (): Reply => {
        if (op !== "select") {
          writes.push({ table, op, payload });
          return { data: null, error: null };
        }
        if (table !== "leads") return { data: [], error: null };
        selects.push(cols);
        const err = selectError?.(cols) ?? null;
        return err ? { data: null, error: { message: err } } : { data: rows, error: null };
      };
      q.maybeSingle = async () => run();
      q.then = (res: (r: Reply) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
      return q;
    };
    return { admin: { from } as never, selects, writes };
  }
  const spySend = () => {
    const to: string[] = [];
    const fn = async (_o: unknown, p: { to: string }) => {
      to.push(p.to);
      return { ok: true };
    };
    return { fn: fn as never, to };
  };

  it("el drip no le envía la plantilla", async () => {
    const { admin, selects } = sender([
      dripLead({ id: "L1", phone: "51999888777" }),
      dripLead({ id: "L2", phone: "51999888778", contact_opt_out_at: "2026-10-12T15:00:00Z" }),
    ]);
    const send = spySend();
    const creds = { drip_template_enabled: true, drip_template_name: "seguimiento_nr_1", kapso_api_key: "k", whatsapp_phone_number_id: "pn", timezone: "America/Lima" };
    const report = await sendSeguimientoDrip(admin, "store-1", creds as never, send.fn, "2026-10-14T15:00:00Z");
    expect(send.to).toEqual(["51999888777"]);
    expect(report.sent).toBe(1);
    expect(selects[0]).toContain("contact_opt_out_at");
    expect(selects[0]).toContain("attention_waves");
  });

  it("pre-0247 el drip quita solo la columna que falta y sigue (y pre-0036, las dos)", async () => {
    const missing = new Set(["contact_opt_out_at", "attention_waves"]);
    const { admin, selects } = sender([dripLead()], (cols) => {
      for (const c of missing) if (cols.includes(c)) return `column leads.${c} does not exist`;
      return null;
    });
    const send = spySend();
    const creds = { drip_template_enabled: true, drip_template_name: "seguimiento_nr_1", kapso_api_key: "k", whatsapp_phone_number_id: "pn", timezone: "America/Lima" };
    await sendSeguimientoDrip(admin, "store-1", creds as never, send.fn, "2026-10-14T15:00:00Z");
    // Postgres nombra una columna desconocida por vez: una por reintento.
    expect(selects).toHaveLength(3);
    expect(selects[1]).not.toContain("contact_opt_out_at");
    expect(selects[1]).toContain("attention_waves");
    expect(selects[2]).not.toMatch(/attention_waves|contact_opt_out_at/);
    expect(send.to).toEqual(["51999888777"]);
  });

  it("la secuencia de carritos no le envía, y pre-0247 reintenta sin la columna", () => {
    const src = read("lib", "cart-sequence.ts");
    expect(src).toContain("let { data, error } = await buildSelect(`${COLS}, contact_opt_out_at`);");
    expect(src).toContain("if (error && /contact_opt_out_at/i.test(error.message)) {");
    expect(src).toMatch(/if \(l\.contact_opt_out_at\) return "no_contactar";\n\s*if \(!l\.draft_order_gid\) return "sin_carrito";/);
  });

  it("runCartSequence salta al que pidió no ser contactado", async () => {
    const cartLead = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      phone: `5199988877${id.slice(-1)}`,
      name: "Ana",
      category: "open",
      has_order: false,
      draft_order_gid: `gid://shopify/DraftOrder/${id}`,
      draft_order_status: "open",
      last_inbound_at: null,
      cart_seq_touches: 0,
      last_cart_seq_at: null,
      cart_seq_gid: null,
      cart_summary: "Shampoo x 1",
      cart_value: 85,
      address1: "Jr Lima 123",
      district: "Cayma",
      referencia: null,
      wa_phone_number_id: "pn",
      ...over,
    });
    const leads = [cartLead("L1"), cartLead("L2", { contact_opt_out_at: "2026-10-12T15:00:00Z" })];
    const drafts = leads.map((l) => ({
      draft_order_gid: l.draft_order_gid,
      created_at: "2026-10-14T08:00:00Z",
      line_items: [{ title: "Shampoo", quantity: 1 }],
      total_amount: 85,
      currency: "PEN",
    }));
    const to: string[] = [];
    const admin = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "not", "order", "limit", "update", "insert", "is"]) q[m] = () => q;
        const data = table === "leads" ? leads : table === "draft_orders" ? drafts : null;
        q.then = (res: (r: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
        return q;
      },
    };
    const creds = {
      cart_seq_enabled: true, kapso_api_key: "k", timezone: "America/Lima", cart_seq_hour_start: 0, cart_seq_hour_end: 24,
      cart_seq_hours_1: 3, cart_seq_hours_2: 24, whatsapp_phone_number_id: "pn",
      cart_seq_template_1_name: "carrito_abandonado_1", cart_seq_template_1_language: "es",
      cart_seq_template_2_name: "carrito_abandonado_2", cart_seq_template_2_language: "es",
    };
    const send = async (_o: unknown, p: { to: string }) => {
      to.push(p.to);
      return { ok: true };
    };
    await runCartSequence(admin as never, "store-1", creds as never, send as never, "2026-10-14T15:00:00Z", "https://kapso.example");
    expect(to).toEqual(["51999888771"]);
  });

  const WINBACK = { source: "winback", order: { id: 7001 }, customer: { id: 9001, name: "Fanny", phone: "+51 953 249 192" } };
  const winbackCreds = {
    winback_template_enabled: true,
    winback_template_name: "recuperacion_60d_1",
    winback_template_language: "es",
    kapso_api_key: "k",
    whatsapp_phone_number_id: "pn",
  };
  const outcomeOf = (writes: { table: string; op: string; payload: unknown }[]) =>
    (writes.find((w) => w.table === "webhook_events" && w.op === "update")?.payload as { error: string | null }).error;

  it("el winback no le escribe a un lead que pidió no ser contactado", async () => {
    const { admin, writes } = sender([]);
    // El lead del teléfono existe y pidió no ser contactado.
    const from = (admin as unknown as { from: (t: string) => Record<string, unknown> }).from;
    const optedOut = {
      from: (t: string) => {
        const q = from(t);
        if (t === "leads") q.maybeSingle = async () => ({ data: { contact_opt_out_at: "2026-10-12T15:00:00Z" }, error: null });
        return q;
      },
    };
    const send = spySend();
    await processWinback(optedOut as never, "store-1", WINBACK, winbackCreds as never, send.fn);
    expect(send.to).toEqual([]);
    expect(outcomeOf(writes)).toBe("Omitido: pidió no ser contactado (agente de voz)");
  });

  it("winback: sin la columna (pre-0247) envía; si no se puede leer, no", async () => {
    let leadsReply: Reply = { data: null, error: { message: "column leads.contact_opt_out_at does not exist" } };
    const mk = () => {
      const s = sender([]);
      const base = (s.admin as unknown as { from: (t: string) => Record<string, unknown> }).from;
      return {
        ...s,
        admin: {
          from: (t: string) => {
            const q = base(t);
            if (t === "leads") q.maybeSingle = async () => leadsReply;
            return q;
          },
        } as never,
      };
    };
    let s = mk();
    let send = spySend();
    await processWinback(s.admin, "store-1", WINBACK, winbackCreds as never, send.fn);
    expect(send.to).toEqual(["51953249192"]);

    leadsReply = { data: null, error: { message: "statement timeout" } };
    s = mk();
    send = spySend();
    await processWinback(s.admin, "store-1", { ...WINBACK, order: { id: 7002 } }, winbackCreds as never, send.fn);
    expect(send.to).toEqual([]);
    expect(outcomeOf(s.writes)).toBe("Omitido: no se pudo leer si pidió no ser contactado");
  });
});

// ── El agente cuenta como gestión, no como trabajo de asesora ───────────────

describe("lo que escribe el agente frente a la sync y Productividad", () => {
  it("lastDispositionAtByPhone cuenta sus filas con estado (kind voice_agent), como las de una asesora", async () => {
    const seen: Call[] = [];
    const from = (table: string) => {
      const call: Call = { table, op: "select", filters: [] };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      for (const m of ["eq", "in", "is", "not", "order", "limit"]) {
        q[m] = (col: string, v: unknown) => {
          call.filters.push([m, col, v]);
          return q;
        };
      }
      q.then = (res: (r: Reply) => unknown) => {
        seen.push(call);
        const data =
          table === "leads"
            ? [{ id: "L1", phone: "51999888777" }]
            : [{ lead_id: "L1", occurred_at: "2026-10-14T14:00:00Z" }];
        return Promise.resolve({ data, error: null }).then(res);
      };
      return q;
    };
    const out = await lastDispositionAtByPhone({ from } as never, "store-1", ["51999888777"]);
    expect(out.get("51999888777")).toBe("2026-10-14T14:00:00Z");
    const lc = seen.find((c) => c.table === "lead_calls");
    expect(has(lc, "in", "kind", ["call", "voice_agent"])).toBe(true);
    expect(has(lc, "not", "new_status", "is")).toBe(true);
    expect(filtersOf(lc).some(([m, c]) => m === "eq" && c === "kind")).toBe(false);
  });

  it("Productividad no cuenta al agente como trabajo de venta", () => {
    expect(isSalesTouch("voice_agent")).toBe(false);
    expect(isSalesTouch("call")).toBe(true);
  });
});
