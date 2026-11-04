// Reintentos Aliclik automáticos en Lima (MOM §9.5, entrega 3, y §40, owner
// 04-11-2026). Lo puro (variantes, posiciones, tope, horario, motivo) y la
// pasada con una base en memoria: el candado del log, qué se reintenta, el
// tope, la persona que tiene el caso, la simulación que no escribe hechos y la
// vista previa que no escribe nada.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  write: true,
  health: { quote: "ok", create: "ok" },
  facts: new Map<string, Row>(),
  core: [] as Row[],
  coreResult: (_input: Row): Row => ({ outcome: "creada", transport: "AUTOECOM", guide: "AL-9" }),
  telegrams: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { aliclikWriteEnabled: () => h.write, siteUrl: () => "https://kapta.test" } }));
vi.mock("@/lib/shipments", () => ({ limaTodayKey: () => "2026-11-04" }));
vi.mock("@/lib/aliclik-guide", () => ({
  aliclikReadScopeFor: async (_admin: unknown, storeId: string) => ({ scope: { client: null, storeIds: [storeId] } }),
}));
vi.mock("@/lib/aliclik-health-access", () => ({ loadAliclikHealthState: async () => h.health }));
vi.mock("@/lib/aliclik-scheduled-server", () => ({
  telegramTarget: async () => ({ token: "t", chats: "c", storeName: "Tienda" }),
}));
vi.mock("@/lib/telegram", () => ({
  escapeHtml: (s: string) => s,
  sendTelegramToAll: async (_t: string, _c: string, text: string) => {
    h.telegrams.push(text);
    return { sent: 1 };
  },
}));
vi.mock("@/lib/repro-lima-access", () => ({
  loadReproFacts: async (_admin: unknown, ids: string[]) => new Map(ids.filter((id) => h.facts.has(id)).map((id) => [id, h.facts.get(id)])),
  retryChainOf: (f: Row) => (f.retryChain.state === "siguiente"
    ? { attempt: f.retryChain.attempt, of: f.retryChain.of, next: f.retryChain.next, failedText: "falló", inOffice: false, ready: f.ready !== false }
    : null),
}));
vi.mock("@/lib/lima-retry-approve", () => ({
  RETRY_TRANSPORT_LABEL: { autoecom: "AUTOECOM", alidriver: "ALIDRIVER" },
  approveLimaRetry: async (input: Row) => {
    h.core.push(input);
    return h.coreResult(input);
  },
}));

import {
  RETRY_VARIANTS,
  anyRetryVariantOn,
  autoRetryMotive,
  retryCapLeft,
  retryModes,
  retryPassOpen,
  retryVariantLabel,
  retryVariantOf,
} from "@/lib/lima-retry-auto";
import { aliclikMotiveAllowed, aliclikOutputPolicy } from "@/lib/aliclik-output-policy";
import { LIMA_RETRY_AUTO_FAILED, retryFailureTelegram, runLimaRetryAuto } from "@/lib/lima-retry-auto-server";

// ---------------------------------------------------------------------------
// Lo puro
// ---------------------------------------------------------------------------

const failed = (carrier: string, reason: string | null = "no_contesta", at = "2026-11-02T17:00:00Z") => ({ carrier, reason, at });
const next = (carrier: string, nextHop: "autoecom" | "alidriver", of = 3, reason: string | null = "no_contesta", at?: string) => ({
  state: "siguiente" as const, attempt: of === 3 && nextHop === "alidriver" ? 3 : 2, of, next: nextHop,
  failed: failed(carrier, reason, at) as never, startedAt: "2026-11-01T17:00:00Z",
});

describe("la variante es el paso de la cadena por el motivo del intento que falló", () => {
  it("las doce, en el orden del panel", () => {
    expect(RETRY_VARIANTS).toHaveLength(12);
    expect(retryVariantOf(next("alexis", "autoecom"))).toBe("alexis_autoecom:no_contesta");
    expect(retryVariantOf(next("urpi", "autoecom", 3, "no_estaba"))).toBe("urpi_autoecom:no_estaba");
    expect(retryVariantOf(next("autoecom", "alidriver", 3, "otro"))).toBe("autoecom_alidriver_3:otro");
    expect(retryVariantOf(next("autoecom", "alidriver", 2))).toBe("autoecom_alidriver_2:no_contesta");
  });

  it("lo que no es un paso de la cadena no tiene variante", () => {
    expect(retryVariantOf(next("otro", "autoecom"))).toBeNull();
    expect(retryVariantOf(next("alexis", "autoecom", 3, "rechazado"))).toBeNull();
    expect(retryVariantOf({ state: "fuera", why: "agotada", failed: null })).toBeNull();
  });

  it("sin renglón, apagada; un valor inválido no enciende nada", () => {
    const modes = retryModes([
      { variant: "alexis_autoecom:no_contesta", mode: "activo" },
      { variant: "urpi_autoecom:no_estaba", mode: "encendido" },
      { variant: "inventada:otro", mode: "activo" },
    ]);
    expect(modes["alexis_autoecom:no_contesta"]).toBe("activo");
    expect(modes["urpi_autoecom:no_estaba"]).toBe("apagado");
    expect(anyRetryVariantOn(retryModes([]))).toBe(false);
    expect(anyRetryVariantOn(modes)).toBe(true);
    expect(retryVariantLabel("alexis_autoecom:no_contesta")).toBe("Alexis (Grupo GF) → AUTOECOM · no contesta");
  });

  it("horario de 8:00 a 13:59 de Lima y tope", () => {
    expect([7, 8, 13, 14].map(retryPassOpen)).toEqual([false, true, true, false]);
    expect(retryCapLeft(3, 10)).toBe(7);
    expect(retryCapLeft(12, 10)).toBe(0);
  });

  it("el motivo de la salida adicional lo dice: automático, por la regla encendida", () => {
    expect(autoRetryMotive(next("alexis", "autoecom"), "Falló con Alexis el 02/11: no contesta"))
      .toBe("Reintento Aliclik 2 de 3 automático (regla encendida en Automatizaciones). Falló con Alexis el 02/11: no contesta.");
  });
});

describe("la salida adicional de Lima: el motivo solo para una persona o el reintento de Lima", () => {
  const alexis = { id: "s1", guide_code: "GF-1", output_code: "GF-1", delivery_status: "pendiente", courier: "propio", created_via: "kapta" } as never;
  it("aliclikMotiveAllowed", () => {
    expect(aliclikMotiveAllowed("ana")).toBe(true);
    expect(aliclikMotiveAllowed(null, "reintento_lima")).toBe(true);
    expect(aliclikMotiveAllowed(null, "envio_programado")).toBe(false);
    expect(aliclikMotiveAllowed(null, "confirmado_chatby")).toBe(false);
    expect(aliclikMotiveAllowed(null)).toBe(false);
  });

  it("con la caja de Alexis viva, el reintento de Lima pasa con su motivo y el programado no", () => {
    const motivo = "Reintento Aliclik 2 de 3 automático (regla encendida en Automatizaciones).";
    const retry = aliclikOutputPolicy({ outputs: [alexis], operation: "lima", motivo, manual: aliclikMotiveAllowed(null, "reintento_lima") });
    expect(retry.ok).toBe(true);
    const scheduled = aliclikOutputPolicy({ outputs: [alexis], operation: "lima", motivo, manual: aliclikMotiveAllowed(null, "envio_programado") });
    expect(scheduled).toMatchObject({ ok: false, pideMotivo: true });
  });

  it("el origen se enhebra en las dos lecturas de la creación; el navegador no lo manda", () => {
    const guide = readFileSync(resolve(process.cwd(), "lib/aliclik-guide.ts"), "utf8");
    expect(guide).toContain("readAliclikOutputPolicy(admin, ctx, input.motivoSalidaAdicional, origin);");
    expect(guide).toContain("const finalOutputPolicy = await readAliclikOutputPolicy(admin, ctx, input.motivoSalidaAdicional, origin);");
    expect(guide).toContain("manual: aliclikMotiveAllowed(ctx.userId, origin?.kind),");
    expect(guide).toContain('kind: "envio_programado" | "confirmado_chatby" | "reintento_lima";');
    const start = guide.indexOf("export interface CreateGuideInput");
    expect(start).toBeGreaterThan(-1);
    const input = guide.slice(start, guide.indexOf("\n}\n", start));
    expect(input).toContain("motivoSalidaAdicional");
    expect(input).not.toContain("origin");
  });
});

// ---------------------------------------------------------------------------
// La pasada, con una base en memoria
// ---------------------------------------------------------------------------

type Write = { table: string; op: string; value: any };

function fakeDb(seed: Record<string, Row[]>) {
  const db: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const writes: Write[] = [];
  let seq = 100;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let value: any = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let range: [number, number] | null = null;
    const q: any = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
    q.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; };
    q.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; };
    q.order = () => q;
    q.range = (a: number, b: number) => { range = [a, b]; return q; };
    q.update = (v: any) => { op = "update"; value = v; return q; };
    q.insert = (v: any) => { op = "insert"; value = v; return q; };
    q.upsert = (v: any, o: any = {}) => { op = "upsert"; value = v; upsertOpts = o; return q; };
    const run = () => {
      const rows = (db[table] ??= []);
      const match = (r: Row) => filters.every((f) => f(r));
      if (op === "select") {
        let out = rows.filter(match);
        if (range) out = out.slice(range[0], range[1] + 1);
        return { data: out, error: null };
      }
      writes.push({ table, op, value });
      if (op === "insert") {
        const row = { id: seq++, ...value };
        rows.push(row);
        return { data: [row], error: null };
      }
      if (op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, value);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const keys = (upsertOpts.onConflict ?? "").split(",");
      const existing = rows.find((r) => keys.every((k) => r[k] === value[k]));
      if (existing) {
        if (upsertOpts.ignoreDuplicates) return { data: [], error: null };
        Object.assign(existing, value);
        return { data: [{ id: existing.id }], error: null };
      }
      const row = { id: seq++, ...value };
      rows.push(row);
      return { data: [{ id: row.id }], error: null };
    };
    q.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve().then(run).then(resolve, reject);
    return q;
  };
  return { admin: { from } as never, db, writes };
}

const ORG = "org-1";
const OPEN_HOUR = new Date("2026-11-04T15:00:00Z"); // 10:00 en Lima
const LATE = new Date("2026-11-04T22:00:00Z"); // 17:00 en Lima

function order(id: string, at = "2026-11-02T17:00:00Z", carrier = "alexis", extra: Row = {}) {
  h.facts.set(id, {
    open: extra.open ?? null,
    episode: { key: "ep" },
    retryChain: next(carrier, "autoecom", 3, "no_contesta", at),
  });
  return { order_id: id, store_id: "s1", order_name: `#${id}`, macro_stage: "en_curso", macro_substage: "por_reprogramar_lima" };
}

function seed(mode: "apagado" | "simulacion" | "activo", orders: Row[], extra: Record<string, Row[]> = {}) {
  return fakeDb({
    lima_retry_auto_variants: mode === "apagado" ? [] : [{ org_id: ORG, variant: "alexis_autoecom:no_contesta", mode }],
    lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5 }],
    stores: [{ id: "s1", org_id: ORG, status: "active" }, { id: "s9", org_id: ORG, status: "inactive" }],
    order_master: orders,
    lima_retry_auto_log: [],
    order_events: [],
    ...extra,
  });
}

beforeEach(() => {
  h.write = true;
  h.health = { quote: "ok", create: "ok" };
  h.facts = new Map();
  h.core = [];
  h.telegrams = [];
  h.coreResult = () => ({ outcome: "creada", transport: "AUTOECOM", guide: "AL-9" });
});

describe("la pasada", () => {
  it("fuera de 8:00–13:59 de Lima no lee nada", async () => {
    const { admin, writes } = seed("activo", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: LATE });
    expect(report).toMatchObject({ skipped: "fuera_de_horario", orgs: [], limaHour: 17 });
    expect(h.core).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("todo apagado: ni lee pedidos", async () => {
    const { admin } = seed("apagado", [order("a")]);
    expect((await runLimaRetryAuto(admin, { now: OPEN_HOUR })).orgs).toEqual([]);
    expect(h.core).toEqual([]);
  });

  it("simulación: cotiza sin crear, deja UN renglón por día y ningún hecho", async () => {
    h.coreResult = (input) => ({ outcome: input.dry ? "simulada" : "creada", transport: "AUTOECOM", detail: "AUTOECOM S/ 9 · cobrar S/ 120.00" });
    const { admin, db } = seed("simulacion", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core.map((c) => c.dry)).toEqual([true, true]);
    expect(h.core[0]).toMatchObject({ actor: { system: true, variant: "alexis_autoecom:no_contesta" }, today: "2026-11-04" });
    expect(report.orgs[0]!.items).toEqual([expect.objectContaining({ orderId: "a", mode: "simulacion", outcome: "simulada", transport: "AUTOECOM" })]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({
      order_id: "a", lima_day: "2026-11-04", mode: "simulacion", outcome: "simulada", detail: "AUTOECOM S/ 9 · cobrar S/ 120.00",
    })]);
    expect(db.order_events).toEqual([]);
    expect(h.telegrams).toEqual([]);
  });

  it("activo: crea una vez por pedido y día; la pasada siguiente no lo vuelve a tomar", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    const first = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(first.orgs[0]).toMatchObject({ dailyCap: 5, capLeft: 4 });
    expect(first.orgs[0]!.items).toEqual([expect.objectContaining({ outcome: "creada", guide: "AL-9", mode: "activo" })]);
    expect(h.core).toEqual([expect.objectContaining({ dry: false })]);
    const second = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
    expect(second.orgs[0]!.items).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ mode: "activo", outcome: "creada", guide_code: "AL-9" })]);
  });

  it("lo que se reintenta (Aliclik fallando) se vuelve a tomar en la pasada siguiente", async () => {
    h.health = { quote: "fallos", create: "ok" };
    const { admin, db } = seed("activo", [order("a")]);
    const first = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(first.orgs[0]!.items[0]).toMatchObject({ outcome: "esperando_aliclik" });
    expect(h.core).toEqual([]);
    h.health = { quote: "ok", create: "ok" };
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
    expect(db.lima_retry_auto_log).toHaveLength(1);
    expect(db.lima_retry_auto_log![0]).toMatchObject({ outcome: "creada" });
  });

  it("en curso (otra pasada lo está creando) no se toma", async () => {
    const { admin } = seed("activo", [order("a")], {
      lima_retry_auto_log: [{ id: 1, org_id: ORG, order_id: "a", lima_day: "2026-11-04", mode: "activo", outcome: "en_curso", variant: "alexis_autoecom:no_contesta" }],
    });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
  });

  it("tope del día: lo creado de otros pedidos cuenta; se reintenta después", async () => {
    const created = (id: string, outcome = "creada") => ({ id: Number(id.slice(1)), org_id: ORG, order_id: id, lima_day: "2026-11-04", mode: "activo", outcome });
    const { admin, db } = seed("activo", [order("a")], {
      lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 2 }],
      lima_retry_auto_log: [created("x1"), created("x2", "incierto"), created("x3", "fallo"), { ...created("x4"), lima_day: "2026-11-03" }],
    });
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.orgs[0]).toMatchObject({ dailyCap: 2, capLeft: 0 });
    expect(report.orgs[0]!.items[0]).toMatchObject({ outcome: "tope" });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log!.find((r) => r.order_id === "a")).toMatchObject({ outcome: "tope" });
  });

  it("una persona con el caso tomado: atendiendo, sin crear", async () => {
    const open = { episode_key: "ep", claimed_by: "ana", claimed_until: "2026-11-04T15:20:00Z", agreed_on: null };
    const { admin } = seed("activo", [order("a", undefined, "alexis", { open })]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.orgs[0]!.items[0]).toMatchObject({ outcome: "atendiendo" });
    expect(h.core).toEqual([]);
    // Vencido el candado de la persona, la pasada lo toma.
    open.claimed_until = "2026-11-04T14:00:00Z";
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
  });

  it("un fallo avisa UNA vez por Telegram y deja el hecho del sistema", async () => {
    h.coreResult = () => ({ outcome: "fallo", stage: "creacion", transport: "AUTOECOM", error: "Monto distinto.", locked: false });
    const { admin, db } = seed("activo", [order("a")]);
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.telegrams).toHaveLength(1);
    expect(h.telegrams[0]).toContain("Monto distinto.");
    expect(db.order_events).toEqual([expect.objectContaining({
      kind: LIMA_RETRY_AUTO_FAILED, actor: null, source: "system", reason: "Monto distinto.",
      payload: expect.objectContaining({ variant: "alexis_autoecom:no_contesta", outcome: "fallo", telegram: true }),
    })]);
  });

  it("sin escritura hacia Aliclik, lo activo no crea y lo dice; la simulación sigue", async () => {
    h.write = false;
    const { admin, db } = seed("activo", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.error).toContain("ALICLIK_WRITE_ENABLED");
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
  });

  it("el fallo más viejo primero; lo que no está listo o es de otro paso no entra", async () => {
    h.coreResult = () => ({ outcome: "simulada", transport: "AUTOECOM", detail: "x" });
    const rows = [order("nuevo", "2026-11-03T17:00:00Z"), order("viejo", "2026-11-01T17:00:00Z"), order("otro", "2026-10-31T17:00:00Z", "urpi")];
    h.facts.get("otro")!.ready = true;
    const hoy = order("hoy");
    h.facts.get("hoy")!.ready = false;
    const { admin } = seed("simulacion", [...rows, hoy]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    // «otro» es urpi_autoecom (apagada); «hoy» falló hoy.
    expect(report.orgs[0]!.items.map((i) => i.orderId)).toEqual(["viejo", "nuevo"]);
  });
});

describe("la vista previa («Simular ahora»)", () => {
  it("todas las variantes, aunque estén apagadas, a cualquier hora, sin escribir NADA", async () => {
    h.coreResult = () => ({ outcome: "simulada", transport: "AUTOECOM", detail: "x" });
    const { admin, writes } = seed("apagado", [order("a"), order("b", undefined, "urpi")]);
    const report = await runLimaRetryAuto(admin, { now: LATE, orgId: ORG, preview: true });
    expect(report.skipped).toBeNull();
    expect(report.orgs[0]!.items).toEqual([
      expect.objectContaining({ orderId: "a", mode: "apagado", outcome: "simulada" }),
      expect.objectContaining({ orderId: "b", variant: "urpi_autoecom:no_contesta", mode: "apagado", outcome: "simulada" }),
    ]);
    expect(h.core.every((c) => c.dry === true)).toBe(true);
    expect(writes).toEqual([]);
    expect(h.telegrams).toEqual([]);
  });

  it("una variante activa tampoco crea en la vista previa", async () => {
    h.coreResult = (input) => ({ outcome: input.dry ? "simulada" : "creada", transport: "AUTOECOM", detail: "x", guide: "AL" });
    const { admin, writes } = seed("activo", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR, preview: true });
    expect(report.orgs[0]!.items[0]).toMatchObject({ mode: "activo", outcome: "simulada" });
    expect(writes).toEqual([]);
  });
});

describe("la alerta y el cron", () => {
  it("la alerta dice la regla y, si quedó en duda, que se revise antes de repetir", () => {
    const text = retryFailureTelegram({
      storeName: "Tienda", orderName: "#KP1", customerName: "Rosa", place: "Surco", variant: "alexis_autoecom:no_contesta",
      outcome: "incierto", error: "timeout", url: "https://k/x",
    });
    expect(text).toContain("Regla: Alexis (Grupo GF) → AUTOECOM · no contesta.");
    expect(text).toContain("Revisa en Aliclik antes de crearla otra vez");
  });

  it("la ruta: secreto, solo producción salvo ?dry=1 (vista previa), y el horario en vercel.json", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/cron/lima-retry-auto/route.ts"), "utf8");
    expect(route).toContain("if (!internalAuthorized(req))");
    expect(route).toContain('if (!dry && process.env.VERCEL_ENV !== "production")');
    expect(route).toContain("runLimaRetryAuto(createAdminSupabase(), { preview: dry })");
    expect(route).toContain("export const maxDuration = 300;");
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons).toContainEqual({ path: "/api/cron/lima-retry-auto", schedule: "23 13-18 * * *" });
  });
});
