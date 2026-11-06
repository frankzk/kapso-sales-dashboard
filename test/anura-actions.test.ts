// Las acciones de «Llamar con Anura» (app/dashboard/pedidos/anura-actions.ts y
// app/dashboard/[storeId]/settings/anura-actions.ts) con la base simulada y
// los permisos de verdad del lado de quien llama:
//   - llamar pide `master.edit`, el token, un anexo activo y un celular
//     peruano; el teléfono sale del pedido, nunca del navegador;
//   - una sola llamada viva por persona, y la `solicitada` sin avisos se
//     suelta a los 60 s;
//   - si Anura rechaza, la fila queda fallida con el motivo;
//   - Ajustes pide `stores.manage` en la org de la tienda; el token nunca
//     sale del servidor; un anexo es de una sola persona;
//   - la prueba de Ajustes no toca ningún pedido.
// fetch está simulado: ninguna prueba llama a Anura.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/anura-fake-db";

const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
const OTHER_ORG = "99999999-1111-4222-8333-444444444444";
const STORE = "5e5e5e5e-1111-4222-8333-444444444444";
const ORDER = "6f6f6f6f-1111-4222-8333-444444444444";
const ME = "7a7a7a7a-1111-4222-8333-444444444444";
const OTHER = "8b8b8b8b-1111-4222-8333-444444444444";
const PHONE = "+51 987 654 321";
const EXT_ME = "9c9c9c9c-1111-4222-8333-444444444444";
const TOKEN_VALUE = "tok-secreto-de-prueba";

const st = vi.hoisted(() => ({
  user: "",
  perms: new Set<string>(),
  orgPerms: new Map<string, Set<string>>(),
  admin: null as any,
  rls: null as any,
  visibleStores: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "kapta.test"], ["x-forwarded-proto", "https"]]) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => (st.user ? { id: st.user, email: null } : null) }));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: async () => ({ can: (p: string) => st.perms.has(p), roles: [], permissions: st.perms, readOnly: false }),
  hasOrgPermission: async (org: string, p: string) => st.orgPerms.get(org)?.has(p) ?? false,
}));
vi.mock("@/lib/agent-names", () => ({
  resolveAgentNames: async (ids: Iterable<string>) => Object.fromEntries([...ids].map((id) => [id, `persona-${id.slice(0, 4)}`])),
}));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => st.admin.client,
  createServerSupabase: async () => st.rls.client,
}));

import { getAnuraCallStatus, getAnuraOrderCalls, startAnuraCall } from "@/app/dashboard/pedidos/anura-actions";
import {
  getAnuraSettings,
  removeAnuraExtension,
  saveAnuraExtension,
  startAnuraTestCall,
} from "@/app/dashboard/[storeId]/settings/anura-actions";

let db: FakeDb;
const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

function setup() {
  db = createFakeDb({
    order_master: [{ order_id: ORDER, store_id: STORE, customer_phone: PHONE }],
    stores: [{ id: STORE, org_id: ORG }],
    memberships: [
      { org_id: ORG, user_id: ME, role: "vendedora" },
      { org_id: ORG, user_id: OTHER, role: "vendedora" },
    ],
    anura_extensions: [{ id: EXT_ME, org_id: ORG, user_id: ME, extension: "101", active: true }],
    anura_calls: [],
    anura_webhook_events: [],
    order_events: [],
  });
  st.admin = db;
  st.rls = createFakeDb(
    {},
    {
      shared: db.tables,
      visible: (table, row) => {
        if (table === "order_master" || table === "stores") return st.visibleStores.has(row.store_id ?? row.id);
        if (table === "anura_calls") return !!row.store_id && st.visibleStores.has(row.store_id);
        return true;
      },
    },
  );
}

beforeEach(() => {
  setup();
  st.user = ME;
  st.perms = new Set(["master.edit"]);
  st.orgPerms = new Map();
  st.visibleStores = new Set([STORE]);
  process.env.ANURA_CLICK2DIAL_TOKEN = `  "Bearer ${TOKEN_VALUE}" `;
  process.env.ENCRYPTION_KEY = "clave-de-prueba-no-es-la-real";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("startAnuraCall", () => {
  it("sin master.edit no llama ni escribe", async () => {
    st.perms = new Set();
    const r = await startAnuraCall(ORDER);
    expect(r).toEqual({ ok: false, error: "Tu rol no permite llamar con Anura." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables.anura_calls).toHaveLength(0);
  });

  it("sin token de Anura no hay llamada", async () => {
    delete process.env.ANURA_CLICK2DIAL_TOKEN;
    const r = await startAnuraCall(ORDER);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no está configurado/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un pedido que no se ve por RLS es «sin acceso»", async () => {
    st.visibleStores = new Set();
    expect(await startAnuraCall(ORDER)).toMatchObject({ ok: false, error: "Sin acceso a este pedido." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin anexo (o con el anexo apagado) no hay llamada", async () => {
    db.tables.anura_extensions[0]!.active = false;
    expect(await startAnuraCall(ORDER)).toMatchObject({ ok: false, error: expect.stringMatching(/anexo de Anura/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con un teléfono que no es celular peruano no llama", async () => {
    db.tables.order_master[0]!.customer_phone = "014567890";
    expect(await startAnuraCall(ORDER)).toMatchObject({ ok: false, error: expect.stringMatching(/celular peruano/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pide el Click2Dial con el teléfono DEL PEDIDO y deja la fila solicitada", async () => {
    const r = await startAnuraCall(ORDER);
    expect(r).toMatchObject({ ok: true, extension: "101", toMasked: "98••••321" });
    if (!r.ok) throw new Error("debía llamar");
    expect(db.tables.anura_calls).toHaveLength(1);
    expect(db.tables.anura_calls[0]).toMatchObject({
      id: r.callId,
      org_id: ORG,
      store_id: STORE,
      order_id: ORDER,
      user_id: ME,
      mode: "pedido",
      status: "solicitada",
      phone: "987654321",
      extension: "101",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anura.pe/adapter/default/click2call");
    // El token, limpio de comillas, «Bearer » y espacios.
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN_VALUE}`);
    expect(init.body).toBe(`called=987654321&extension=101&customs=kapta-${r.callId}`);
    // Nada del token vuelve al navegador.
    expect(JSON.stringify(r)).not.toContain(TOKEN_VALUE);
  });

  it("una sola llamada viva por persona", async () => {
    const first = await startAnuraCall(ORDER);
    expect(first.ok).toBe(true);
    const second = await startAnuraCall(ORDER);
    expect(second).toMatchObject({ ok: false, code: "ocupada", activeCallId: first.ok ? first.callId : "" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Todavía pedida: se suelta sola al minuto. Ya sonando: a las 2 horas.
    expect(second.ok ? "" : second.error).toMatch(/se libera sola al minuto/);
    db.tables.anura_calls[0]!.status = "sonando";
    db.tables.anura_calls[0]!.status_rank = 10;
    db.tables.anura_calls[0]!.last_event_at = new Date().toISOString();
    const third = await startAnuraCall(ORDER);
    expect(third.ok ? "" : third.error).toMatch(/Cuelga en tu teléfono de Anura; .* a las 2 horas/);
  });

  it("con ANURA_ORG_ID, otra organización no ve el botón ni puede llamar", async () => {
    process.env.ANURA_ORG_ID = OTHER_ORG;
    try {
      expect(await startAnuraCall(ORDER)).toMatchObject({ ok: false, error: expect.stringMatching(/no está configurado/) });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await getAnuraOrderCalls(ORDER)).toMatchObject({ enabled: false });
      process.env.ANURA_ORG_ID = ORG.toUpperCase();
      expect(await startAnuraCall(ORDER)).toMatchObject({ ok: true });
    } finally {
      delete process.env.ANURA_ORG_ID;
    }
  });

  it("si Anura no respondió a tiempo, la fila sigue pedida y se devuelve para seguirla", async () => {
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const r = await startAnuraCall(ORDER);
    expect(r).toMatchObject({ ok: false, code: "tiempo", activeCallId: db.tables.anura_calls[0]!.id });
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "solicitada", status_rank: 0 });
    expect(r.ok ? "" : r.error).toMatch(/puede que igual haga la llamada/);
  });

  it("la solicitada sin avisos de Anura se suelta a los 60 s", async () => {
    db.tables.anura_calls.push({
      id: "11111111-1111-4111-8111-111111111111",
      org_id: ORG,
      store_id: STORE,
      order_id: ORDER,
      user_id: ME,
      mode: "pedido",
      direction: "out",
      status: "solicitada",
      status_rank: 0,
      closed_by_timeout: false,
      requested_at: new Date(Date.now() - 61_000).toISOString(),
    });
    const r = await startAnuraCall(ORDER);
    expect(r.ok).toBe(true);
    const old = db.tables.anura_calls.find((c) => c.id === "11111111-1111-4111-8111-111111111111")!;
    expect(old).toMatchObject({ status: "fallida", status_rank: 100, closed_by_timeout: true });
    expect(old.failure_reason).toMatch(/Anura no llegó a hacer la llamada/);
  });

  it("si Anura rechaza, la fila queda fallida con el motivo y no entra al historial", async () => {
    fetchMock.mockImplementation(async () => new Response("Originate Terminal is not registered", { status: 400 }));
    const r = await startAnuraCall(ORDER);
    expect(r).toMatchObject({ ok: false, code: "terminal_no_registrada" });
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "fallida", status_rank: 100 });
    expect(db.tables.anura_calls[0]!.failure_reason).toMatch(/terminal principal/);
    expect(db.tables.order_events).toHaveLength(0);
  });
});

describe("getAnuraCallStatus y la ficha", () => {
  it("quien la pidió la ve; otra persona sin acceso a la tienda, no", async () => {
    const r = await startAnuraCall(ORDER);
    if (!r.ok) throw new Error("debía llamar");
    const mine = await getAnuraCallStatus(r.callId);
    expect(mine).toMatchObject({ ok: true, call: { id: r.callId, status: "solicitada", active: true, toMasked: "98••••321" } });
    expect(JSON.stringify(mine)).not.toContain("987654321");

    st.user = OTHER;
    st.visibleStores = new Set();
    expect(await getAnuraCallStatus(r.callId)).toEqual({ ok: false, error: "Llamada no encontrada." });
    expect(await getAnuraCallStatus("no-es-uuid")).toEqual({ ok: false, error: "Llamada no encontrada." });
  });

  it("el panel de la ficha: botón solo con anexo, llamadas del pedido con la grabación por el mismo origen", async () => {
    db.tables.anura_calls.push({
      id: "22222222-2222-4222-8222-222222222222",
      org_id: ORG,
      store_id: STORE,
      order_id: ORDER,
      user_id: ME,
      mode: "pedido",
      direction: "out",
      extension: "101",
      phone: "987654321",
      status: "contestada",
      status_rank: 100,
      bill_seconds: 75,
      closed_by_timeout: false,
      recording_status: "guardada",
      recording_path: `${ORG}/2026-11/x.mp3`,
      requested_at: "2026-11-05T15:00:00.000Z",
    });
    const panel = await getAnuraOrderCalls(ORDER);
    expect(panel).toMatchObject({ enabled: true, extension: "101", activeCall: null });
    expect(panel.calls).toHaveLength(1);
    expect(panel.calls[0]).toMatchObject({ status: "contestada", answered: true, talkLabel: "1 min 15 s", who: "persona-7a7a" });
    // La CSP no deja al <audio> cargar de Supabase: la ficha recibe la ruta
    // del mismo origen, nunca la URL firmada.
    expect(panel.calls[0]!.recordingUrl).toBe("/api/anura/recordings/22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(panel)).not.toContain("storage.test");
    // Sin clave SIP guardada: fase 1 (suena su teléfono de Anura).
    expect(panel.kaptaPhone).toEqual({ status: "sin_telefono", message: null, rejectedAt: null });
    expect(JSON.stringify(panel)).not.toContain("987654321");

    db.tables.anura_extensions.length = 0;
    expect(await getAnuraOrderCalls(ORDER)).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/anexo/) });
  });
});

describe("Ajustes › Telefonía Anura", () => {
  beforeEach(() => {
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
  });

  it("sin stores.manage no se ve ni se cambia nada", async () => {
    st.orgPerms = new Map([[OTHER_ORG, new Set(["stores.manage"])]]);
    expect(await getAnuraSettings(STORE)).toEqual({ ok: false, error: "Solo quien administra la tienda configura Anura." });
    expect(await saveAnuraExtension(STORE, OTHER, "102")).toMatchObject({ ok: false });
    expect(await removeAnuraExtension(STORE, EXT_ME)).toMatchObject({ ok: false });
    expect(await startAnuraTestCall(STORE, "987654321")).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables.anura_extensions).toHaveLength(1);
  });

  it("dice si hay token sin decir cuál, la URL del webhook y la plantilla", async () => {
    db.tables.anura_webhook_events.push({
      id: "ev1",
      org_id: ORG,
      received_at: new Date().toISOString(),
      event: "END",
      outcome: "aplicado",
      payload: { calling: "51912345678", called: "98••••321", accountExtension: "101", billSeconds: 12 },
      recording_url: "https://audio.anura.pe/secreto.mp3",
    });
    const r = await getAnuraSettings(STORE);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.configured).toBe(true);
    expect(r.data.webhook!.url).toMatch(new RegExp(`^https://kapta\\.test/api/webhooks/anura\\?org=${ORG}&t=[0-9a-f]{32}$`));
    expect(r.data.webhook).toMatchObject({ protocol: "HTTPS", host: "kapta.test", port: 443 });
    expect(r.data.webhook!.path.startsWith("api/webhooks/anura?org=")).toBe(true);
    expect(JSON.parse(r.data.template).custom1).toBe("{{ custom1 }}");
    expect(r.data.extensions).toEqual([
      {
        id: EXT_ME,
        userId: ME,
        name: "persona-7a7a",
        extension: "101",
        active: true,
        phone: { status: "sin_telefono", sipUser: "101-websocket", hasPassword: false, savedAt: null, rejectedAt: null, rejectedReason: null },
      },
    ]);
    expect(r.data.sip).toEqual({ domain: null, wsUrl: "wss://sipwss.anura.pe", port: 55090, updatedAt: null });
    expect(r.data.sipMigrationMissing).toBe(false);
    expect(r.data.recentEvents[0]).toMatchObject({ calling: "51••••••678", called: "98••••321", extension: "101", billSeconds: 12 });
    const text = JSON.stringify(r);
    expect(text).not.toContain(TOKEN_VALUE);
    expect(text).not.toContain("912345678");
    expect(text).not.toContain("audio.anura.pe");

    delete process.env.ANURA_CLICK2DIAL_TOKEN;
    const off = await getAnuraSettings(STORE);
    expect(off.ok && off.data.configured).toBe(false);
  });

  it("un anexo es de una sola persona del equipo", async () => {
    expect(await saveAnuraExtension(STORE, OTHER, "101")).toMatchObject({ ok: false, error: expect.stringMatching(/ya está asignado/) });
    expect(await saveAnuraExtension(STORE, OTHER, "1")).toMatchObject({ ok: false });
    expect(await saveAnuraExtension(STORE, "12121212-1111-4222-8333-444444444444", "103")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no es del equipo/),
    });
    expect(await saveAnuraExtension(STORE, OTHER, "102")).toEqual({ ok: true, notice: "Anexo 102 asignado." });
    // Cambiar el anexo de la misma persona lo reemplaza, no agrega otro.
    expect(await saveAnuraExtension(STORE, OTHER, "103")).toMatchObject({ ok: true });
    expect(db.tables.anura_extensions.filter((e) => e.user_id === OTHER).map((e) => e.extension)).toEqual(["103"]);
    expect(await removeAnuraExtension(STORE, EXT_ME)).toMatchObject({ ok: true });
    expect(db.tables.anura_extensions.some((e) => e.id === EXT_ME)).toBe(false);
  });

  it("la llamada de prueba usa el anexo de quien prueba y no toca pedidos", async () => {
    expect(await startAnuraTestCall(STORE, "12345")).toMatchObject({ ok: false, error: expect.stringMatching(/celular peruano/) });
    const r = await startAnuraTestCall(STORE, "51912345678");
    expect(r).toMatchObject({ ok: true, extension: "101" });
    // Sin tienda: nadie más lee por RLS el número que escribió quien administra.
    expect(db.tables.anura_calls[0]).toMatchObject({ mode: "prueba", order_id: null, store_id: null, user_id: ME, phone: "912345678" });
    expect(await startAnuraTestCall(STORE, "912345678", "555")).toMatchObject({ ok: false });
    // Quien la pidió la sigue igual.
    expect(await getAnuraCallStatus(r.ok ? r.callId : "")).toMatchObject({ ok: true, call: { mode: "prueba", toMasked: "91••••678" } });
  });
});
