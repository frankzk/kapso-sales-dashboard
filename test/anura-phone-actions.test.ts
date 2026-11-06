// «Llamar con Anura», fase 2: las acciones del teléfono dentro de Kapta, con
// la base simulada y la criptografía de verdad (lib/crypto.ts).
//   - la clave SIP se guarda CIFRADA y nunca vuelve en Ajustes (solo «clave
//     guardada: sí/no», la fecha y si Anura la rechazó);
//   - la clave solo se entrega a la DUEÑA del anexo, al llamar: master.edit,
//     pedido visible, Anura encendido para la org, anexo activo propio;
//   - «clave rechazada» corta la entrega hasta que se guarde otra, y solo marca
//     la versión entregada del anexo propio;
//   - un 404 es «dominio no reconocido»: corta igual; guardar un dominio
//     distinto no lo libera solo, sino cuando Anura acepta ese dominio en un
//     «Probar y guardar» (no el mismo dominio, y nunca una clave rechazada);
//   - cambiar el número del anexo borra su clave;
//   - la grabación se sirve por una ruta del mismo origen con permisos.
// Ninguna prueba llama a Anura ni abre conexiones SIP.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/anura-fake-db";
import { decrypt, generateEncryptionKey } from "@/lib/crypto";

const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
const OTHER_ORG = "99999999-1111-4222-8333-444444444444";
const STORE = "5e5e5e5e-1111-4222-8333-444444444444";
const ORDER = "6f6f6f6f-1111-4222-8333-444444444444";
const ME = "7a7a7a7a-1111-4222-8333-444444444444";
const OTHER = "8b8b8b8b-1111-4222-8333-444444444444";
const EXT_ME = "9c9c9c9c-1111-4222-8333-444444444444";
const EXT_OTHER = "9d9d9d9d-1111-4222-8333-444444444444";
const SIP_PASSWORD = "Sup3r-clave-SIP";

const st = vi.hoisted(() => ({
  user: "",
  perms: new Set<string>(),
  orgPerms: new Map<string, Set<string>>(),
  /** Las orgs donde la persona tiene `master.edit` (la del pedido, salvo que la prueba diga otra). */
  masterEditOrgs: new Set<string>(),
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
  hasOrgPermission: async (org: string, p: string) =>
    (st.orgPerms.get(org)?.has(p) ?? false) || (p === "master.edit" && st.masterEditOrgs.has(org)),
}));
vi.mock("@/lib/agent-names", () => ({
  resolveAgentNames: async (ids: Iterable<string>) => Object.fromEntries([...ids].map((id) => [id, `persona-${id.slice(0, 4)}`])),
}));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => st.admin.client,
  createServerSupabase: async () => st.rls.client,
}));

import { getAnuraOrderCalls, getAnuraPhone, reportAnuraPhoneRejected } from "@/app/dashboard/pedidos/anura-actions";
import {
  getAnuraSettings,
  getAnuraTestPhone,
  removeAnuraSipCredentials,
  reportAnuraTestPhoneRejected,
  saveAnuraExtension,
  saveAnuraSipCredentials,
  saveAnuraSipSettings,
} from "@/app/dashboard/[storeId]/settings/anura-actions";
import { GET as recordingGET } from "@/app/api/anura/recordings/[callId]/route";

let db: FakeDb;
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));

function setup() {
  db = createFakeDb({
    order_master: [{ order_id: ORDER, store_id: STORE, customer_phone: "+51 987 654 321" }],
    stores: [{ id: STORE, org_id: ORG }],
    memberships: [
      { org_id: ORG, user_id: ME, role: "vendedora" },
      { org_id: ORG, user_id: OTHER, role: "vendedora" },
    ],
    anura_extensions: [
      { id: EXT_ME, org_id: ORG, user_id: ME, extension: "101", active: true },
      { id: EXT_OTHER, org_id: ORG, user_id: OTHER, extension: "102", active: true },
    ],
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

async function saveAsAdmin(extensionId = EXT_ME, over: Record<string, unknown> = {}) {
  const prev = st.orgPerms;
  st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
  try {
    return await saveAnuraSipCredentials(STORE, extensionId, { domain: "sip:101-websocket@Kenku.anura.pe:55090", password: ` ${SIP_PASSWORD} `, ...over });
  } finally {
    st.orgPerms = prev;
  }
}

beforeEach(() => {
  setup();
  st.user = ME;
  st.perms = new Set(["master.edit"]);
  st.orgPerms = new Map();
  st.masterEditOrgs = new Set([ORG]);
  st.visibleStores = new Set([STORE]);
  process.env.ANURA_CLICK2DIAL_TOKEN = "tok-de-prueba";
  delete process.env.ANURA_ORG_ID;
  process.env.ENCRYPTION_KEY = generateEncryptionKey();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("Ajustes: guardar la clave SIP («Probar y guardar»)", () => {
  it("pide stores.manage", async () => {
    st.orgPerms = new Map([[OTHER_ORG, new Set(["stores.manage"])]]);
    expect(await saveAnuraSipCredentials(STORE, EXT_ME, { domain: "kenku.anura.pe", password: "x" })).toMatchObject({ ok: false });
    expect(await saveAnuraSipSettings(STORE, { domain: "kenku.anura.pe" })).toMatchObject({ ok: false });
    expect(await removeAnuraSipCredentials(STORE, EXT_ME)).toMatchObject({ ok: false });
    expect(db.tables.anura_sip_credentials).toHaveLength(0);
    expect(db.tables.anura_sip_settings).toHaveLength(0);
  });

  it("guarda la central y la clave CIFRADA; Ajustes solo dice «guardada»", async () => {
    expect(await saveAsAdmin()).toEqual({ ok: true, notice: "Teléfono de Kapta listo para el anexo 101." });
    expect(db.tables.anura_sip_settings[0]).toMatchObject({ org_id: ORG, sip_domain: "kenku.anura.pe", ws_url: "wss://sipwss.anura.pe", sip_port: 55090 });
    const row = db.tables.anura_sip_credentials[0]!;
    expect(row).toMatchObject({ extension_id: EXT_ME, org_id: ORG, extension: "101", sip_user: "101-websocket", rejected_at: null });
    expect(row.password_cipher).toMatch(/^v1:/);
    expect(row.password_cipher).not.toContain(SIP_PASSWORD);
    expect(decrypt(row.password_cipher)).toBe(SIP_PASSWORD);

    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    const r = await getAnuraSettings(STORE);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.sip).toMatchObject({ domain: "kenku.anura.pe", wsUrl: "wss://sipwss.anura.pe", port: 55090 });
    const mine = r.data.extensions.find((e) => e.id === EXT_ME)!;
    expect(mine.phone).toMatchObject({ status: "listo", sipUser: "101-websocket", hasPassword: true, rejectedAt: null });
    expect(mine.phone.savedAt).toBe(row.saved_at);
    expect(r.data.extensions.find((e) => e.id === EXT_OTHER)!.phone).toMatchObject({ status: "sin_telefono", hasPassword: false, sipUser: "102-websocket" });
    const text = JSON.stringify(r);
    expect(text).not.toContain(SIP_PASSWORD);
    expect(text).not.toContain(row.password_cipher);
  });

  it("valida lo que se escribe", async () => {
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    expect(await saveAnuraSipCredentials(STORE, EXT_ME, { domain: "kenku", password: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/dominio/) });
    expect(await saveAnuraSipCredentials(STORE, EXT_ME, { domain: "kenku.anura.pe", wsUrl: "wss://sip.anura.dev", password: "x" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/anura\.pe/),
    });
    expect(await saveAnuraSipCredentials(STORE, EXT_ME, { domain: "kenku.anura.pe", password: "   " })).toMatchObject({ ok: false, error: expect.stringMatching(/contraseña/) });
    expect(await saveAnuraSipCredentials(STORE, EXT_ME, { domain: "kenku.anura.pe", sipUser: "101 web", password: "x" })).toMatchObject({ ok: false });
    expect(await saveAnuraSipCredentials(STORE, "no-es-uuid", { domain: "kenku.anura.pe", password: "x" })).toMatchObject({ ok: false, error: "Anexo no encontrado." });
    expect(db.tables.anura_sip_credentials).toHaveLength(0);
  });

  it("sin ENCRYPTION_KEY no guarda nada en claro", async () => {
    delete process.env.ENCRYPTION_KEY;
    expect(await saveAsAdmin()).toMatchObject({ ok: false, error: expect.stringMatching(/ENCRYPTION_KEY/) });
    expect(db.tables.anura_sip_credentials).toHaveLength(0);
  });

  it("«Quitar clave» devuelve el anexo a la fase 1", async () => {
    await saveAsAdmin();
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    expect(await removeAnuraSipCredentials(STORE, EXT_ME)).toEqual({ ok: true, notice: "Clave del anexo 101 quitada." });
    expect(db.tables.anura_sip_credentials).toHaveLength(0);
    expect((await getAnuraOrderCalls(ORDER)).kaptaPhone.status).toBe("sin_telefono");
  });

  it("cambiar el número del anexo borra su clave", async () => {
    await saveAsAdmin();
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    expect(await saveAnuraExtension(STORE, ME, "103")).toMatchObject({ ok: true });
    expect(db.tables.anura_sip_credentials).toHaveLength(0);
  });
});

describe("la ficha: las credenciales solo para la dueña del anexo", () => {
  it("con clave guardada, la ficha sabe que el teléfono está en Kapta", async () => {
    await saveAsAdmin();
    const panel = await getAnuraOrderCalls(ORDER);
    expect(panel).toMatchObject({ enabled: true, extension: "101", kaptaPhone: { status: "listo", message: null } });
    expect(JSON.stringify(panel)).not.toContain(SIP_PASSWORD);
  });

  it("entrega usuario, clave, dominio y WebSocket de SU anexo", async () => {
    await saveAsAdmin();
    const r = await getAnuraPhone(ORDER);
    expect(r).toEqual({
      ok: true,
      phone: {
        extension: "101",
        sipUser: "101-websocket",
        password: SIP_PASSWORD,
        domain: "kenku.anura.pe",
        wsUrl: "wss://sipwss.anura.pe",
        port: 55090,
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        credentialVersion: db.tables.anura_sip_credentials[0]!.saved_at,
      },
    });
    // El teléfono de la clienta no viaja: lo marca Anura.
    expect(JSON.stringify(r)).not.toContain("987654321");
  });

  it("la clave de otra persona no se entrega: cada quien recibe la suya o nada", async () => {
    await saveAsAdmin(EXT_OTHER);
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "sin_telefono" });
    st.user = OTHER;
    const r = await getAnuraPhone(ORDER);
    expect(r).toMatchObject({ ok: true, phone: { extension: "102", sipUser: "102-websocket" } });
  });

  it("sin master.edit, sin pedido visible, con Anura apagado o con el anexo apagado no hay clave", async () => {
    await saveAsAdmin();
    st.perms = new Set();
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "permiso" });
    st.perms = new Set(["master.edit"]);
    // `master.edit` solo en OTRA org (la unión de permisos dice que sí): sin clave.
    st.masterEditOrgs = new Set([OTHER_ORG]);
    const denied = await getAnuraPhone(ORDER);
    expect(denied).toMatchObject({ ok: false, code: "permiso" });
    expect(JSON.stringify(denied)).not.toContain("clave-sip");
    st.masterEditOrgs = new Set([ORG]);
    st.visibleStores = new Set();
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "pedido" });
    st.visibleStores = new Set([STORE]);
    process.env.ANURA_ORG_ID = OTHER_ORG;
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "no_configurado" });
    delete process.env.ANURA_ORG_ID;
    delete process.env.ANURA_CLICK2DIAL_TOKEN;
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "no_configurado" });
    process.env.ANURA_CLICK2DIAL_TOKEN = "tok";
    db.tables.anura_extensions.find((e) => e.id === EXT_ME)!.active = false;
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "sin_anexo" });
    st.user = "";
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false });
  });

  it("sin dominio no se entrega (y la ficha lo dice)", async () => {
    await saveAsAdmin();
    db.tables.anura_sip_settings[0]!.sip_domain = null;
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "sin_dominio" });
    expect((await getAnuraOrderCalls(ORDER)).kaptaPhone).toMatchObject({ status: "sin_dominio", message: expect.stringMatching(/dominio SIP/) });
  });
});

describe("«clave rechazada»", () => {
  it("se marca la versión entregada del anexo propio y corta la entrega hasta guardar otra", async () => {
    await saveAsAdmin();
    const r = await getAnuraPhone(ORDER);
    if (!r.ok) throw new Error(r.error);
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: r.phone.credentialVersion, kind: "clave", status: 401 })).toEqual({ ok: true, marked: true });
    const row = db.tables.anura_sip_credentials[0]!;
    expect(row.rejected_at).toBeTruthy();
    expect(row.rejected_reason).toBe("Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 401).");

    expect(await getAnuraPhone(ORDER)).toEqual({
      ok: false,
      code: "clave_rechazada",
      error: "Anura rechazó la clave del teléfono de Kapta; pide a quien administra que la vuelva a guardar.",
    });
    expect((await getAnuraOrderCalls(ORDER)).kaptaPhone).toMatchObject({ status: "clave_rechazada", rejectedAt: row.rejected_at });

    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    const settings = await getAnuraSettings(STORE);
    expect(settings.ok && settings.data.extensions.find((e) => e.id === EXT_ME)!.phone).toMatchObject({
      status: "clave_rechazada",
      rejectedReason: expect.stringMatching(/401/),
    });

    // Guardar otra clave la limpia.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5_000));
    try {
      await saveAsAdmin(EXT_ME, { password: "otra-clave" });
    } finally {
      vi.useRealTimers();
    }
    const again = await getAnuraPhone(ORDER);
    expect(again).toMatchObject({ ok: true, phone: { password: "otra-clave" } });
  });

  it("un rechazo de una versión vieja no marca la clave nueva", async () => {
    await saveAsAdmin();
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: "2020-01-01T00:00:00.000Z", kind: "clave", status: 403 })).toEqual({ ok: true, marked: false });
    expect(db.tables.anura_sip_credentials[0]!.rejected_at).toBeNull();
  });

  it("un fallo de red no marca nada; otra persona no marca mi anexo", async () => {
    await saveAsAdmin();
    const version = db.tables.anura_sip_credentials[0]!.saved_at;
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: version, kind: "red" })).toEqual({ ok: true, marked: false });
    st.user = OTHER;
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: version, kind: "clave" })).toEqual({ ok: true, marked: false });
    expect(db.tables.anura_sip_credentials[0]!.rejected_at).toBeNull();
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: "no es fecha", kind: "clave" })).toMatchObject({ ok: false });
  });
});

describe("«dominio no reconocido» (SIP 404): se detiene igual, pero se corrige el dominio", () => {
  const admin = () => {
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
  };

  it("un 404 marca «dominio no reconocido», corta la entrega y la ficha pide revisar el dominio", async () => {
    await saveAsAdmin();
    const r = await getAnuraPhone(ORDER);
    if (!r.ok) throw new Error(r.error);
    expect(
      await reportAnuraPhoneRejected(ORDER, { credentialVersion: r.phone.credentialVersion, kind: "dominio", status: 404, domain: r.phone.domain }),
    ).toEqual({ ok: true, marked: true });
    const row = db.tables.anura_sip_credentials[0]!;
    expect(row.rejected_reason).toBe("Anura no reconoce el usuario SIP en el dominio de la central (SIP 404).");
    expect(await getAnuraPhone(ORDER)).toEqual({
      ok: false,
      code: "dominio_no_reconocido",
      error: "Anura no reconoce el usuario o el dominio del teléfono de Kapta; pide a quien administra que revise el dominio de la central en Ajustes › Telefonía Anura.",
    });
    expect((await getAnuraOrderCalls(ORDER)).kaptaPhone).toMatchObject({
      status: "dominio_no_reconocido",
      rejectedAt: row.rejected_at,
      message: expect.stringMatching(/revise el dominio/),
    });
    admin();
    const settings = await getAnuraSettings(STORE);
    expect(settings.ok && settings.data.extensions.find((e) => e.id === EXT_ME)!.phone).toMatchObject({ status: "dominio_no_reconocido", hasPassword: true });
  });

  it("un 404 que llega como «clave» (pestaña vieja) también es de dominio", async () => {
    await saveAsAdmin();
    const version = db.tables.anura_sip_credentials[0]!.saved_at;
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: version, kind: "clave", status: 404 })).toEqual({ ok: true, marked: true });
    expect((await getAnuraPhone(ORDER)) as unknown).toMatchObject({ ok: false, code: "dominio_no_reconocido" });
  });

  it("una marca vieja «clave … (SIP 404).» se lee como dominio no reconocido", async () => {
    await saveAsAdmin();
    Object.assign(db.tables.anura_sip_credentials[0]!, {
      rejected_at: "2026-11-06T09:00:00.000Z",
      rejected_reason: "Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 404).",
    });
    expect((await getAnuraOrderCalls(ORDER)).kaptaPhone.status).toBe("dominio_no_reconocido");
    admin();
    expect(await saveAnuraSipSettings(STORE, { domain: "aurela.anura.pe" })).toMatchObject({ ok: true });
    expect(db.tables.anura_sip_credentials[0]).toMatchObject({
      rejected_reason: "Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 404). Se cambió el dominio: falta probarlo.",
    });
    expect((await getAnuraOrderCalls(ORDER)).kaptaPhone.status).toBe("dominio_no_reconocido");
    await saveAsAdmin(EXT_OTHER, { domain: "aurela.anura.pe" });
    expect(db.tables.anura_sip_credentials.find((c) => c.extension_id === EXT_ME)!.rejected_at).toBeNull();
  });

  it("si la pestaña probó con un dominio que ya no es el de la central, no marca", async () => {
    await saveAsAdmin();
    const version = db.tables.anura_sip_credentials[0]!.saved_at;
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: version, kind: "dominio", status: 404, domain: "kenku-mal.anura.pe" })).toEqual({
      ok: true,
      marked: false,
    });
    expect(db.tables.anura_sip_credentials[0]!.rejected_at).toBeNull();
  });

  it("«Guardar central» con un dominio DISTINTO no libera los 404: esperan que Anura acepte el nuevo en «Probar y guardar»", async () => {
    await saveAsAdmin(EXT_ME);
    await saveAsAdmin(EXT_OTHER);
    const [mine, other] = [EXT_ME, EXT_OTHER].map((id) => db.tables.anura_sip_credentials.find((c) => c.extension_id === id)!);
    Object.assign(mine!, { rejected_at: "2026-11-06T09:00:00.000Z", rejected_reason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404)." });
    Object.assign(other!, { rejected_at: "2026-11-06T09:00:00.000Z", rejected_reason: "Anura rechazó el usuario o la clave del teléfono de Kapta (SIP 401)." });
    admin();
    // El mismo dominio: es la misma combinación, nada cambia.
    expect(await saveAnuraSipSettings(STORE, { domain: "kenku.anura.pe" })).toEqual({ ok: true, notice: "Central de Anura guardada." });
    expect(mine).toMatchObject({ rejected_reason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404)." });
    // Otro dominio: la marca queda esperando la prueba, y el anexo sigue sin llamar.
    const res = await saveAnuraSipSettings(STORE, { domain: "kenku-pe.anura.pe" });
    expect(res).toEqual({
      ok: true,
      notice:
        "Central de Anura guardada. El anexo que Anura no reconocía con el dominio anterior sigue en pausa: prueba el dominio nuevo con «Probar y guardar» en un anexo. " +
        "Cuando Anura lo acepte, se vuelven a probar en su próxima llamada, sin volver a escribir sus claves.",
    });
    expect(mine).toMatchObject({
      rejected_at: "2026-11-06T09:00:00.000Z",
      rejected_reason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404). Se cambió el dominio: falta probarlo.",
    });
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "dominio_no_reconocido" });
    // Guardarlo otra vez no lo vuelve a marcar.
    expect(await saveAnuraSipSettings(STORE, { domain: "kenku-pe2.anura.pe" })).toEqual({ ok: true, notice: "Central de Anura guardada." });
    expect(mine!.rejected_reason).toBe("Anura no reconoce el usuario SIP en el dominio de la central (SIP 404). Se cambió el dominio: falta probarlo.");
    // Anura aceptó el dominio guardado en un «Probar y guardar» de OTRO anexo: el 404 se libera; la clave rechazada (401) no.
    const tested = await saveAsAdmin(EXT_OTHER, { domain: "kenku-pe2.anura.pe" });
    expect(tested).toEqual({
      ok: true,
      notice:
        "Teléfono de Kapta listo para el anexo 102. Anura aceptó el dominio: el otro anexo que no reconocía con el dominio anterior se probará con este en su próxima llamada.",
    });
    expect(mine).toMatchObject({ rejected_at: null, rejected_reason: null });
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: true, phone: { domain: "kenku-pe2.anura.pe" } });
  });

  it("un 404 hecho con el MISMO dominio que Anura acepta en otro anexo sigue marcado (ahí falla el usuario)", async () => {
    await saveAsAdmin(EXT_ME);
    await saveAsAdmin(EXT_OTHER);
    const mine = db.tables.anura_sip_credentials.find((c) => c.extension_id === EXT_ME)!;
    Object.assign(mine, { rejected_at: "2026-11-06T09:00:00.000Z", rejected_reason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404)." });
    const res = await saveAsAdmin(EXT_OTHER);
    expect(res).toEqual({ ok: true, notice: "Teléfono de Kapta listo para el anexo 102." });
    expect(mine.rejected_at).not.toBeNull();
  });

  it("si no se pudo leer la central de antes, «Guardar central» no toca las marcas", async () => {
    await saveAsAdmin(EXT_ME);
    const mine = db.tables.anura_sip_credentials.find((c) => c.extension_id === EXT_ME)!;
    Object.assign(mine, { rejected_at: "2026-11-06T09:00:00.000Z", rejected_reason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404)." });
    admin();
    const real = db.client.from;
    db.client.from = (table: string) => {
      const q = real(table);
      if (table !== "anura_sip_settings") return q;
      // La lectura (select … maybeSingle) falla; la escritura (upsert) sigue.
      q.maybeSingle = () => ({ then: (ok: any) => Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } }).then(ok) });
      return q;
    };
    try {
      expect(await saveAnuraSipSettings(STORE, { domain: "kenku.anura.pe" })).toEqual({ ok: true, notice: "Central de Anura guardada." });
    } finally {
      db.client.from = real;
    }
    expect(mine.rejected_reason).toBe("Anura no reconoce el usuario SIP en el dominio de la central (SIP 404).");
  });

  it("«Probar y guardar» con otro dominio libera todos los demás anexos con 404", async () => {
    await saveAsAdmin(EXT_ME);
    await saveAsAdmin(EXT_OTHER);
    const mine = db.tables.anura_sip_credentials.find((c) => c.extension_id === EXT_ME)!;
    Object.assign(mine, { rejected_at: "2026-11-06T09:00:00.000Z", rejected_reason: "Anura no reconoce el usuario SIP en el dominio de la central (SIP 404)." });
    const res = await saveAsAdmin(EXT_OTHER, { domain: "kenku-pe.anura.pe" });
    expect(res).toMatchObject({ ok: true, notice: expect.stringMatching(/^Teléfono de Kapta listo para el anexo 102\. Anura aceptó el dominio: el otro anexo/) });
    expect(mine.rejected_at).toBeNull();
  });
});

describe("Ajustes: la llamada de prueba con el teléfono de Kapta", () => {
  it("solo con el anexo propio", async () => {
    await saveAsAdmin(EXT_OTHER);
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    expect(await getAnuraTestPhone(STORE, "102")).toMatchObject({ ok: false, code: "permiso", error: expect.stringMatching(/dueña del anexo/) });
    await saveAsAdmin(EXT_ME);
    st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
    expect(await getAnuraTestPhone(STORE, "101")).toMatchObject({ ok: true, phone: { extension: "101" } });
    expect(await getAnuraTestPhone(STORE)).toMatchObject({ ok: true, phone: { extension: "101" } });
    const version = db.tables.anura_sip_credentials.find((c) => c.extension_id === EXT_ME)!.saved_at;
    expect(await reportAnuraTestPhoneRejected(STORE, { credentialVersion: version, kind: "clave", status: 401 })).toEqual({ ok: true, marked: true });
    st.orgPerms = new Map();
    expect(await getAnuraTestPhone(STORE)).toMatchObject({ ok: false, code: "permiso" });
  });
});

describe("la grabación por el mismo origen", () => {
  const CALL = "22222222-2222-4222-8222-222222222222";
  const req = (headers: Record<string, string> = {}) => new Request(`https://kapta.test/api/anura/recordings/${CALL}`, { headers }) as any;
  const ctx = { params: Promise.resolve({ callId: CALL }) };

  beforeEach(() => {
    db.tables.anura_calls.push({
      id: CALL,
      org_id: ORG,
      store_id: STORE,
      order_id: ORDER,
      user_id: OTHER,
      mode: "pedido",
      direction: "out",
      status: "contestada",
      status_rank: 100,
      recording_status: "guardada",
      recording_path: `${ORG}/2026-11/${CALL}.mp3`,
      requested_at: "2026-11-05T15:00:00.000Z",
    });
  });

  it("quien ve la tienda la oye, con Range y solo como audio", async () => {
    fetchMock.mockImplementation(async () =>
      new Response("ID3audio", { status: 206, headers: { "content-type": "text/html", "content-range": "bytes 0-7/100", "content-length": "8" } }),
    );
    const res = await recordingGET(req({ range: "bytes=0-" }), ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-range")).toBe("bytes 0-7/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(await res.text()).toBe("ID3audio");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/storage\.test\/anura-recordings\//);
    expect((init.headers as Record<string, string>).range).toBe("bytes=0-");
  });

  it("un Range raro no se pasa", async () => {
    fetchMock.mockImplementation(async () => new Response("x", { status: 200, headers: { "content-type": "audio/wav" } }));
    const res = await recordingGET(req({ range: "bytes=0-1, 5-6" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({});
  });

  it("sin sesión 401; sin acceso a la tienda, sin grabación o id raro: 404", async () => {
    st.user = "";
    expect((await recordingGET(req(), ctx)).status).toBe(401);
    st.user = ME;
    st.visibleStores = new Set();
    expect((await recordingGET(req(), ctx)).status).toBe(404);
    st.visibleStores = new Set([STORE]);
    db.tables.anura_calls[0]!.recording_status = "vencida";
    expect((await recordingGET(req(), ctx)).status).toBe(404);
    expect((await recordingGET(req(), { params: Promise.resolve({ callId: "../x" }) })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("quien hizo la llamada y ya no ve la tienda no la oye; viéndola, sí", async () => {
    st.user = OTHER;
    st.visibleStores = new Set();
    fetchMock.mockImplementation(async () => new Response("a", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    expect((await recordingGET(req(), ctx)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    st.visibleStores = new Set([STORE]);
    const res = await recordingGET(req(), ctx);
    expect(res.status).toBe(200);
    // Audio con datos de la clienta: el navegador no lo guarda.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
