// «Llamar con Anura»: las líneas compartidas (0313, MOM §8.7 «Líneas
// compartidas»), con la base simulada y la criptografía de verdad.
//   - dos reservas a la vez nunca comparten una línea; primero la que menos se
//     usó, entre las que empatan al azar;
//   - solo se entrega la clave de la línea que reservó ESTA persona (nunca la
//     de otra línea ni una lista de claves), y el Click2Dial va con esa línea;
//   - con todas ocupadas: «Las N líneas de Anura están ocupadas…»;
//   - una reserva que no llegó a pedirse se suelta sola al minuto (o en el acto
//     si el teléfono falla) y no deja hecho en el pedido;
//   - la clave rechazada de una línea marca esa línea y la siguiente llamada
//     toma otra;
//   - el anexo propio sigue igual; permisos: master.edit en la org del pedido
//     y la casilla «Puede llamar con Anura»; Ajustes pide stores.manage.
// Ninguna prueba llama a Anura ni abre conexiones SIP.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/anura-fake-db";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";

const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
const STORE = "5e5e5e5e-1111-4222-8333-444444444444";
const ORDER = "6f6f6f6f-1111-4222-8333-444444444444";
const ME = "7a7a7a7a-1111-4222-8333-444444444444";
const ANA = "8b8b8b8b-1111-4222-8333-444444444444";
const BEA = "8c8c8c8c-1111-4222-8333-444444444444";
const CAT = "8d8d8d8d-1111-4222-8333-444444444444";
const OWNER = "8e8e8e8e-1111-4222-8333-444444444444";
const L201 = "a2010000-1111-4222-8333-444444444444";
const L202 = "a2020000-1111-4222-8333-444444444444";
const L203 = "a2030000-1111-4222-8333-444444444444";
const EXT_OWN = "a1010000-1111-4222-8333-444444444444";
const PASS: Record<string, string> = { "201": "clave-201-sip", "202": "clave-202-sip", "203": "clave-203-sip", "101": "clave-101-sip" };

const st = vi.hoisted(() => ({
  user: "",
  perms: new Set<string>(),
  orgPerms: new Map<string, Set<string>>(),
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

import { getAnuraOrderCalls, getAnuraPhone, releaseAnuraReservation, reportAnuraPhoneRejected, startAnuraCall } from "@/app/dashboard/pedidos/anura-actions";
import {
  addAnuraPoolLine,
  getAnuraSettings,
  getAnuraTestPhone,
  removeAnuraPoolLine,
  saveAnuraExtension,
  setAnuraCaller,
  startAnuraTestCall,
} from "@/app/dashboard/[storeId]/settings/anura-actions";
import { releaseStaleAnuraCalls } from "@/lib/anura/calls";
import { ANURA_STALE_REASON } from "@/lib/anura/events";
import { reserveAnuraLine } from "@/lib/anura/pool-store";
import {
  ANURA_POOL_CHANNELS_QUESTION,
  ANURA_POOL_PANEL_STEPS,
  ANURA_UNDIALED_REASON,
  ANURA_UNDIALED_RESERVATION_MS,
  anuraFreeLinesLabel,
  anuraLinesBusyMessage,
  anuraPoolLineBadge,
  anuraPoolLineStatus,
  orderPoolCandidates,
} from "@/lib/anura/pool";
import { createAnuraPhone, type AnuraPhoneCredentials, type AnuraPhoneDeps } from "@/lib/anura/sip-phone";
import type { AnuraStartResult } from "@/lib/anura/calls";

let db: FakeDb;
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));

const cred = (id: string, ext: string, over: Record<string, unknown> = {}) => ({
  extension_id: id,
  org_id: ORG,
  extension: ext,
  sip_user: `${ext}-websocket`,
  password_cipher: encrypt(PASS[ext]!),
  saved_at: "2026-11-08T10:00:00.000Z",
  rejected_at: null,
  rejected_reason: null,
  ...over,
});

function setup() {
  db = createFakeDb({
    order_master: [{ order_id: ORDER, store_id: STORE, customer_phone: "+51 987 654 321" }],
    stores: [{ id: STORE, org_id: ORG }],
    memberships: [
      { org_id: ORG, user_id: ME, role: "vendedora" },
      { org_id: ORG, user_id: ANA, role: "vendedora" },
      { org_id: ORG, user_id: BEA, role: "vendedora" },
      { org_id: ORG, user_id: CAT, role: "vendedora" },
      { org_id: ORG, user_id: OWNER, role: "owner" },
    ],
    anura_extensions: [
      { id: L201, org_id: ORG, user_id: null, extension: "201", active: true, pool: true },
      { id: L202, org_id: ORG, user_id: null, extension: "202", active: true, pool: true },
      { id: L203, org_id: ORG, user_id: null, extension: "203", active: true, pool: true },
    ],
    anura_sip_settings: [{ org_id: ORG, sip_domain: "kenku.anura.pe", ws_url: "wss://sipwss.anura.pe", sip_port: 55090, updated_at: "2026-11-08T09:00:00.000Z" }],
    anura_sip_credentials: [cred(L201, "201"), cred(L202, "202"), cred(L203, "203")],
    anura_callers: [ME, ANA, BEA, CAT].map((u) => ({ id: `c-${u}`, org_id: ORG, user_id: u, enabled: true })),
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

const live = () => db.tables.anura_calls.filter((r) => r.status_rank < 100);
const asAdmin = () => {
  st.orgPerms = new Map([[ORG, new Set(["stores.manage"])]]);
};

beforeEach(() => {
  process.env.ENCRYPTION_KEY = generateEncryptionKey();
  setup();
  st.user = ME;
  st.perms = new Set(["master.edit"]);
  st.orgPerms = new Map();
  st.masterEditOrgs = new Set([ORG]);
  st.visibleStores = new Set([STORE]);
  process.env.ANURA_CLICK2DIAL_TOKEN = "tok-de-prueba";
  delete process.env.ANURA_ORG_ID;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("las reglas puras", () => {
  it("primero la línea que menos se usó; entre las que empatan, al azar", () => {
    const lines = [{ extension: "201" }, { extension: "202" }, { extension: "203" }];
    const last = new Map([
      ["201", 3_000],
      ["202", 1_000],
    ]);
    // La 203 nunca se usó: va primero. Después la 202 (más vieja) y la 201.
    expect(orderPoolCandidates(lines, last, () => 0.5).map((l) => l.extension)).toEqual(["203", "202", "201"]);
    // Empate (ninguna usada): decide el azar.
    const rolls = [0.9, 0.1, 0.5];
    expect(orderPoolCandidates(lines, new Map(), () => rolls.shift()!).map((l) => l.extension)).toEqual(["202", "203", "201"]);
  });

  it("el aviso de líneas ocupadas y las libres", () => {
    expect(anuraLinesBusyMessage(3)).toBe("Las 3 líneas de Anura están ocupadas. Intenta en un momento.");
    expect(anuraLinesBusyMessage(10)).toBe("Las 10 líneas de Anura están ocupadas. Intenta en un momento.");
    expect(anuraLinesBusyMessage(1)).toBe("La línea de Anura está ocupada. Intenta en un momento.");
    expect(anuraFreeLinesLabel(2, 3)).toBe("2 de 3 líneas libres");
    expect(anuraFreeLinesLabel(1, 1)).toBe("1 de 1 línea libre");
  });

  it("el estado de una línea en Ajustes", () => {
    expect(anuraPoolLineStatus({ active: true, phoneStatus: "listo", live: false })).toBe("libre");
    expect(anuraPoolLineStatus({ active: true, phoneStatus: "listo", live: true })).toBe("en_uso");
    expect(anuraPoolLineStatus({ active: false, phoneStatus: "listo", live: false })).toBe("apagada");
    expect(anuraPoolLineStatus({ active: true, phoneStatus: "sin_telefono", live: false })).toBe("sin_clave");
    expect(anuraPoolLineStatus({ active: true, phoneStatus: "clave_rechazada", live: false })).toBe("clave_rechazada");
    expect(anuraPoolLineStatus({ active: true, phoneStatus: "dominio_no_reconocido", live: false })).toBe("dominio_no_reconocido");
    expect(anuraPoolLineBadge("en_uso", "Ana")).toEqual({ label: "En uso por Ana", tone: "warn" });
    expect(anuraPoolLineBadge("libre", null).label).toBe("Libre");
  });
});

describe("la reserva de una línea", () => {
  it("dos (o cuatro) reservas a la vez nunca comparten una línea", async () => {
    const users = [ME, ANA, BEA, CAT];
    // Mismo azar para todas: todas quieren la misma línea primero y la base decide.
    const results = await Promise.all(
      users.map((userId) =>
        reserveAnuraLine(db.client, { orgId: ORG, userId, mode: "pedido", storeId: STORE, orderId: ORDER, phone: "987654321" }, { random: () => 0.5 }),
      ),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(3);
    const exts = ok.map((r) => (r.ok ? r.phone.extension : ""));
    expect(new Set(exts).size).toBe(3);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, code: "lineas_ocupadas", error: "Las 3 líneas de Anura están ocupadas. Intenta en un momento." },
    ]);
    // En la base: tres reservas vivas, una por línea, sin pedir todavía.
    expect(live().map((r) => r.extension).sort()).toEqual(["201", "202", "203"]);
    expect(live().every((r) => r.reserved_at && r.dialed_at === null && r.status === "solicitada")).toBe(true);
  });

  it("solo entrega la clave de la línea reservada por quien llama, con su reserva", async () => {
    const res = await getAnuraPhone(ORDER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db.tables.anura_calls.find((r) => r.id === res.phone.reservationId)!;
    expect(row).toMatchObject({ user_id: ME, order_id: ORDER, mode: "pedido", extension: res.phone.extension, status: "solicitada" });
    expect(res.phone.password).toBe(PASS[res.phone.extension]);
    expect(res.phone.sipUser).toBe(`${res.phone.extension}-websocket`);
    // Ninguna otra clave viaja.
    const json = JSON.stringify(res);
    for (const [ext, pass] of Object.entries(PASS)) if (ext !== res.phone.extension) expect(json).not.toContain(pass);
  });

  it("con todas las líneas ocupadas lo dice, sin entregar ninguna clave", async () => {
    for (const [i, u] of [ANA, BEA, CAT].entries()) {
      db.tables.anura_calls.push({ id: `live-${i}`, org_id: ORG, user_id: u, mode: "prueba", direction: "out", extension: `20${i + 1}`, status: "en_curso", status_rank: 20, requested_at: new Date().toISOString(), last_event_at: new Date().toISOString() });
    }
    const res = await getAnuraPhone(ORDER);
    expect(res).toEqual({ ok: false, code: "lineas_ocupadas", error: anuraLinesBusyMessage(3) });
    expect(live().filter((r) => r.user_id === ME)).toHaveLength(0);
  });

  it("una línea sin clave, rechazada o apagada no se elige; sin ninguna lista, no hay botón", async () => {
    db.tables.anura_sip_credentials = [cred(L202, "202", { rejected_at: "2026-11-08T10:00:00.000Z", rejected_reason: "Anura rechazó (SIP 401)." })];
    db.tables.anura_extensions.find((e) => e.id === L203)!.active = false;
    const res = await getAnuraPhone(ORDER);
    expect(res).toMatchObject({ ok: false, code: "sin_lineas" });
    const panel = await getAnuraOrderCalls(ORDER);
    expect(panel.enabled).toBe(false);
    expect(panel.pool).toEqual({ total: 0, free: 0 });
  });

  it("la ficha cuenta las libres y sale el botón para quien tiene la casilla", async () => {
    db.tables.anura_calls.push({ id: "live-ana", org_id: ORG, user_id: ANA, mode: "prueba", direction: "out", extension: "201", status: "sonando", status_rank: 10, requested_at: new Date().toISOString(), last_event_at: new Date().toISOString() });
    const panel = await getAnuraOrderCalls(ORDER);
    expect(panel).toMatchObject({ enabled: true, extension: null, pool: { total: 3, free: 2 }, kaptaPhone: { status: "listo" } });
    expect(anuraFreeLinesLabel(panel.pool!.free, panel.pool!.total)).toBe("2 de 3 líneas libres");
  });
});

describe("el Click2Dial va con la reserva, y solo con ella", () => {
  it("pide la llamada con la línea reservada y el id de la reserva en customs", async () => {
    const creds = await getAnuraPhone(ORDER);
    if (!creds.ok) throw new Error("sin reserva");
    const r = await startAnuraCall(ORDER, creds.phone.reservationId);
    expect(r).toMatchObject({ ok: true, callId: creds.phone.reservationId, extension: creds.phone.extension, toMasked: "98••••321" });
    const body = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain(`extension=${creds.phone.extension}`);
    expect(body).toContain(`customs=kapta-${creds.phone.reservationId}`);
    expect(body).toContain("called=987654321");
    const row = db.tables.anura_calls.find((x) => x.id === creds.phone.reservationId)!;
    expect(row.dialed_at).toBeTruthy();
    // Una sola fila: no se eligió otra línea.
    expect(db.tables.anura_calls).toHaveLength(1);
  });

  it("sin reserva, con la de otra persona o con una ya suelta, no llama", async () => {
    expect(await startAnuraCall(ORDER)).toMatchObject({ ok: false, code: "reserva" });
    st.user = ANA;
    const ana = await getAnuraPhone(ORDER);
    if (!ana.ok) throw new Error("sin reserva");
    st.user = ME;
    expect(await startAnuraCall(ORDER, ana.phone.reservationId)).toMatchObject({ ok: false, code: "reserva" });
    st.user = ANA;
    await releaseAnuraReservation(ana.phone.reservationId!);
    expect(await startAnuraCall(ORDER, ana.phone.reservationId)).toMatchObject({ ok: false, code: "reserva" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("si Anura rechaza el Click2Dial, la línea queda libre", async () => {
    fetchMock.mockResolvedValueOnce(new Response("No originate terminal", { status: 400 }));
    const creds = await getAnuraPhone(ORDER);
    if (!creds.ok) throw new Error("sin reserva");
    expect(await startAnuraCall(ORDER, creds.phone.reservationId)).toMatchObject({ ok: false, code: "sin_terminal" });
    expect(live()).toHaveLength(0);
  });
});

describe("la reserva que no llegó a pedirse", () => {
  it("se suelta sola al minuto, sin hecho en el pedido, y la línea vuelve a estar libre", async () => {
    const t0 = new Date("2026-11-08T15:00:00.000Z");
    const res = await reserveAnuraLine(db.client, { orgId: ORG, userId: ME, mode: "pedido", storeId: STORE, orderId: ORDER, phone: "987654321", onlyExtension: "201" }, { now: t0 });
    expect(res.ok).toBe(true);
    expect(await releaseStaleAnuraCalls(db.client, { orgId: ORG }, new Date(t0.getTime() + ANURA_UNDIALED_RESERVATION_MS - 1_000))).toBe(0);
    expect(await releaseStaleAnuraCalls(db.client, { orgId: ORG }, new Date(t0.getTime() + ANURA_UNDIALED_RESERVATION_MS + 1_000))).toBe(1);
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "fallida", failure_reason: ANURA_UNDIALED_REASON, closed_by_timeout: true });
    expect(db.tables.order_events).toHaveLength(0);
    // No sale en la ficha: no fue un intento de contacto.
    const panel = await getAnuraOrderCalls(ORDER);
    expect(panel.calls).toHaveLength(0);
    expect(panel.activeCall).toBeNull();
    // Otra persona ya puede tomar la 201.
    const ana = await reserveAnuraLine(db.client, { orgId: ORG, userId: ANA, mode: "prueba", storeId: null, orderId: null, phone: null, onlyExtension: "201" });
    expect(ana).toMatchObject({ ok: true, phone: { extension: "201" } });
  });

  it("ya pedida, el minuto corre desde el Click2Dial, no desde la reserva", async () => {
    const t0 = new Date("2026-11-08T15:00:00.000Z");
    const res = await reserveAnuraLine(db.client, { orgId: ORG, userId: ME, mode: "pedido", storeId: STORE, orderId: ORDER, phone: "987654321" }, { now: t0 });
    if (!res.ok) throw new Error("sin reserva");
    const row = db.tables.anura_calls[0]!;
    row.dialed_at = new Date(t0.getTime() + 50_000).toISOString();
    expect(await releaseStaleAnuraCalls(db.client, { orgId: ORG }, new Date(t0.getTime() + 70_000))).toBe(0);
    expect(await releaseStaleAnuraCalls(db.client, { orgId: ORG }, new Date(t0.getTime() + 111_000))).toBe(1);
    expect(row).toMatchObject({ status: "fallida", failure_reason: ANURA_STALE_REASON });
  });

  it("el teléfono la suelta en el acto; solo la propia", async () => {
    const res = await getAnuraPhone(ORDER);
    if (!res.ok) throw new Error("sin reserva");
    st.user = ANA;
    expect(await releaseAnuraReservation(res.phone.reservationId!)).toEqual({ ok: true, released: false });
    st.user = ME;
    expect(await releaseAnuraReservation(res.phone.reservationId!)).toEqual({ ok: true, released: true });
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "fallida", failure_reason: ANURA_UNDIALED_REASON });
    expect(live()).toHaveLength(0);
  });

  it("volver a pedir la clave suelta la reserva sin pedir de la misma persona", async () => {
    const first = await getAnuraPhone(ORDER);
    const second = await getAnuraPhone(ORDER);
    expect(first.ok && second.ok).toBe(true);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.id).toBe(second.ok ? second.phone.reservationId : "");
  });
});

describe("clave rechazada en una línea", () => {
  it("marca ESA línea, suelta la reserva y la siguiente llamada toma otra", async () => {
    const res = await reserveAnuraLine(db.client, { orgId: ORG, userId: ME, mode: "pedido", storeId: STORE, orderId: ORDER, phone: "987654321", onlyExtension: "202" });
    if (!res.ok) throw new Error("sin reserva");
    const out = await reportAnuraPhoneRejected(ORDER, { credentialVersion: res.phone.credentialVersion, kind: "clave", status: 401, reservationId: res.phone.reservationId });
    expect(out).toEqual({ ok: true, marked: true });
    const byExt = (e: string) => db.tables.anura_sip_credentials.find((c) => c.extension === e)!;
    expect(byExt("202").rejected_at).toBeTruthy();
    expect(byExt("201").rejected_at).toBeNull();
    expect(byExt("203").rejected_at).toBeNull();
    expect(live()).toHaveLength(0);
    for (let i = 0; i < 4; i++) {
      const next = await getAnuraPhone(ORDER);
      expect(next.ok && next.phone.extension).not.toBe("202");
      if (next.ok) await releaseAnuraReservation(next.phone.reservationId!);
    }
  });

  it("no marca una línea que no reservó quien avisa", async () => {
    st.user = ANA;
    const ana = await getAnuraPhone(ORDER);
    if (!ana.ok) throw new Error("sin reserva");
    st.user = ME;
    expect(await reportAnuraPhoneRejected(ORDER, { credentialVersion: ana.phone.credentialVersion, kind: "clave", status: 401, reservationId: ana.phone.reservationId })).toMatchObject({ ok: false });
    expect(db.tables.anura_sip_credentials.every((c) => c.rejected_at === null)).toBe(true);
  });
});

describe("quién puede llamar", () => {
  it("sin master.edit en la org del pedido, sin clave ni reserva", async () => {
    st.perms = new Set();
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "permiso" });
    st.perms = new Set(["master.edit"]);
    st.masterEditOrgs = new Set();
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "permiso" });
    expect(db.tables.anura_calls).toHaveLength(0);
  });

  it("sin la casilla (o apagada), no hay línea compartida", async () => {
    db.tables.anura_callers = db.tables.anura_callers.map((c) => (c.user_id === ME ? { ...c, enabled: false } : c));
    expect(await getAnuraPhone(ORDER)).toMatchObject({ ok: false, code: "sin_anexo", error: expect.stringMatching(/Puede llamar con Anura/) });
    expect((await getAnuraOrderCalls(ORDER)).enabled).toBe(false);
    expect(db.tables.anura_calls).toHaveLength(0);
  });

  it("el anexo propio sigue igual: su clave, sin reserva, y la llamada con él", async () => {
    db.tables.anura_extensions.push({ id: EXT_OWN, org_id: ORG, user_id: ME, extension: "101", active: true, pool: false });
    db.tables.anura_sip_credentials.push(cred(EXT_OWN, "101"));
    const res = await getAnuraPhone(ORDER);
    expect(res).toMatchObject({ ok: true, phone: { extension: "101", password: PASS["101"] } });
    expect(res.ok && res.phone.reservationId).toBeFalsy();
    expect(db.tables.anura_calls).toHaveLength(0);
    const r = await startAnuraCall(ORDER);
    expect(r).toMatchObject({ ok: true, extension: "101" });
    expect(db.tables.anura_calls[0]).toMatchObject({ extension: "101", reserved_at: null });
    expect(db.tables.anura_calls[0]!.dialed_at).toBeTruthy();
    const panel = await getAnuraOrderCalls(ORDER);
    expect(panel).toMatchObject({ extension: "101", pool: null });
  });

  it("un anexo propio ocupado por otra persona dice que el anexo está en otra llamada", async () => {
    db.tables.anura_extensions.push({ id: EXT_OWN, org_id: ORG, user_id: ME, extension: "101", active: true, pool: false });
    db.tables.anura_calls.push({ id: "otra", org_id: ORG, user_id: ANA, mode: "prueba", direction: "out", extension: "101", status: "sonando", status_rank: 10, requested_at: new Date().toISOString(), last_event_at: new Date().toISOString() });
    expect(await startAnuraCall(ORDER)).toMatchObject({ ok: false, code: "linea_ocupada", error: expect.stringMatching(/anexo 101/) });
  });
});

describe("Ajustes › líneas compartidas y «Puede llamar con Anura»", () => {
  it("solo quien administra; las líneas con su estado y nunca la clave", async () => {
    expect(await addAnuraPoolLine(STORE, "204")).toMatchObject({ ok: false });
    expect(await setAnuraCaller(STORE, ANA, false)).toMatchObject({ ok: false });
    asAdmin();
    expect(await addAnuraPoolLine(STORE, "204")).toMatchObject({ ok: true });
    expect(await addAnuraPoolLine(STORE, "204")).toMatchObject({ ok: false, error: expect.stringMatching(/ya es una línea compartida/) });
    db.tables.anura_calls.push({ id: "live-ana", org_id: ORG, user_id: ANA, mode: "prueba", direction: "out", extension: "201", status: "en_curso", status_rank: 20, requested_at: new Date().toISOString(), last_event_at: new Date().toISOString() });
    db.tables.anura_sip_credentials.find((c) => c.extension === "203")!.rejected_at = "2026-11-08T10:00:00.000Z";
    db.tables.anura_sip_credentials.find((c) => c.extension === "203")!.rejected_reason = "Anura rechazó (SIP 401).";
    const res = await getAnuraSettings(STORE);
    if (!res.ok) throw new Error(res.error);
    const byExt = Object.fromEntries(res.data.poolLines.map((l) => [l.extension, l]));
    expect(byExt["201"]).toMatchObject({ status: "en_uso", inUseBy: `persona-${ANA.slice(0, 4)}` });
    expect(byExt["202"]).toMatchObject({ status: "libre" });
    expect(byExt["203"]).toMatchObject({ status: "clave_rechazada" });
    expect(byExt["204"]).toMatchObject({ status: "sin_clave", phone: { sipUser: "204-websocket", hasPassword: false } });
    expect(res.data.extensions).toHaveLength(0);
    const json = JSON.stringify(res.data);
    for (const pass of Object.values(PASS)) expect(json).not.toContain(pass);
    expect(json).not.toContain("v1:");
    // La línea en uso no se quita.
    expect(await removeAnuraPoolLine(STORE, L201)).toMatchObject({ ok: false, error: expect.stringMatching(/está en una llamada/) });
    expect(await removeAnuraPoolLine(STORE, L202)).toMatchObject({ ok: true });
    expect(db.tables.anura_extensions.some((e) => e.id === L202)).toBe(false);
  });

  it("un número es una línea compartida o el anexo de una persona, no los dos", async () => {
    asAdmin();
    expect(await saveAnuraExtension(STORE, ANA, "201")).toMatchObject({ ok: false, error: expect.stringMatching(/línea compartida/) });
    expect(await saveAnuraExtension(STORE, ANA, "105")).toMatchObject({ ok: true });
    expect(await addAnuraPoolLine(STORE, "105")).toMatchObject({ ok: false, error: expect.stringMatching(/anexo propio/) });
  });

  it("la casilla: solo para quien gestiona pedidos (master.edit)", async () => {
    asAdmin();
    db.tables.memberships.push({ org_id: ORG, user_id: "9f9f9f9f-1111-4222-8333-444444444444", role: "motorizado" });
    expect(await setAnuraCaller(STORE, "9f9f9f9f-1111-4222-8333-444444444444", true)).toMatchObject({ ok: false, error: expect.stringMatching(/master\.edit/) });
    expect(await setAnuraCaller(STORE, ANA, false)).toMatchObject({ ok: true });
    expect(db.tables.anura_callers.find((c) => c.user_id === ANA)!.enabled).toBe(false);
    const res = await getAnuraSettings(STORE);
    if (!res.ok) throw new Error(res.error);
    expect(res.data.callers.find((c) => c.userId === ANA)).toMatchObject({ enabled: false });
    expect(res.data.callers.find((c) => c.userId === ME)).toMatchObject({ enabled: true });
    expect(res.data.callers.some((c) => c.userId === "9f9f9f9f-1111-4222-8333-444444444444")).toBe(false);
  });

  it("la llamada de prueba toma una línea libre (o la elegida) y llama con ella", async () => {
    asAdmin();
    const mine = await getAnuraTestPhone(STORE, null, "912345678");
    if (!mine.ok) throw new Error(mine.error);
    expect(db.tables.anura_calls[0]).toMatchObject({ mode: "prueba", store_id: null, order_id: null, extension: mine.phone.extension });
    const r = await startAnuraTestCall(STORE, "912345678", null, mine.phone.reservationId);
    expect(r).toMatchObject({ ok: true, extension: mine.phone.extension });
    expect(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).toContain(`extension=${mine.phone.extension}`);
    // Una línea elegida; con su dueña ocupada (la misma persona), no otra.
    db.tables.anura_calls[0]!.status = "contestada";
    db.tables.anura_calls[0]!.status_rank = 100;
    const picked = await getAnuraTestPhone(STORE, "203", "912345678");
    expect(picked).toMatchObject({ ok: true, phone: { extension: "203" } });
  });
});

describe("el teléfono de Kapta con una línea compartida", () => {
  const CREDS: AnuraPhoneCredentials = {
    extension: "202",
    sipUser: "202-websocket",
    password: "clave-202-sip",
    domain: "kenku.anura.pe",
    wsUrl: "wss://sipwss.anura.pe",
    port: 55090,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    credentialVersion: "2026-11-08T10:00:00.000Z",
    reservationId: "res-1",
  };

  function phoneWith(over: Partial<AnuraPhoneDeps> = {}) {
    const listeners = new Map<string, ((e: any) => void)[]>();
    const ua = {
      start: vi.fn(),
      stop: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
      isRegistered: () => false,
      on(event: string, fn: (e: any) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
        return ua;
      },
      emit(event: string, e: unknown = {}) {
        for (const fn of listeners.get(event) ?? []) fn(e);
      },
    };
    const deps: AnuraPhoneDeps = {
      createUa: vi.fn(async () => ua),
      getMicrophone: vi.fn(async () => ({ getTracks: () => [] })),
      lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) },
      fetchCredentials: vi.fn(async () => ({ ok: true as const, phone: CREDS })),
      requestCall: vi.fn(async (): Promise<AnuraStartResult> => ({ ok: true, callId: "res-1", extension: "202", toMasked: "98••••321" })),
      reportRejected: vi.fn(async () => ({ ok: true })),
      releaseReservation: vi.fn(async () => ({ ok: true })),
      onChange: () => {},
      onRemoteStream: () => {},
      ...over,
    };
    return { phone: createAnuraPhone(deps), deps, ua };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("registra con la línea reservada y pide el Click2Dial con esa reserva", async () => {
    const h = phoneWith();
    void h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registered");
    await flush();
    expect(h.deps.createUa).toHaveBeenCalledWith(CREDS);
    expect(h.deps.requestCall).toHaveBeenCalledWith({ reservationId: "res-1" });
    h.phone.hangUp();
    // Ya pedida, la reserva es del Click2Dial: no se suelta desde el teléfono.
    expect(h.deps.releaseReservation).not.toHaveBeenCalled();
  });

  it("si el micrófono falla antes del Click2Dial, suelta la línea y no la pide", async () => {
    const h = phoneWith({ getMicrophone: vi.fn(async () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))) });
    const snap = await h.phone.call();
    expect(snap.error?.code).toBe("microfono_denegado");
    expect(h.deps.releaseReservation).toHaveBeenCalledWith("res-1");
    expect(h.deps.requestCall).not.toHaveBeenCalled();
  });

  it("si Anura rechaza la clave, avisa con la reserva y suelta la línea", async () => {
    const h = phoneWith();
    const done = h.phone.call();
    await flush();
    h.ua.emit("connected");
    h.ua.emit("registrationFailed", { cause: "Authentication Error", response: { status_code: 401 } });
    await done;
    expect(h.deps.reportRejected).toHaveBeenCalledWith(expect.objectContaining({ kind: "clave", reservationId: "res-1" }));
    expect(h.deps.releaseReservation).toHaveBeenCalledWith("res-1");
    expect(h.deps.requestCall).not.toHaveBeenCalled();
  });

  it("colgar mientras conecta suelta la línea", async () => {
    const h = phoneWith();
    void h.phone.call();
    await flush();
    h.phone.hangUp();
    expect(h.deps.releaseReservation).toHaveBeenCalledWith("res-1");
  });
});

describe("el MOM y la migración lo dicen", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const MOM = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
  const pool = () => {
    const from = MOM.indexOf("#### Líneas compartidas (08-11-2026)");
    const to = MOM.indexOf(" ## 9. Lima", from);
    expect(from).toBeGreaterThan(MOM.indexOf("### 8.7 Llamar con Anura"));
    expect(to).toBeGreaterThan(from);
    return MOM.slice(from, to);
  };

  it("la regla de asignación, el aviso de ocupadas y la seguridad", () => {
    const POOL = pool();
    expect(POOL).toContain("«¿no puede ser algo dinámico… el anexo asignado aleatoriamente?»");
    expect(POOL).toContain("«Puede llamar con Anura»");
    expect(POOL).toContain("primero la que lleva más tiempo sin usarse y, entre las que empatan, al azar");
    expect(POOL).toContain(`«${anuraLinesBusyMessage(3)}»`);
    expect(POOL).toContain(`«${ANURA_UNDIALED_REASON}»`);
    expect(POOL).toContain("el navegador de quien llama recibe la clave SIP de la línea reservada, y solo durante esa llamada");
    expect(POOL).toContain("`anura_calls_one_active_per_extension`");
    expect(POOL).toContain("Migración 0313.");
    for (const step of ANURA_POOL_PANEL_STEPS) expect(POOL).toContain(step);
    expect(POOL).toContain(ANURA_POOL_CHANNELS_QUESTION);
    const migration = read("db/migrations/0313_anura_line_pool.sql");
    expect(migration).toContain("anura_calls_one_active_per_extension");
    expect(migration).toContain("(pool and user_id is null) or (not pool and user_id is not null)");
    expect(migration).toContain("create table if not exists public.anura_callers");
    expect(read("scripts/verify-db.sh")).toContain("anura_line_pool_smoke.sql");
  });
});
