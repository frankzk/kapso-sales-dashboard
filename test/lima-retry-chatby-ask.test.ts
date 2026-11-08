// «Pedir la ubicación por WhatsApp» de los reintentos Aliclik de Lima (MOM
// §9.5; owner, 08-11-2026; 0323). La regla pura (`retryAskDecision`, el texto)
// y el servidor (`askRetryLocation`): la marca antes de mandar, una vez por
// episodio, Simulación que no manda, y el hecho en la Actividad.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  conversation: null as Row | null,
  reads: [] as Row[],
  sends: [] as Row[],
  sendResult: { status: "ok", paused: true } as Row,
  forgotten: [] as unknown[],
  recomputed: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/chatby-api", () => ({
  fetchChatbyConversation: async (input: Row) => {
    h.reads.push(input);
    return h.conversation;
  },
  sendChatbyReply: async (input: Row) => {
    h.sends.push(input);
    return h.sendResult;
  },
  forgetChatbyConversation: (phone: unknown) => h.forgotten.push(phone),
}));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: async (_admin: unknown, ids: unknown[]) => h.recomputed.push(...ids) }));

import {
  RETRY_ASK_PURPOSE,
  isRetryAskEvent,
  retryAskDecision,
  retryAskMessage,
  retryAskModeFrom,
} from "@/lib/lima-retry-chatby-ask";
import { askRetryLocation } from "@/lib/lima-retry-chatby-ask-server";

const NOW = new Date("2026-11-08T15:00:00Z");
const EPISODE = "2026-11-06T17:00:00Z";
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const customer = (at: string, text = "hola") => ({ kind: "cliente" as const, at, text });
const team = (at: string, text = "te escribo") => ({ kind: "equipo" as const, at, text });

describe("el texto", () => {
  it("con su nombre y el pedido; sin ellos, igual de claro", () => {
    expect(retryAskMessage({ customerName: "ana maría pérez", orderName: "#KP2041" })).toBe(
      "Hola Ana 😊 Para volver a enviarte tu pedido #KP2041, ¿nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual)",
    );
    expect(retryAskMessage({})).toBe(
      "Hola 😊 Para volver a enviarte tu pedido, ¿nos compartes tu ubicación actual de WhatsApp? (📎 → Ubicación → Enviar tu ubicación actual)",
    );
  });
  it("la posición: sin la columna o con un valor raro, Apagado", () => {
    expect(retryAskModeFrom(undefined)).toBe("apagado");
    expect(retryAskModeFrom("otra")).toBe("apagado");
    expect(retryAskModeFrom("activo")).toBe("activo");
  });
});

describe("¿toca mandarlo? (`retryAskDecision`)", () => {
  const base = { mode: "activo" as const, episodeStart: EPISODE, messages: [customer(hoursAgo(2))], events: [], now: NOW };

  it("con la ventana abierta, sin pedida ni equipo: sí; en Simulación, simulado", () => {
    expect(retryAskDecision(base)).toEqual({ send: true, simulate: false });
    expect(retryAskDecision({ ...base, mode: "simulacion" })).toEqual({ send: true, simulate: true });
    expect(retryAskDecision({ ...base, mode: "apagado" })).toEqual({ send: false, skip: "apagado" });
  });

  it("la ventana: el último mensaje de ella con menos de 23 h", () => {
    expect(retryAskDecision({ ...base, messages: [customer(hoursAgo(22.9))] })).toMatchObject({ send: true });
    expect(retryAskDecision({ ...base, messages: [customer(hoursAgo(23.1))] })).toEqual({ send: false, skip: "ventana_cerrada" });
    expect(retryAskDecision({ ...base, messages: [] })).toEqual({ send: false, skip: "ventana_cerrada" });
  });

  it("una vez por episodio: una pedida de antes del fallo no cuenta", () => {
    const ours = { actor: null, note: "x", payload: { auto: true, purpose: RETRY_ASK_PURPOSE }, occurred_at: "2026-11-07T15:00:00Z" };
    expect(isRetryAskEvent(ours)).toBe(true);
    expect(retryAskDecision({ ...base, events: [ours] })).toEqual({ send: false, skip: "ya_pedida" });
    expect(retryAskDecision({ ...base, events: [{ ...ours, occurred_at: "2026-11-01T15:00:00Z" }] })).toMatchObject({ send: true });
    // Sin fecha no se sabe de cuándo es: ante la duda, no se escribe.
    expect(retryAskDecision({ ...base, events: [{ ...ours, occurred_at: null }] })).toEqual({ send: false, skip: "ya_pedida" });
    // La pedida de la confirmación (otro propósito) no es esta.
    expect(isRetryAskEvent({ ...ours, payload: { auto: true, purpose: "pedir_ubicacion" } })).toBe(false);
  });

  it("no si alguien del equipo le escribió desde la ficha en este episodio", () => {
    const fromFicha = { actor: "user-1", note: "hola", payload: {}, occurred_at: "2026-11-07T15:00:00Z" };
    expect(retryAskDecision({ ...base, events: [fromFicha] })).toEqual({ send: false, skip: "asesora_escribio" });
    expect(retryAskDecision({ ...base, events: [{ ...fromFicha, occurred_at: "2026-11-01T15:00:00Z" }] })).toMatchObject({ send: true });
  });

  it("no si alguien del equipo le escribió en Chatby después de su último mensaje (salvo un mensaje de Kapta)", () => {
    expect(retryAskDecision({ ...base, messages: [customer(hoursAgo(3)), team(hoursAgo(1))] })).toEqual({ send: false, skip: "equipo_atendiendo" });
    expect(retryAskDecision({ ...base, messages: [team(hoursAgo(5)), customer(hoursAgo(3))] })).toMatchObject({ send: true });
    const kapta = { actor: null, note: "Hola 😊 confirma", payload: { auto: true, purpose: "pedir_ubicacion" }, occurred_at: "2026-11-01T15:00:00Z" };
    expect(retryAskDecision({ ...base, messages: [customer(hoursAgo(3)), team(hoursAgo(1), "Hola 😊 confirma")], events: [kapta] })).toMatchObject({ send: true });
  });
});

// ---------------------------------------------------------------------------
// El servidor
// ---------------------------------------------------------------------------

function fakeAdmin(init: { events?: Row[]; asks?: Row[]; insertError?: Row | null; eventsError?: Row | null } = {}) {
  const db = { order_events: [...(init.events ?? [])], lima_retry_chatby_asks: [...(init.asks ?? [])] } as Record<string, Row[]>;
  let nextId = 1;
  const admin = {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      let pending: null | { kind: "insert"; row: Row } | { kind: "update"; patch: Row } | { kind: "delete" } = null;
      const run = () => {
        if (pending?.kind === "insert") {
          const incoming = pending.row;
          if (table === "lima_retry_chatby_asks") {
            if (init.insertError) return { data: null, error: init.insertError };
            if (db[table]!.some((r) => r.order_id === incoming.order_id && r.episode_at === incoming.episode_at)) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
          }
          const row = { id: nextId++, ...incoming };
          (db[table] ??= []).push(row);
          return { data: row, error: null };
        }
        if (pending?.kind === "update") {
          for (const r of db[table] ?? []) if (filters.every((f) => f(r))) Object.assign(r, pending.patch);
          return { data: null, error: null };
        }
        if (pending?.kind === "delete") {
          db[table] = (db[table] ?? []).filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }
        if (table === "order_events" && init.eventsError) return { data: null, error: init.eventsError };
        return { data: (db[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
      };
      const q: Row = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        insert: (row: Row) => { pending = { kind: "insert", row }; return q; },
        update: (patch: Row) => { pending = { kind: "update", patch }; return q; },
        delete: () => { pending = { kind: "delete" }; return q; },
        maybeSingle: async () => run(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return q;
    },
  };
  return { admin: admin as never, db };
}

const ROW = { order_id: "o1", store_id: "s1", order_name: "#KP2041", customer_name: "Ana Pérez", customer_phone: "987654321" };
const INPUT = { orgId: "org", row: ROW, episodeAt: EPISODE, attempt: 2, of: 3, mode: "activo" as const, apiKey: "ck", dry: false, now: NOW };

beforeEach(() => {
  h.conversation = { status: "ok", userNs: "u1", name: "Ana", inboxUrl: "x", messages: [customer(hoursAgo(2))] };
  h.reads = [];
  h.sends = [];
  h.sendResult = { status: "ok", paused: true };
  h.forgotten = [];
  h.recomputed = [];
});

describe("`askRetryLocation`", () => {
  it("Activo: pone la marca, manda el texto con el bot en pausa y deja el hecho; la segunda vez no repite", async () => {
    const { admin, db } = fakeAdmin();
    expect(await askRetryLocation(admin, INPUT)).toEqual({ outcome: "pedida", detail: "Kapta le pidió su ubicación por WhatsApp." });
    expect(h.sends).toEqual([{ userNs: "u1", text: retryAskMessage({ customerName: "Ana Pérez", orderName: "#KP2041" }), apiKey: "ck", pauseMinutes: 60, fetchImpl: undefined }]);
    expect(h.forgotten).toEqual(["987654321"]);
    expect(db.lima_retry_chatby_asks).toEqual([expect.objectContaining({ org_id: "org", store_id: "s1", order_id: "o1", episode_at: EPISODE, status: "enviado" })]);
    expect(db.order_events).toEqual([expect.objectContaining({
      order_id: "o1", kind: "chatby_message", actor: null, source: "chatby", note: h.sends[0]!.text,
      payload: { auto: true, purpose: RETRY_ASK_PURPOSE, attempt: 2, of: 3, episode_at: EPISODE, paused_minutes: 60 },
    })]);
    expect(h.recomputed).toEqual(["o1"]);
    // La pasada siguiente: el hecho dice que ya se pidió.
    expect(await askRetryLocation(admin, INPUT)).toEqual({ outcome: "omitida", detail: "No se le pidió la ubicación por WhatsApp: ya se le pidió en este reintento." });
    expect(h.sends).toHaveLength(1);
  });

  it("la marca es el candado: si ya está (otra pasada a la vez, o el hecho no se escribió), no se manda", async () => {
    const { admin } = fakeAdmin({ asks: [{ order_id: "o1", episode_at: EPISODE, status: "enviado" }] });
    expect(await askRetryLocation(admin, INPUT)).toMatchObject({ outcome: "omitida", detail: expect.stringContaining("ya se le pidió") });
    expect(h.sends).toEqual([]);
  });

  it("si Chatby no deja mandarlo, borra la marca y lo dice: la pasada siguiente lo vuelve a intentar", async () => {
    h.sendResult = { status: "error", message: "Chatby no respondió" };
    const { admin, db } = fakeAdmin();
    expect(await askRetryLocation(admin, INPUT)).toEqual({ outcome: "error", detail: "No se le pidió la ubicación por WhatsApp: Chatby no respondió." });
    expect(db.lima_retry_chatby_asks).toEqual([]);
    expect(db.order_events).toEqual([]);
  });

  it("Simulación o la vista previa: lee y decide, pero no pone marca ni manda", async () => {
    const { admin, db } = fakeAdmin();
    expect(await askRetryLocation(admin, { ...INPUT, mode: "simulacion" })).toEqual({ outcome: "simulada", detail: "Habría pedido su ubicación por WhatsApp." });
    expect(await askRetryLocation(admin, { ...INPUT, dry: true })).toEqual({ outcome: "simulada", detail: "Habría pedido su ubicación por WhatsApp." });
    expect(h.sends).toEqual([]);
    expect(db.lima_retry_chatby_asks).toEqual([]);
    expect(db.order_events).toEqual([]);
  });

  it("Apagado: null y nada que leer", async () => {
    expect(await askRetryLocation(fakeAdmin().admin, { ...INPUT, mode: "apagado" })).toBeNull();
    expect(h.reads).toEqual([]);
  });

  it("dice por qué no: sin clave, sin conversación, ventana cerrada, sin la 0323 o la Actividad que no se pudo leer", async () => {
    expect((await askRetryLocation(fakeAdmin().admin, { ...INPUT, apiKey: "" }))!.detail).toContain("CHATBY_API_KEY");
    h.conversation = { status: "sin_conversacion" };
    expect((await askRetryLocation(fakeAdmin().admin, INPUT))!.detail).toContain("Chatby no tiene su conversación");
    h.conversation = { status: "ok", userNs: "u1", name: "Ana", inboxUrl: "x", messages: [customer(hoursAgo(30))] };
    expect((await askRetryLocation(fakeAdmin().admin, INPUT))!.detail).toContain("la ventana de 24 h de WhatsApp está cerrada");
    h.conversation = { status: "ok", userNs: "u1", name: "Ana", inboxUrl: "x", messages: [customer(hoursAgo(2))] };
    expect((await askRetryLocation(fakeAdmin({ insertError: { code: "42P01", message: "relation does not exist" } }).admin, INPUT))!.detail).toContain("0323");
    expect(await askRetryLocation(fakeAdmin({ eventsError: { message: "x" } }).admin, INPUT)).toMatchObject({ outcome: "error" });
    expect(h.sends).toEqual([]);
  });

  it("nunca lanza", async () => {
    const broken = { from: () => { throw new Error("sin base"); } } as never;
    expect(await askRetryLocation(broken, INPUT)).toEqual({ outcome: "error", detail: "No se le pidió la ubicación por WhatsApp: sin base." });
  });
});
