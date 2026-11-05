// Los avisos de Anura (lib/anura/webhook.ts y app/api/webhooks/anura) contra
// una base en memoria: 401 solo con token malo y 200 para todo lo demás, cada
// aviso en la bitácora (teléfonos enmascarados), la llamada por custom1 y
// luego por callId, idempotencia, el rango que solo sube, las entrantes, el
// hecho en el historial del pedido una sola vez y la grabación copiada a
// Storage después de responder. Sin red: el fetch de la grabación es simulado.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/anura-fake-db";
import { anuraCustoms } from "@/lib/anura/events";
import { anuraWebhookToken } from "@/lib/anura/token";
import { handleAnuraWebhook } from "@/lib/anura/webhook";
import { placeAnuraCall, releaseStaleAnuraCalls } from "@/lib/anura/calls";
import { ANURA_RECORDING_MAX_BYTES, saveAnuraRecording, type RecordingCallRow } from "@/lib/anura/recording";

const KEY = "clave-de-prueba-no-es-la-real";
const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
const STORE = "5e5e5e5e-1111-4222-8333-444444444444";
const ORDER = "6f6f6f6f-1111-4222-8333-444444444444";
const ADVISOR = "7a7a7a7a-1111-4222-8333-444444444444";
const CALL = "3f2b8c1e-1d2a-4c3b-9a8f-0123456789ab";
const TOKEN = anuraWebhookToken(ORG, KEY);
const PHONE = "987654321";

let db: FakeDb;
let deferred: (() => Promise<unknown>)[];
const audio = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } }));

function seedCall(over: Record<string, unknown> = {}) {
  db.tables.anura_calls.push({
    id: CALL,
    org_id: ORG,
    store_id: STORE,
    order_id: ORDER,
    user_id: ADVISOR,
    mode: "pedido",
    direction: "out",
    extension: "101",
    phone: PHONE,
    status: "solicitada",
    status_rank: 0,
    anura_call_id: null,
    anura_status: null,
    bill_seconds: null,
    answer_extension: null,
    was_recorded: null,
    failure_reason: null,
    closed_by_timeout: false,
    recording_status: "sin_grabacion",
    recording_path: null,
    recording_expires_at: null,
    recording_attempts: 0,
    requested_at: "2026-11-05T15:00:00.000Z",
    started_at: null,
    answered_at: null,
    ended_at: null,
    last_event_at: null,
    ...over,
  });
}

function send(body: unknown, opts: { token?: string | null; org?: string | null; now?: Date } = {}) {
  return handleAnuraWebhook(
    {
      org: opts.org === undefined ? ORG : opts.org,
      token: opts.token === undefined ? TOKEN : opts.token,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    {
      admin: db.client,
      key: KEY,
      now: opts.now ?? new Date("2026-11-05T15:00:10.000Z"),
      defer: (work) => deferred.push(work),
      fetchImpl: audio as unknown as typeof fetch,
    },
  );
}

const out = (over: Record<string, unknown>) => ({
  callId: "cdr-77",
  event: "START",
  direction: "OUT",
  status: "",
  calling: "101",
  called: PHONE,
  billSeconds: "0",
  custom1: anuraCustoms(CALL),
  recordingUrl: "",
  ...over,
});

const call = () => db.tables.anura_calls.find((r) => r.id === CALL)!;
const facts = () => (db.tables.order_events ?? []).filter((e) => e.kind === "anura_call");

beforeEach(() => {
  db = createFakeDb({
    anura_calls: [],
    anura_webhook_events: [],
    order_events: [],
    anura_extensions: [{ id: "e1", org_id: ORG, user_id: ADVISOR, extension: "101", active: true }],
  });
  deferred = [];
  audio.mockClear();
});

describe("el token", () => {
  it("token malo, de otra org o ausente: 401 y nada escrito", async () => {
    seedCall();
    for (const opts of [{ token: "x".repeat(32) }, { token: null }, { org: "11111111-2222-4333-8444-555555555555" }, { org: null }]) {
      const r = await send(out({}), opts);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ ok: false, error: "token" });
    }
    expect(db.tables.anura_webhook_events).toHaveLength(0);
    expect(call().status).toBe("solicitada");
  });

  it("también se acepta como Authorization: Bearer", async () => {
    seedCall();
    const r = await handleAnuraWebhook(
      { org: ORG, token: null, authorization: `Bearer ${TOKEN}`, body: JSON.stringify(out({})) },
      { admin: db.client, key: KEY, defer: () => {} },
    );
    expect(r.status).toBe(200);
    expect(call().status).toBe("sonando");
  });

  it("con token bueno, lo que no se entiende es 200 y queda en la bitácora", async () => {
    for (const body of ["no es json", "[]", JSON.stringify({ event: "RECORDING", callId: "x" })]) {
      const r = await send(body);
      expect(r.status).toBe(200);
      expect(r.body.outcome).toBe("ignorado");
    }
    expect(db.tables.anura_webhook_events.map((e) => e.outcome)).toEqual(["ignorado", "ignorado", "ignorado"]);
  });
});

describe("una llamada pedida desde la ficha", () => {
  it("START, TALK y END la mueven; el hecho queda una vez en el historial", async () => {
    seedCall();
    expect((await send(out({ event: "START" }))).body.outcome).toBe("aplicado");
    expect(call()).toMatchObject({ status: "sonando", status_rank: 10, anura_call_id: "cdr-77" });

    // Repetido: no cambia nada.
    expect((await send(out({ event: "START" }))).body.outcome).toBe("repetido");

    // Desde aquí Anura ya no manda custom1: se encuentra por callId.
    expect((await send(out({ event: "TALK", custom1: "" }))).body.outcome).toBe("aplicado");
    expect(call().status).toBe("en_curso");
    expect(call().answered_at).toBeTruthy();

    // Fuera de orden: un START tardío no la retrocede.
    expect((await send(out({ event: "START", custom1: "" }))).body.outcome).toBe("repetido");
    expect(call().status).toBe("en_curso");

    const end = out({ event: "END", status: "ANSWER", billSeconds: "133", wasRecorded: "1", answerExtension: "101" });
    expect((await send(end)).body.outcome).toBe("aplicado");
    expect(call()).toMatchObject({ status: "contestada", status_rank: 100, bill_seconds: 133, anura_status: "ANSWER", was_recorded: true });
    expect(facts()).toHaveLength(1);
    expect(facts()[0]).toMatchObject({
      store_id: STORE,
      order_id: ORDER,
      actor: ADVISOR,
      source: "anura",
      payload: { anura_call_id: CALL, status: "contestada", answered: true, bill_seconds: 133, extension: "101", to: PHONE },
    });
    expect(facts()[0]!.note).toBe("Llamada con Anura al 98••••321 (anexo 101): contestó, 2 min 13 s de conversación.");

    // El END repetido (Anura reintenta) no escribe otro hecho.
    expect((await send(end)).body.outcome).toBe("repetido");
    expect(facts()).toHaveLength(1);
    expect(db.tables.anura_webhook_events).toHaveLength(6);
  });

  it("la bitácora guarda los teléfonos enmascarados", async () => {
    seedCall();
    await send(out({ event: "END", status: "NOANSWER", calling: "51912345678" }));
    const row = db.tables.anura_webhook_events[0]!;
    const text = JSON.stringify({ ...row, recording_url: null });
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain("912345678");
    expect(row.payload.called).toBe("98••••321");
    expect(row).toMatchObject({ org_id: ORG, event: "END", anura_status: "NOANSWER", call_id: CALL, outcome: "aplicado" });
  });

  it("un fallo de Anura queda fallida con el motivo en palabras", async () => {
    seedCall();
    await send(out({ event: "END", status: "CONGESTION" }));
    expect(call().status).toBe("fallida");
    expect(call().failure_reason).toMatch(/restringido/);
    expect(facts()[0]!.note).toMatch(/no se pudo llamar/);
  });

  it("cerrada sola por falta de avisos, el END de verdad todavía cuenta", async () => {
    seedCall({ status: "fallida", status_rank: 100, closed_by_timeout: true, failure_reason: "Anura no llegó a hacer la llamada." });
    expect((await send(out({ event: "START" }))).body.outcome).toBe("repetido");
    await send(out({ event: "END", status: "BUSY" }));
    expect(call()).toMatchObject({ status: "ocupado", closed_by_timeout: false, failure_reason: null });
    expect(facts()).toHaveLength(1);
  });

  it("una prueba de Ajustes no escribe en ningún pedido", async () => {
    seedCall({ mode: "prueba", order_id: null });
    await send(out({ event: "END", status: "ANSWER", billSeconds: "10" }));
    expect(call().status).toBe("contestada");
    expect(facts()).toHaveLength(0);
  });

  it("custom1 de otra org no toca nada", async () => {
    seedCall({ org_id: "99999999-1111-4222-8333-444444444444" });
    const r = await send(out({ event: "START" }));
    expect(r.body.outcome).toBe("ignorado");
    expect(call().status).toBe("solicitada");
  });
});

describe("la grabación", () => {
  it("al llegar el END se copia a Storage después de responder", async () => {
    seedCall();
    await send(out({ event: "END", status: "ANSWER", billSeconds: "20", recordingUrl: "https://audio.anura.pe/rec.mp3?sig=1" }));
    expect(call().recording_status).toBe("pendiente");
    expect(call().recording_expires_at).toBe("2026-11-05T15:30:10.000Z");
    // El enlace vive solo en la bitácora del servidor, no en la llamada.
    expect(JSON.stringify(call())).not.toContain("audio.anura.pe");
    expect(db.tables.anura_webhook_events[0]!.recording_url).toBe("https://audio.anura.pe/rec.mp3?sig=1");
    expect(audio).not.toHaveBeenCalled();

    for (const work of deferred) await work();
    expect(audio).toHaveBeenCalledWith("https://audio.anura.pe/rec.mp3?sig=1", expect.objectContaining({ method: "GET" }));
    expect(db.uploads).toEqual([{ bucket: "anura-recordings", path: `${ORG}/2026-11/${CALL}.mp3`, bytes: 4, contentType: "audio/mpeg" }]);
    expect(call()).toMatchObject({ recording_status: "guardada", recording_path: `${ORG}/2026-11/${CALL}.mp3` });
  });

  it("si la copia falla queda pendiente para reintentar", async () => {
    seedCall();
    audio.mockImplementationOnce(async () => new Response("no", { status: 503 }));
    await send(out({ event: "END", status: "ANSWER", billSeconds: "20", recordingUrl: "https://audio.anura.pe/rec.mp3" }));
    for (const work of deferred) await work();
    expect(call()).toMatchObject({ recording_status: "pendiente", recording_attempts: 1 });
    expect(call().recording_error).toMatch(/HTTP 503/);
  });
});

describe("la grabación: solo de Anura y con tope", () => {
  const recordingRow = (over: Record<string, unknown> = {}): RecordingCallRow => ({
    id: CALL,
    org_id: ORG,
    requested_at: "2026-11-05T15:00:00.000Z",
    recording_status: "pendiente",
    recording_expires_at: "2026-11-05T15:30:10.000Z",
    recording_attempts: 0,
    ...over,
  });
  const NOW = new Date("2026-11-05T15:00:20.000Z");

  it("un enlace de otro host no se baja y la bitácora lo dice", async () => {
    seedCall();
    await send(out({ event: "END", status: "ANSWER", billSeconds: "20", recordingUrl: "https://169.254.169.254/latest/meta-data" }));
    for (const work of deferred) await work();
    expect(audio).not.toHaveBeenCalled();
    expect(call().recording_status).toBe("sin_grabacion");
    expect(call().status).toBe("contestada");
    expect(facts()).toHaveLength(1);
    const log = db.tables.anura_webhook_events[0]!;
    expect(log.recording_url).toBeNull();
    expect(log.detail).toContain("Grabación descartada: el enlace no es de Anura (169.254.169.254).");
  });

  it("una redirección a otro host se corta; a un host de Anura se sigue", async () => {
    seedCall({ recording_status: "pendiente", recording_expires_at: "2026-11-05T15:30:10.000Z" });
    const redirectTo = (location: string) => vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    const away = redirectTo("https://internal.example/secret");
    expect(await saveAnuraRecording(db.client, recordingRow(), "https://audio.anura.pe/r.mp3", { fetchImpl: away as unknown as typeof fetch, now: NOW, extraHosts: [] })).toBe("pendiente");
    expect(away).toHaveBeenCalledTimes(1);
    expect(away).toHaveBeenCalledWith("https://audio.anura.pe/r.mp3", expect.objectContaining({ redirect: "manual" }));
    expect(call().recording_error).toContain("no es de Anura (internal.example)");
    expect(db.uploads).toHaveLength(0);

    let hop = 0;
    const along = vi.fn(async () =>
      hop++ === 0
        ? new Response(null, { status: 302, headers: { location: "https://cdn.anura.com.pe/r.mp3" } })
        : new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    );
    expect(
      await saveAnuraRecording(db.client, recordingRow({ recording_attempts: 1 }), "https://audio.anura.pe/r.mp3", {
        fetchImpl: along as unknown as typeof fetch,
        now: NOW,
        extraHosts: [],
      }),
    ).toBe("guardada");
    expect(along).toHaveBeenLastCalledWith("https://cdn.anura.com.pe/r.mp3", expect.objectContaining({ redirect: "manual" }));
    expect(db.uploads).toHaveLength(1);
  });

  it("sin Content-Length, corta la descarga al pasar el tope", async () => {
    seedCall({ recording_status: "pendiente", recording_expires_at: "2026-11-05T15:30:10.000Z" });
    let pulled = 0;
    const chunk = new Uint8Array(ANURA_RECORDING_MAX_BYTES / 4 + 1);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const big = vi.fn(async () => new Response(endless, { status: 200 }));
    expect(await saveAnuraRecording(db.client, recordingRow(), "https://audio.anura.pe/r.mp3", { fetchImpl: big as unknown as typeof fetch, now: NOW })).toBe("pendiente");
    expect(pulled).toBeLessThanOrEqual(5);
    expect(call().recording_error).toMatch(/demasiado grande/);
    expect(db.uploads).toHaveLength(0);
  });

  it("al sexto intento fallido queda vencida y se borra el enlace de la bitácora", async () => {
    seedCall({ recording_status: "pendiente", recording_expires_at: "2026-11-05T15:30:10.000Z", recording_attempts: 5 });
    db.tables.anura_webhook_events.push({ id: "ev1", org_id: ORG, call_id: CALL, outcome: "aplicado", recording_url: "https://audio.anura.pe/r.mp3", received_at: NOW.toISOString() });
    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(
      await saveAnuraRecording(db.client, recordingRow({ recording_attempts: 5 }), "https://audio.anura.pe/r.mp3", {
        fetchImpl: down as unknown as typeof fetch,
        now: NOW,
      }),
    ).toBe("vencida");
    expect(call()).toMatchObject({ recording_status: "vencida", recording_attempts: 6 });
    expect(call().recording_error).toMatch(/6 intentos/);
    expect(db.tables.anura_webhook_events[0]!.recording_url).toBeNull();
  });

  it("guardada, el enlace temporal sale de la bitácora", async () => {
    seedCall();
    await send(out({ event: "END", status: "ANSWER", billSeconds: "20", recordingUrl: "https://audio.anura.pe/rec.mp3?sig=1" }));
    for (const work of deferred) await work();
    expect(call().recording_status).toBe("guardada");
    expect(db.tables.anura_webhook_events.every((e) => e.recording_url === null)).toBe(true);
  });
});

describe("Click2Dial sin respuesta: la llamada sigue y sus avisos cuentan", () => {
  it("una petición que venció por tiempo, seguida de START y END, deja un solo hecho enmascarado", async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const placed = await placeAnuraCall(
      db.client,
      { orgId: ORG, storeId: STORE, orderId: ORDER, userId: ADVISOR, mode: "pedido", extension: "101", phone: PHONE, token: "tok" },
      { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 5, now: new Date("2026-11-05T15:00:00.000Z") },
    );
    expect(placed).toMatchObject({ ok: false, code: "tiempo" });
    const id = (placed as { activeCallId?: string }).activeCallId!;
    expect(id).toBeTruthy();
    const row = () => db.tables.anura_calls.find((r) => r.id === id)!;
    // No se cerró: sigue «solicitada» y no deja pedir otra encima.
    expect(row()).toMatchObject({ status: "solicitada", status_rank: 0 });
    const again = await placeAnuraCall(
      db.client,
      { orgId: ORG, storeId: STORE, orderId: ORDER, userId: ADVISOR, mode: "pedido", extension: "101", phone: PHONE, token: "tok" },
      { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 5, now: new Date("2026-11-05T15:00:05.000Z") },
    );
    expect(again).toMatchObject({ ok: false, code: "ocupada", activeCallId: id });
    expect(hang).toHaveBeenCalledTimes(1);

    await send(out({ custom1: anuraCustoms(id), event: "START" }));
    await send(out({ custom1: anuraCustoms(id), event: "END", status: "ANSWER", billSeconds: "30" }));
    expect(row()).toMatchObject({ status: "contestada", closed_by_timeout: false });
    expect(facts()).toHaveLength(1);
    expect(facts()[0]!.note).toContain("98••••321");
    expect(facts()[0]!.note).not.toContain(PHONE);
  });

  it("cerrada al minuto sin avisos, un END tardío todavía entra al historial", async () => {
    const hang = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const placed = await placeAnuraCall(
      db.client,
      { orgId: ORG, storeId: STORE, orderId: ORDER, userId: ADVISOR, mode: "pedido", extension: "101", phone: PHONE, token: "tok" },
      { fetchImpl: hang as unknown as typeof fetch, now: new Date("2026-11-05T15:00:00.000Z") },
    );
    expect(placed).toMatchObject({ ok: false, code: "red" });
    const id = (placed as { activeCallId?: string }).activeCallId!;
    expect(await releaseStaleAnuraCalls(db.client, { callId: id }, new Date("2026-11-05T15:01:30.000Z"))).toBe(1);
    const row = () => db.tables.anura_calls.find((r) => r.id === id)!;
    expect(row()).toMatchObject({ status: "fallida", closed_by_timeout: true });
    expect(facts()).toHaveLength(0);
    await send(out({ custom1: anuraCustoms(id), event: "END", status: "NOANSWER" }));
    expect(row()).toMatchObject({ status: "no_contestada", closed_by_timeout: false });
    expect(facts()).toHaveLength(1);
  });

  it("un rechazo de verdad sí cierra la fila en el acto", async () => {
    const reject = vi.fn(async () => new Response("Invalid secretId", { status: 401 }));
    const placed = await placeAnuraCall(
      db.client,
      { orgId: ORG, storeId: STORE, orderId: ORDER, userId: ADVISOR, mode: "pedido", extension: "101", phone: PHONE, token: "tok" },
      { fetchImpl: reject as unknown as typeof fetch },
    );
    expect(placed).toMatchObject({ ok: false, code: "token" });
    expect((placed as { activeCallId?: string }).activeCallId).toBeUndefined();
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "fallida", closed_by_timeout: false });
  });
});

describe("lo que no se pidió desde Kapta", () => {
  it("una saliente desconocida se ignora", async () => {
    const r = await send(out({ custom1: "", callId: "cdr-desconocida" }));
    expect(r).toEqual({ status: 200, body: { ok: true, outcome: "ignorado" } });
    expect(db.tables.anura_calls).toHaveLength(0);
    expect(db.tables.anura_webhook_events[0]!.detail).toMatch(/no se pidió desde Kapta/);
  });

  it("una entrante se registra como hecho informativo, sin pedido", async () => {
    const inbound = (over: Record<string, unknown>) => ({
      callId: "cdr-in-1",
      event: "START",
      direction: "IN",
      calling: "51912345678",
      called: "014445566",
      custom1: "",
      ...over,
    });
    await send(inbound({}));
    expect(db.tables.anura_calls).toHaveLength(1);
    expect(db.tables.anura_calls[0]).toMatchObject({ mode: "entrante", direction: "in", status: "sonando", order_id: null, store_id: null });
    await send(inbound({ event: "END", status: "ANSWER", billSeconds: "40", answerExtension: "101" }));
    expect(db.tables.anura_calls).toHaveLength(1);
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "contestada", user_id: ADVISOR });
    expect(facts()).toHaveLength(0);
    // Nadie la pidió ni la ve: el número de quien llamó queda enmascarado.
    expect(db.tables.anura_calls[0]!.phone).toBe("51••••••678");
    expect(JSON.stringify(db.tables.anura_calls)).not.toContain("912345678");
  });

  it("entrante que contestó el mensaje de Anura: perdida", async () => {
    await send({ callId: "cdr-in-2", event: "END", direction: "IN", status: "ANSWER", billSeconds: "15", answerExtension: "", calling: "51912345678" });
    expect(db.tables.anura_calls[0]).toMatchObject({ mode: "entrante", status: "perdida" });
  });
});

describe("la ruta", () => {
  it("responde 401 al token malo y 200 al resto, con la base simulada", async () => {
    vi.resetModules();
    process.env.ENCRYPTION_KEY = KEY;
    vi.doMock("@/lib/db", () => ({ createAdminSupabase: () => db.client }));
    vi.doMock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));
    const { POST } = await import("@/app/api/webhooks/anura/route");
    const { NextRequest } = await import("next/server");
    seedCall();
    const bad = await POST(
      new NextRequest(`https://kapta.test/api/webhooks/anura?org=${ORG}&t=${"0".repeat(32)}`, { method: "POST", body: JSON.stringify(out({})) }),
    );
    expect(bad.status).toBe(401);
    const good = await POST(
      new NextRequest(`https://kapta.test/api/webhooks/anura?org=${ORG}&t=${TOKEN}`, { method: "POST", body: JSON.stringify(out({})) }),
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, outcome: "aplicado" });
    const junk = await POST(new NextRequest(`https://kapta.test/api/webhooks/anura?org=${ORG}&t=${TOKEN}`, { method: "POST", body: "{" }));
    expect(junk.status).toBe(200);
    expect(call().status).toBe("sonando");
    vi.doUnmock("@/lib/db");
    vi.doUnmock("next/server");
  });
});
