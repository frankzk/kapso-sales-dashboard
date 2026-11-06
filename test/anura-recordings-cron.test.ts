// El cron de «Llamar con Anura» (MOM §8.7, «El cron de Anura», 06-11-2026):
// la ruta /api/cron/anura-recordings (autorización por CRON_SECRET, solo
// producción, log sin teléfonos), la pasada de lib/anura/maintenance.ts con la
// base simulada (suelta llamadas colgadas, marca «vencida», reintenta copias
// de pruebas y entrantes, poda la bitácora; idempotente, acotada por lote y
// por tiempo), su lugar en vercel.json, y DEPLOY.md.
// Ninguna prueba llama a Anura: la descarga es un fetch simulado.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/anura-fake-db";
import type { AnuraMaintenanceReport } from "@/lib/anura/maintenance";

const mocks = vi.hoisted(() => ({
  admin: null as unknown,
  report: null as unknown,
  throws: null as unknown,
  real: false,
}));

vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => mocks.admin) }));
vi.mock("@/lib/anura/maintenance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/anura/maintenance")>();
  return {
    ...actual,
    runAnuraMaintenance: vi.fn(async (...args: Parameters<typeof actual.runAnuraMaintenance>) => {
      if (mocks.real) return actual.runAnuraMaintenance(...args);
      if (mocks.throws) throw mocks.throws;
      return mocks.report;
    }),
  };
});

const route = await import("@/app/api/cron/anura-recordings/route");
const maintenance = await import("@/lib/anura/maintenance");
const {
  ANURA_MAINTENANCE_COPY_BUDGET_MS,
  ANURA_MAINTENANCE_COPY_LIMIT,
  ANURA_MAINTENANCE_MAX_DURATION_S,
  ANURA_RECORDING_ATTEMPTS_ERROR,
  runAnuraMaintenance,
} = maintenance;
const { ANURA_RECORDING_EXPIRED_ERROR, ANURA_RECORDING_FETCH_TIMEOUT_MS } = await import("@/lib/anura/recording");
const { ANURA_STALE_REASON, ANURA_STUCK_REASON } = await import("@/lib/anura/events");

const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
const U1 = "7a7a7a7a-1111-4222-8333-444444444444";
const U2 = "8b8b8b8b-1111-4222-8333-444444444444";
const PHONE = "987654321";
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const url = (id: string) => `https://grabaciones.anura.pe/audio/${id}.mp3`;

const id = (n: number) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, "0")}`;
const C = { stuckReq: id(1), stuckLive: id(2), entrante: id(3), vencida: id(4), sinIntentos: id(5), recien: id(6), sinFecha: id(7), guardada: id(8) };

function call(over: Record<string, unknown>) {
  return {
    org_id: ORG,
    store_id: null,
    order_id: null,
    user_id: null,
    mode: "prueba",
    direction: "out",
    phone: PHONE,
    status: "contestada",
    status_rank: 100,
    recording_status: "sin_grabacion",
    recording_attempts: 0,
    recording_path: null,
    recording_expires_at: null,
    requested_at: iso(NOW - 15 * MIN),
    last_event_at: iso(NOW - 10 * MIN),
    closed_by_timeout: false,
    ...over,
  };
}

function event(over: Record<string, unknown>) {
  return { org_id: ORG, received_at: iso(NOW - 10 * MIN), event: "END", outcome: "aplicado", payload: { called: "98••••321" }, recording_url: null, call_id: null, ...over };
}

function seed(): FakeDb {
  return createFakeDb({
    anura_calls: [
      call({ id: C.stuckReq, user_id: U1, status: "solicitada", status_rank: 0, requested_at: iso(NOW - 5 * MIN), last_event_at: null }),
      call({ id: C.stuckLive, user_id: U2, mode: "pedido", store_id: "s", order_id: "o", status: "en_curso", status_rank: 20, last_event_at: iso(NOW - 3 * 60 * MIN) }),
      // Una entrante: no tiene ficha. El END llegó hace 10 minutos.
      call({ id: C.entrante, mode: "entrante", direction: "in", phone: "98••••321", recording_status: "pendiente", recording_attempts: 1, recording_expires_at: iso(NOW + 20 * MIN) }),
      call({ id: C.vencida, recording_status: "pendiente", recording_attempts: 2, recording_expires_at: iso(NOW - MIN), requested_at: iso(NOW - 40 * MIN) }),
      call({ id: C.sinIntentos, recording_status: "pendiente", recording_attempts: 6, recording_expires_at: iso(NOW + 5 * MIN) }),
      // El END llegó hace 30 segundos: la copia la está haciendo el aviso.
      call({ id: C.recien, recording_status: "pendiente", recording_attempts: 0, recording_expires_at: iso(NOW + 29.5 * MIN), requested_at: iso(NOW - 2 * MIN) }),
      call({ id: C.sinFecha, recording_status: "pendiente", recording_expires_at: null }),
      call({ id: C.guardada, recording_status: "guardada", recording_path: `${ORG}/2026-11/${id(8)}.mp3` }),
    ],
    anura_webhook_events: [
      event({ id: "e-entrante", call_id: C.entrante, recording_url: url("entrante") }),
      event({ id: "e-vencida", call_id: C.vencida, recording_url: url("vencida"), received_at: iso(NOW - 31 * MIN) }),
      event({ id: "e-recien", call_id: C.recien, recording_url: url("recien"), received_at: iso(NOW - 0.5 * MIN) }),
      event({ id: "e-guardada", call_id: C.guardada, recording_url: url("guardada"), received_at: iso(NOW - 5 * MIN) }),
      event({ id: "e-huerfano", call_id: null, outcome: "ignorado", recording_url: url("huerfano"), received_at: iso(NOW - MIN) }),
      event({ id: "e-viejo", call_id: null, received_at: iso(NOW - 31 * 86_400_000) }),
      event({ id: "e-29dias", call_id: null, received_at: iso(NOW - 29 * 86_400_000) }),
    ],
  });
}

function audioFetch(onFetch?: () => void) {
  return vi.fn(async (_input: unknown) => {
    onFetch?.();
    return new Response(new Uint8Array([73, 68, 51, 1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": "6" } });
  });
}

const rowOf = (db: FakeDb, callId: string) => db.tables.anura_calls.find((r) => r.id === callId)!;
const evOf = (db: FakeDb, evId: string) => db.tables.anura_webhook_events.find((r) => r.id === evId);

describe("la pasada (lib/anura/maintenance.ts)", () => {
  beforeEach(() => {
    // La pasada de verdad (el mock solo la reemplaza para las pruebas de la ruta).
    mocks.real = true;
  });

  it("suelta las colgadas, vence lo que no se puede copiar, copia la entrante y poda la bitácora", async () => {
    const db = seed();
    const fetchImpl = audioFetch();
    const report = await runAnuraMaintenance(db.client, {}, { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(report).toMatchObject({
      ok: true,
      dry: false,
      liberadas: 2,
      vencidas: 3,
      copias: { guardada: 1, pendiente: 0, vencida: 0, omitida: 0 },
      porCopiar: 1,
      sinTiempo: 0,
      avisosBorrados: 1,
      errors: [],
    });

    // 1. Las colgadas, con las mismas reglas y textos de la ficha.
    expect(rowOf(db, C.stuckReq)).toMatchObject({ status: "fallida", status_rank: 100, closed_by_timeout: true, failure_reason: ANURA_STALE_REASON });
    expect(rowOf(db, C.stuckLive)).toMatchObject({ status: "fallida", closed_by_timeout: true, failure_reason: ANURA_STUCK_REASON });
    // 2. Lo que ya no se puede copiar.
    expect(rowOf(db, C.vencida)).toMatchObject({ recording_status: "vencida", recording_error: ANURA_RECORDING_EXPIRED_ERROR });
    expect(rowOf(db, C.sinFecha)).toMatchObject({ recording_status: "vencida", recording_error: ANURA_RECORDING_EXPIRED_ERROR });
    expect(rowOf(db, C.sinIntentos)).toMatchObject({ recording_status: "vencida", recording_error: ANURA_RECORDING_ATTEMPTS_ERROR });
    // 3. La entrante (sin ficha) quedó guardada en el bucket privado.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(url("entrante"));
    expect(rowOf(db, C.entrante)).toMatchObject({ recording_status: "guardada", recording_attempts: 2, recording_error: null });
    expect(db.uploads).toEqual([{ bucket: "anura-recordings", path: `${ORG}/2026-11/${C.entrante}.mp3`, bytes: 6, contentType: "audio/mpeg" }]);
    // La recién terminada no se toca: la copia del aviso tiene su margen.
    expect(rowOf(db, C.recien)).toMatchObject({ recording_status: "pendiente", recording_attempts: 0 });
    // 4. La bitácora: lo de más de 30 días se va; los enlaces que ya no sirven, también.
    expect(evOf(db, "e-viejo")).toBeUndefined();
    expect(evOf(db, "e-29dias")).toBeDefined();
    for (const e of ["e-entrante", "e-vencida", "e-guardada", "e-huerfano"]) expect(evOf(db, e)?.recording_url, e).toBeNull();
    expect(evOf(db, "e-recien")?.recording_url).toBe(url("recien"));
    // El de la entrante lo borra la propia copia al quedar guardada; el cron cuenta los otros tres.
    expect(report.enlacesBorrados).toBe(3);
  });

  it("idempotente: la segunda pasada no hace nada de más", async () => {
    const db = seed();
    const fetchImpl = audioFetch();
    const deps = { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch };
    await runAnuraMaintenance(db.client, {}, deps);
    const before = JSON.stringify(db.tables);
    const second = await runAnuraMaintenance(db.client, {}, deps);
    expect(second).toMatchObject({ ok: true, liberadas: 0, vencidas: 0, porCopiar: 0, avisosBorrados: 0, enlacesBorrados: 0 });
    expect(Object.values(second.copias).every((n) => n === 0)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it("la recién terminada se reintenta en la pasada siguiente, pasado su margen de 2 minutos", async () => {
    const db = seed();
    const fetchImpl = audioFetch();
    await runAnuraMaintenance(db.client, {}, { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch });
    const later = await runAnuraMaintenance(db.client, {}, { now: () => new Date(NOW + 10 * MIN), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(later.copias.guardada).toBe(1);
    expect(rowOf(db, C.recien).recording_status).toBe("guardada");
    expect(evOf(db, "e-recien")?.recording_url).toBeNull();
  });

  it("acotada por tiempo: no empieza copias pasado el presupuesto; lo que no cupo queda para la próxima", async () => {
    const db = createFakeDb({
      anura_calls: [1, 2, 3].map((n) =>
        call({ id: id(100 + n), mode: "entrante", direction: "in", recording_status: "pendiente", recording_expires_at: iso(NOW + 20 * MIN), requested_at: iso(NOW - (20 - n) * MIN) }),
      ),
      anura_webhook_events: [1, 2, 3].map((n) => event({ id: `e${n}`, call_id: id(100 + n), recording_url: url(`n${n}`) })),
    });
    let t = NOW;
    const fetchImpl = audioFetch(() => {
      t += 20_000;
    });
    const report = await runAnuraMaintenance(db.client, {}, { now: () => new Date(t), fetchImpl: fetchImpl as unknown as typeof fetch, budgetMs: 25_000 });
    expect(report.copias.guardada).toBe(2);
    expect(report.sinTiempo).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // La más antigua primero.
    expect(rowOf(db, id(101)).recording_status).toBe("guardada");
    expect(rowOf(db, id(103)).recording_status).toBe("pendiente");
  });

  it("acotada por lote", async () => {
    expect(ANURA_MAINTENANCE_COPY_LIMIT).toBe(20);
    const db = createFakeDb({
      anura_calls: [1, 2, 3].map((n) => call({ id: id(200 + n), recording_status: "pendiente", recording_expires_at: iso(NOW + 20 * MIN) })),
      anura_webhook_events: [1, 2, 3].map((n) => event({ id: `e${n}`, call_id: id(200 + n), recording_url: url(`m${n}`) })),
    });
    const fetchImpl = audioFetch();
    const report = await runAnuraMaintenance(db.client, {}, { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch, copyLimit: 2 });
    expect(report.porCopiar).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("una copia fallida suma un intento y sigue «pendiente»; nunca baja de un host que no es de Anura", async () => {
    const db = seed();
    evOf(db, "e-entrante")!.recording_url = "https://evil.example.com/a.mp3";
    const fetchImpl = audioFetch();
    const report = await runAnuraMaintenance(db.client, {}, { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.copias.pendiente).toBe(1);
    expect(rowOf(db, C.entrante)).toMatchObject({ recording_status: "pendiente", recording_attempts: 2 });
  });

  it("?dry: solo cuenta, sin escribir ni bajar nada", async () => {
    const db = seed();
    const before = JSON.stringify(db.tables);
    const fetchImpl = audioFetch();
    const report = await runAnuraMaintenance(db.client, { dry: true }, { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(report).toMatchObject({ ok: true, dry: true, liberadas: 2, vencidas: 3, porCopiar: 1, avisosBorrados: 1, enlacesBorrados: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.uploads).toEqual([]);
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it("un paso que falla no tumba a los demás, y el motivo no cita la base", async () => {
    const db = seed();
    const client = {
      ...db.client,
      from: (table: string) => {
        if (table === "anura_webhook_events") throw new Error("permission denied for table anura_webhook_events (987654321)");
        return db.client.from(table);
      },
    };
    const report = await runAnuraMaintenance(client as never, {}, { now: () => new Date(NOW), fetchImpl: audioFetch() as unknown as typeof fetch });
    expect(report.ok).toBe(false);
    expect(report.liberadas).toBe(2);
    expect(report.errors).toContain("No se pudo podar la bitácora de avisos.");
    expect(JSON.stringify(report)).not.toContain("987654321");
    expect(JSON.stringify(report)).not.toContain("permission denied");
  });

  it("si la base no deja cerrar las colgadas, es un error y no «0 liberadas»", async () => {
    const db = seed();
    // Un encadenado que acepta todo y termina en error de la base.
    const failing: any = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then" ? (ok: any) => Promise.resolve({ data: null, error: { message: "permission denied (987654321)" } }).then(ok) : () => failing,
      },
    );
    const client = {
      ...db.client,
      from: (table: string) => {
        const q = db.client.from(table);
        if (table !== "anura_calls") return q;
        const update = q.update;
        q.update = (p: Record<string, unknown>) => (p.status === "fallida" ? failing : update(p));
        return q;
      },
    };
    const report = await runAnuraMaintenance(client as never, {}, { now: () => new Date(NOW), fetchImpl: audioFetch() as unknown as typeof fetch });
    expect(report.ok).toBe(false);
    expect(report.liberadas).toBe(0);
    expect(report.errors).toEqual(["No se pudieron revisar las llamadas colgadas."]);
    expect(rowOf(db, C.stuckReq).status).toBe("solicitada");
    // Los demás pasos siguen.
    expect(rowOf(db, C.vencida).recording_status).toBe("vencida");
    expect(JSON.stringify(report)).not.toContain("987654321");
  });

  it("un aviso de fin que llega entre la lectura y la escritura deja la grabación «pendiente» y su enlace nuevo", async () => {
    const db = seed();
    let raced = false;
    const client = {
      ...db.client,
      from: (table: string) => {
        const q = db.client.from(table);
        if (table !== "anura_calls") return q;
        const update = q.update;
        q.update = (p: Record<string, unknown>) => {
          if (p.recording_status === "vencida" && !raced) {
            raced = true;
            // Llega otro END de las dos que se iban a marcar: enlace nuevo, 30 minutos más, intentos en 0.
            for (const callId of [C.vencida, C.sinIntentos]) {
              Object.assign(rowOf(db, callId), { recording_status: "pendiente", recording_expires_at: iso(NOW + 30 * MIN), recording_attempts: 0 });
              db.tables.anura_webhook_events.push(event({ id: `e-nuevo-${callId}`, call_id: callId, recording_url: url(`nuevo-${callId}`), received_at: iso(NOW + 1_000) }));
            }
          }
          return update(p);
        };
        return q;
      },
    };
    const fetchImpl = audioFetch();
    const report = await runAnuraMaintenance(client as never, {}, { now: () => new Date(NOW), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(report.ok).toBe(true);
    // Solo la que no tiene fecha se marcó.
    expect(report.vencidas).toBe(1);
    expect(rowOf(db, C.sinFecha).recording_status).toBe("vencida");
    for (const callId of [C.vencida, C.sinIntentos]) {
      expect(rowOf(db, callId)).toMatchObject({ recording_status: "pendiente", recording_attempts: 0 });
      expect(evOf(db, `e-nuevo-${callId}`)?.recording_url).toBe(url(`nuevo-${callId}`));
    }
  });

  it("el reporte no lleva teléfonos ni enlaces", async () => {
    const db = seed();
    const report = await runAnuraMaintenance(db.client, {}, { now: () => new Date(NOW), fetchImpl: audioFetch() as unknown as typeof fetch });
    const text = JSON.stringify(report);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain("98••••321");
    expect(text).not.toContain("anura.pe");
  });
});

const req = (q = "", auth: string | null = "Bearer cron") =>
  new NextRequest(`https://kapta.test/api/cron/anura-recordings${q}`, { headers: auth ? { authorization: auth } : {} });

function report(over: Partial<AnuraMaintenanceReport> = {}): AnuraMaintenanceReport {
  return {
    ok: true,
    dry: false,
    ms: 1_200,
    liberadas: 1,
    vencidas: 2,
    copias: { guardada: 1, pendiente: 0, vencida: 0, omitida: 0 },
    porCopiar: 1,
    sinTiempo: 0,
    avisosBorrados: 3,
    enlacesBorrados: 2,
    errors: [],
    ...over,
  };
}

describe("/api/cron/anura-recordings", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron");
    vi.stubEnv("VERCEL_ENV", "production");
    mocks.admin = { soy: "admin" };
    mocks.report = report();
    mocks.throws = null;
    mocks.real = false;
    vi.mocked(runAnuraMaintenance).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("corre en Node, sin caché, por GET y por POST, y una copia al borde del presupuesto cabe", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(ANURA_MAINTENANCE_MAX_DURATION_S);
    // La que empieza al borde: su descarga (20 s) y la subida.
    expect(ANURA_MAINTENANCE_COPY_BUDGET_MS + ANURA_RECORDING_FETCH_TIMEOUT_MS + 10_000).toBeLessThanOrEqual(route.maxDuration * 1000);
    expect(route.POST).toBe(route.GET);
  });

  it("la misma autorización que los demás crons: sin CRON_SECRET, 401 y no corre", async () => {
    expect((await route.GET(req("", null))).status).toBe(401);
    expect((await route.GET(req("", "Bearer otro"))).status).toBe(401);
    expect(runAnuraMaintenance).not.toHaveBeenCalled();
    const src = readFileSync(resolve(process.cwd(), "app/api/cron/anura-recordings/route.ts"), "utf8");
    expect(src).toContain('import { internalAuthorized } from "@/lib/voice-recovery-server";');
    expect(src).toContain('if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });');
  });

  it("fuera de producción no hace nada; con ?dry=1 sí corre, solo contando", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await (await route.GET(req())).json()).toEqual({ skipped: "not_production" });
    expect(runAnuraMaintenance).not.toHaveBeenCalled();
    mocks.report = report({ dry: true });
    expect((await route.GET(req("?dry=1"))).status).toBe(200);
    expect(runAnuraMaintenance).toHaveBeenCalledWith(mocks.admin, { dry: true });
  });

  it("una sola línea de log con el reporte; con errores, 502", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await route.GET(req());
    expect(ok.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line.startsWith("[anura-recordings] ")).toBe(true);
    expect(JSON.parse(line.slice("[anura-recordings] ".length))).toEqual(mocks.report);
    mocks.report = report({ ok: false, errors: ["No se pudo podar la bitácora de avisos."] });
    expect((await route.GET(req())).status).toBe(502);
  });

  it("con la base de verdad simulada, ni la respuesta ni el log llevan teléfonos ni enlaces", async () => {
    const db = seed();
    mocks.admin = db.client;
    mocks.real = true;
    vi.stubGlobal("fetch", audioFetch());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await route.GET(req());
    const body = JSON.stringify(await res.json());
    const line = String(log.mock.calls[0]![0]);
    for (const text of [body, line]) {
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain("98••••321");
      expect(text).not.toContain("anura.pe");
    }
    vi.unstubAllGlobals();
  });

  it("si la pasada revienta: 500 sin el mensaje", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.throws = new Error("violates check … (phone)=(987654321)");
    const res = await route.GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("987654321");
    expect(String(log.mock.calls[0]![0])).not.toContain("987654321");
  });
});

describe("vercel.json: el cron de Anura", () => {
  const crons = (JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }).crons;

  it("cada 10 minutos de verdad, a los 1, 11, 21, 31, 41 y 51", () => {
    expect(crons.filter((c) => c.path === "/api/cron/anura-recordings")).toEqual([
      { path: "/api/cron/anura-recordings", schedule: "1,11,21,31,41,51 * * * *" },
    ]);
    const minutes = "1,11,21,31,41,51".split(",").map(Number);
    const gaps = minutes.map((m, i) => ((minutes[(i + 1) % minutes.length]! - m + 60) % 60));
    // Todos los huecos son de 10 minutos: dos o más intentos antes de que
    // venza el enlace (30 minutos, menos los 2 de margen del aviso de fin).
    expect(new Set(gaps)).toEqual(new Set([10]));
  });

  it("solo comparte minuto con el de los minutos impares y, a los :11, con prepay-list (nunca el :23 de shopify-own-app-tokens)", () => {
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      const out: number[] = [];
      for (const part of minute!.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        const [from, to] =
          range === "*" ? [0, 59] : range!.includes("-") ? range!.split("-").map(Number) : [Number(range), stepText ? 59 : Number(range)];
        for (let m = from!; m <= to!; m += step) out.push(m);
      }
      return out;
    };
    // invoice-snapshots corre en TODOS los minutos impares y no queda ningún
    // minuto libre: ninguna cadencia de 10 minutos evita coincidir con algo.
    expect(crons.find((c) => c.path === "/api/cron/invoice-snapshots")?.schedule).toBe("1-59/2 * * * *");
    const mine = minutesOf("1,11,21,31,41,51 * * * *");
    expect(mine).not.toContain(23);
    for (const c of crons.filter((x) => x.path !== "/api/cron/anura-recordings" && x.path !== "/api/cron/invoice-snapshots")) {
      const theirs = minutesOf(c.schedule);
      expect(mine.filter((m) => theirs.includes(m)), c.path).toEqual(c.path === "/api/cron/prepay-list" ? [11] : []);
    }
  });
});

describe("MOM §8.7 y DEPLOY.md", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const MOM = flat(read("docs/mom/master-pedidos-v1.md"));
  const DEPLOY = read("DEPLOY.md");

  it("el MOM describe el cron como lo hace el código", () => {
    expect(MOM).toContain("- **El cron de Anura (`/api/cron/anura-recordings`, 06-11-2026).** Corre cada 10 minutos (minutos 1, 11, 21, 31, 41 y 51;");
    expect(MOM).toContain(
      "marca «grabación vencida» las «pendiente» cuyo enlace ya pasó los 30 minutos, que no tienen fecha de vencimiento del enlace o que ya usaron sus 6 intentos.",
    );
    expect(MOM).toContain("hasta 20 por pasada y empezando copias solo durante 25 segundos");
    expect(ANURA_MAINTENANCE_COPY_BUDGET_MS).toBe(25_000);
    expect(MOM).toContain("No toca una grabación cuyo aviso de fin llegó hace menos de 2 minutos");
    expect(MOM).toContain("borra de la bitácora los avisos de más de 30 días");
    expect(MOM).toContain("Correrlo dos veces no hace nada de más");
    expect(MOM).toContain("Su respuesta y su registro llevan solo conteos, nunca teléfonos ni enlaces.");
  });

  it("DEPLOY.md: las entradas de la 0310, la 0311 y el cron, en orden y con su formato", () => {
    const titles = [
      "### 06-11-2026 · «Llamar con Anura»: el cron de grabaciones y el dominio no reconocido (sin migración, MOM §8.7)",
      "### 06-11-2026 · «Llamar con Anura», fase 2: el teléfono dentro de Kapta, solo salidas (0311, MOM §8.7)",
      "### 05-11-2026 · «Llamar con Anura», fase 1: Click2Dial (0310, MOM §8.7)",
      "### 05-11-2026 · El rechazo de Aliclik que ya vuelve pasa a reprogramar (sin migración, mom-v1.39, MOM §9 y §11)",
    ];
    const at = titles.map((t) => DEPLOY.indexOf(t));
    for (const [i, pos] of at.entries()) expect(pos, titles[i]).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const entry = (i: number) => flat(DEPLOY.slice(at[i]!, at[i + 1]!));
    expect(entry(0)).toContain("`/api/cron/anura-recordings`, cada 10 minutos (`1,11,21,31,41,51 * * * *`;");
    expect(entry(0)).toContain("**Marcha atrás.**");
    expect(entry(1)).toContain("**Aplicada en producción el 06-11-2026.**");
    expect(entry(1)).toContain("**Migración `0311_anura_kapta_phone.sql`**, a mano, ANTES del código.");
    expect(entry(1)).toContain("pnpm install --frozen-lockfile");
    expect(entry(2)).toContain("**Aplicada en producción el 05-11-2026.**");
    expect(entry(2)).toContain("**Migración `0310_anura_click2dial.sql`**, a mano, ANTES del código.");
    for (const v of ["`ANURA_CLICK2DIAL_TOKEN` — **ya en Vercel.**", "`ANURA_ORG_ID` — opcional.", "`ANURA_RECORDING_HOSTS` — opcional."]) {
      expect(entry(2)).toContain(v);
    }
    // La lista de crons del paso 4 y la tabla de variables.
    expect(flat(DEPLOY)).toContain("- `/api/cron/anura-recordings` — cada 10 min (a los :01, :11, :21, :31, :41 y :51).");
    for (const v of ["ANURA_CLICK2DIAL_TOKEN", "ANURA_ORG_ID", "ANURA_RECORDING_HOSTS"]) expect(DEPLOY).toContain(`   | \`${v}\` |`);
  });
});
