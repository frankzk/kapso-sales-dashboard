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
  /** Corre entre la toma del renglón y la relectura (la salud se lee justo antes). */
  onHealth: null as null | (() => void),
  /** Los hechos de la relectura, si cambiaron durante la pasada. */
  later: null as null | ((id: string) => Row | undefined),
  factsCalls: 0,
  /** La clave de Google en el entorno. */
  key: "",
  /** Lo que devuelve `geocodeOrderAddress` para cada pedido. */
  geo: (_order: Row): Row => ({ kind: "ok", lat: -12.1211, lng: -77.0297, precision: "ROOFTOP", cached: false }),
  geocoded: [] as Row[],
  /** La última medición de Lima guardada (`latestGeocodeLimaRun`). */
  latest: null as null | Row,
  /** Pedidos cuyo pin del Master es el punto de Google (`googlePinnedOrderIds`). */
  googlePins: [] as string[],
  /** Hace fallar la lectura de la caché de Google. */
  googlePinsError: null as null | string,
  /** «Pedir la ubicación por WhatsApp» (0324): con qué se llamó y qué devuelve. */
  asks: [] as Row[],
  askResult: (_input: Row): Row | null => ({ outcome: "pedida", detail: "Kapta le pidió su ubicación por WhatsApp." }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: { aliclikWriteEnabled: () => h.write, siteUrl: () => "https://kapta.test", googleGeocodingApiKey: () => h.key, chatbyApiKey: () => "" },
}));
vi.mock("@/lib/geocode-google-server", () => ({
  geocodeOrderAddress: async (_admin: unknown, order: Row, opts: Row) => {
    h.geocoded.push({ ...order, key: opts.key });
    return h.geo(order);
  },
  latestGeocodeLimaRun: async () => h.latest,
  googlePinnedOrderIds: async (_admin: unknown, rows: Row[]) => {
    if (h.googlePinsError) throw new Error(h.googlePinsError);
    return new Set(rows.filter((r) => r.latitude != null && h.googlePins.includes(r.order_id)).map((r) => r.order_id));
  },
}));
vi.mock("@/lib/shipments", () => ({ limaTodayKey: () => "2026-11-04" }));
vi.mock("@/lib/aliclik-guide", () => ({
  aliclikReadScopeFor: async (_admin: unknown, storeId: string) => ({ scope: { client: null, storeIds: [storeId] } }),
}));
vi.mock("@/lib/aliclik-health-access", () => ({
  loadAliclikHealthState: async () => {
    h.onHealth?.();
    return h.health;
  },
}));
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
  loadReproFacts: async (_admin: unknown, ids: string[]) => {
    h.factsCalls += 1;
    const read = (id: string) => (h.factsCalls > 1 && h.later ? h.later(id) : h.facts.get(id));
    return new Map(ids.filter((id) => read(id)).map((id) => [id, read(id)]));
  },
  retryChainOf: (f: Row) => (f.retryChain.state === "siguiente" && !f.open?.agreed_on
    ? { attempt: f.retryChain.attempt, of: f.retryChain.of, next: f.retryChain.next, failedText: "falló", inOffice: false, ready: f.ready !== false }
    : null),
}));
vi.mock("@/lib/lima-retry-chatby-ask-server", () => ({
  askRetryLocation: async (_admin: unknown, input: Row) => {
    h.asks.push(input);
    return h.askResult(input);
  },
}));
vi.mock("@/lib/lima-retry-approve", () => ({
  RETRY_TRANSPORT_LABEL: { autoecom: "AUTOECOM", alidriver: "ALIDRIVER" },
  approveLimaRetry: async (input: Row) => {
    h.core.push(input);
    return h.coreResult(input);
  },
}));

import {
  RETRY_OUTCOME_LABEL,
  RETRY_OUTCOMES_COUNTED,
  RETRY_OUTCOMES_RETRYABLE,
  RETRY_VARIANTS,
  anyRetryVariantOn,
  retryLocationMissing,
  retryNoLocationDetail,
  autoRetryMotive,
  retryCapLeft,
  retryHeldDetail,
  retryKaptaBlockReason,
  retryModes,
  retryPassOpen,
  retryRecheck,
  retryVariantLabel,
  retryVariantOf,
} from "@/lib/lima-retry-auto";
import { aliclikMotiveAllowed, aliclikOutputPolicy } from "@/lib/aliclik-output-policy";
import { LIMA_RETRY_AUTO_FAILED, retryFailureKind, retryFailureTelegram, retryResultDetail, runLimaRetryAuto } from "@/lib/lima-retry-auto-server";

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
    expect(guide).toContain('kind: "envio_programado" | "confirmado_chatby" | "reintento_lima" | "agente_ia";');
    // Una sola copia de las compuertas: la creación llama a la misma función
    // que la simulación, antes de la cotización final, el candado y el POST.
    const create = guide.slice(guide.indexOf("export async function createAliclikGuideFor"));
    const order = [
      "const gates = await aliclikCreateGates(ctx, input, scope, origin);",
      "const preview = await previewAliclikGuideFor(",
      '.from("aliclik_order_requests")\n    .insert(',
    ].map((t) => create.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const gatesFn = guide.slice(guide.indexOf("export async function aliclikCreateGates"), guide.indexOf("export function aliclikRecipientBlock"));
    expect(gatesFn).not.toContain("aliclik_order_requests");
    expect(gatesFn).not.toContain("createOrder(");
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
  /** Hace fallar una lectura o escritura: devuelve el mensaje de error, o null. */
  const ctl = { fail: null as null | ((table: string, op: string, value: any) => string | null) };
  let seq = 100;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let value: any = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let range: [number, number] | null = null;
    const q: any = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
    q.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; };
    q.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; };
    q.is = (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; };
    q.order = () => q;
    q.range = (a: number, b: number) => { range = [a, b]; return q; };
    q.update = (v: any) => { op = "update"; value = v; return q; };
    q.insert = (v: any) => { op = "insert"; value = v; return q; };
    q.upsert = (v: any, o: any = {}) => { op = "upsert"; value = v; upsertOpts = o; return q; };
    q.delete = () => { op = "delete"; return q; };
    const run = () => {
      const failed = ctl.fail?.(table, op, value);
      if (failed) return { data: null, error: { message: failed } };
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
      if (op === "delete") {
        const hit = rows.filter(match);
        db[table] = rows.filter((r) => !match(r));
        return { data: hit, error: null };
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
    q.maybeSingle = () => ({
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve().then(run).then((r: any) => ({ data: r.data?.[0] ?? null, error: r.error })).then(resolve, reject),
    });
    return q;
  };
  return { admin: { from } as never, db, writes, ctl };
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
  // Con coordenada, como un pedido de Shopify; los de WooCommerce sin ella se prueban aparte.
  return {
    order_id: id, store_id: "s1", order_name: `#${id}`, macro_stage: "en_curso", macro_substage: "por_reprogramar_lima",
    coverage: "lima", address: "Av. Larco 345", district: "Miraflores", province: "Lima", region: "Lima",
    latitude: -12.12, longitude: -77.03,
    ...(extra.row ?? {}),
  };
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
  h.onHealth = null;
  h.later = null;
  h.factsCalls = 0;
  h.key = "";
  h.geo = () => ({ kind: "ok", lat: -12.1211, lng: -77.0297, precision: "ROOFTOP", cached: false });
  h.geocoded = [];
  h.latest = null;
  h.googlePins = [];
  h.googlePinsError = null;
  h.asks = [];
  h.askResult = () => ({ outcome: "pedida", detail: "Kapta le pidió su ubicación por WhatsApp." });
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
    expect(route).toContain("runLimaRetryAuto(createAdminSupabase(), { preview: dry, noGeocode: dry })");
    expect(route).toContain("export const maxDuration = 300;");
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons).toContainEqual({ path: "/api/cron/lima-retry-auto", schedule: "23 13-18 * * *" });
  });
});

// ---------------------------------------------------------------------------
// Revisión adversarial del 04-11-2026: lo que cambia mientras corre la pasada,
// las reglas de Kapta que Activo rechaza siempre y la guía creada sin guardar.
// ---------------------------------------------------------------------------

describe("retryRecheck: justo antes de crear, con lo de ahora", () => {
  const raw = next("alexis", "autoecom") as never;
  const base = { chain: { ready: true }, raw, variant: "alexis_autoecom:no_contesta" as const, mode: "activo" as const, claimed: false };
  it("crea solo si todo sigue igual", () => {
    expect(retryRecheck(base)).toEqual({ action: "crear" });
  });
  it("la cadena ya no sigue (A Repro Lima, acuerdo, fuera de la etapa) o falló hoy: suelta", () => {
    expect(retryRecheck({ ...base, chain: null })).toMatchObject({ action: "soltar" });
    expect(retryRecheck({ ...base, raw: { state: "fuera", why: "descartada", failed: null } as never })).toMatchObject({ action: "soltar" });
    expect(retryRecheck({ ...base, chain: { ready: false } })).toEqual({ action: "soltar", reason: "El intento falló hoy: el reintento sale otro día." });
  });
  it("cambió la variante o ya no está en Activo: suelta", () => {
    expect(retryRecheck({ ...base, raw: next("alexis", "autoecom", 3, "no_estaba") as never })).toMatchObject({ action: "soltar" });
    expect(retryRecheck({ ...base, mode: "apagado" })).toEqual({ action: "soltar", reason: "La variante pasó a Apagado durante la pasada." });
    expect(retryRecheck({ ...base, mode: "simulacion" })).toEqual({ action: "soltar", reason: "La variante pasó a Simulación durante la pasada." });
  });
  it("una persona tomó el caso: atendiendo (después de las razones para soltar)", () => {
    expect(retryRecheck({ ...base, claimed: true })).toEqual({ action: "atendiendo" });
    expect(retryRecheck({ ...base, claimed: true, mode: "apagado" })).toMatchObject({ action: "soltar" });
  });
});

describe("la pasada relee el pedido y la variante antes de crear", () => {
  const dismissedNow = (id: string) => ({ ...h.facts.get(id)!, retryChain: { state: "fuera", why: "descartada", failed: null } });

  it("«A Repro Lima» después de cargar: no crea y borra su renglón (no cuenta para el tope)", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    h.later = dismissedNow;
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
    expect(report.orgs[0]).toMatchObject({ capLeft: 5, items: [] });
    expect(report.orgs[0]!.released).toEqual([expect.objectContaining({ orderId: "a", reason: expect.stringContaining("Ya no está en la cadena") })]);
    expect(report.error).toBeNull();
  });

  it("un acuerdo de la tienda después de cargar: tampoco crea", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    h.later = (id) => ({ ...h.facts.get(id)!, open: { episode_key: "ep", agreed_on: "2026-11-05", claimed_by: null, claimed_until: null } });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
  });

  it("una persona toma el caso después de cargar: atendiendo, y se reintenta", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    const open = { episode_key: "ep", claimed_by: "ana", claimed_until: "2026-11-04T15:20:00Z", agreed_on: null };
    h.later = (id) => ({ ...h.facts.get(id)!, open });
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(report.orgs[0]!.items[0]).toMatchObject({ outcome: "atendiendo" });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ mode: "activo", outcome: "atendiendo" })]);
    // Soltó el caso: la pasada siguiente lo toma y crea.
    h.later = null;
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "creada" })]);
  });

  it("la variante se apaga (o pasa a Simulación) durante la pasada: no crea; al volver a Activo, sí", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    h.onHealth = () => { db.lima_retry_auto_variants![0]!.mode = "apagado"; };
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
    expect(report.orgs[0]!.released[0]!.reason).toBe("La variante pasó a Apagado durante la pasada.");
    h.onHealth = null;
    db.lima_retry_auto_variants![0]!.mode = "activo";
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ mode: "activo", outcome: "creada" })]);
  });

  it("el pedido ya no está en el Master al releerlo: no crea", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    h.onHealth = () => { db.order_master = []; };
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
    expect(report.orgs[0]!.released[0]!.reason).toBe("El pedido ya no está en el Master.");
  });

  it("crea con la fila del pedido de ahora, no la de la carga", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    h.onHealth = () => { db.order_master![0]!.address = "Av. Nueva 123"; };
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core[0]!.row).toMatchObject({ order_id: "a", address: "Av. Nueva 123" });
  });

  it("el renglón tomado de una pasada anterior (tope) también se suelta sin dejar «en curso»", async () => {
    const { admin, db } = seed("activo", [order("a")], {
      lima_retry_auto_log: [{ id: 1, org_id: ORG, order_id: "a", lima_day: "2026-11-04", mode: "activo", outcome: "tope", variant: "alexis_autoecom:no_contesta" }],
    });
    h.later = dismissedNow;
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log!.filter((r) => r.outcome === "en_curso")).toEqual([]);
  });
});

describe("una regla de Kapta que Activo rechaza siempre", () => {
  const blocked = "Aliclik exige un adelanto validado de S/ 20 por los antecedentes del cliente. Para exceptuarlo, escribe una justificación corta.";

  it("Activo: fallo, UN aviso, el hecho del fallo y sale de la cadena a Repro Lima (sin persona)", async () => {
    h.coreResult = () => ({ outcome: "fallo", stage: "creacion", transport: "AUTOECOM", error: blocked, locked: false, kaptaBlock: true });
    const { admin, db } = seed("activo", [order("a")]);
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "fallo", detail: `${blocked} Pasó a Repro Lima.` })]);
    expect(h.telegrams).toHaveLength(1);
    expect(h.telegrams[0]).toContain("bloqueado por Kapta: pasó a Repro Lima");
    expect(h.telegrams[0]).toContain("No se reintenta");
    expect(h.telegrams[0]).not.toContain("Créala a mano");
    // Primero sale de la cadena; solo después el aviso y el hecho lo dicen.
    expect(db.order_events).toEqual([
      expect.objectContaining({
        kind: "lima_retry_dismissed", actor: null, source: "system", reason: retryKaptaBlockReason(blocked),
        payload: { attempt: 2, of: 3, transport: "AUTOECOM", why: "bloqueo_kapta", auto: true, variant: "alexis_autoecom:no_contesta" },
      }),
      expect.objectContaining({ kind: LIMA_RETRY_AUTO_FAILED, actor: null, source: "system", payload: expect.objectContaining({ kapta_block: true }) }),
    ]);
  });

  it("un error de Aliclik no lo saca de la cadena: fallo de hoy, se reintenta mañana", async () => {
    h.coreResult = () => ({ outcome: "fallo", stage: "creacion", transport: "AUTOECOM", error: "Aliclik rechazó el pedido: sin stock", locked: false, kaptaBlock: false });
    const { admin, db } = seed("activo", [order("a")]);
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.order_events!.map((e) => e.kind)).toEqual([LIMA_RETRY_AUTO_FAILED]);
    expect(h.telegrams[0]).toContain("Créala a mano");
  });

  it("Simulación: «Activo no la crearía» en vez de «Habría creado la guía», sin hechos ni avisos", async () => {
    h.coreResult = () => ({ outcome: "fallo", stage: "compuertas", transport: "AUTOECOM", kaptaBlock: true, error: `Activo no la crearía: ${blocked}` });
    const { admin, db } = seed("simulacion", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.orgs[0]!.items[0]).toMatchObject({ outcome: "fallo", detail: `Activo no la crearía: ${blocked}` });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ mode: "simulacion", outcome: "fallo" })]);
    expect(db.order_events).toEqual([]);
    expect(h.telegrams).toEqual([]);
  });

  it("el motivo del hecho y el detalle del log", () => {
    expect(retryKaptaBlockReason("Este cliente rechazó en la puerta 2 pedidos.")).toBe(
      "Kapta no deja crear el reintento automático (Este cliente rechazó en la puerta 2 pedidos). Pasa a Repro Lima.",
    );
    // «Pasó a Repro Lima» lo agrega la pasada solo si el hecho quedó escrito.
    expect(retryResultDetail({ outcome: "fallo", stage: "creacion", transport: "AUTOECOM", error: "x.", locked: false, kaptaBlock: true })).toBe("x.");
    expect(retryResultDetail({ outcome: "fallo", stage: "creacion", transport: "AUTOECOM", error: "x.", locked: false, kaptaBlock: false })).toBe("x.");
  });
});

describe("Aliclik la creó pero Kapta no pudo guardarla", () => {
  const error = "El pedido se creó en Aliclik (AL-5) pero no se pudo guardar la guía: timeout de la base";

  it("incierto con su código, cuenta para el tope, y el aviso pide vincularla, no crearla", async () => {
    h.coreResult = () => ({ outcome: "incierto", stage: "creacion", transport: "AUTOECOM", error, locked: false, kaptaBlock: false, guide: "AL-5" });
    const { admin, db } = seed("activo", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.orgs[0]).toMatchObject({ capLeft: 4 });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "incierto", guide_code: "AL-5" })]);
    expect(h.telegrams).toHaveLength(1);
    expect(h.telegrams[0]).toContain("creado en Aliclik pero sin guardar en Kapta");
    expect(h.telegrams[0]).toContain("La guía AL-5 ya existe en Aliclik");
    expect(h.telegrams[0]).toContain("No la crees otra vez");
    expect(h.telegrams[0]).not.toContain("Créala a mano");
    expect(db.order_events).toEqual([expect.objectContaining({
      kind: LIMA_RETRY_AUTO_FAILED, guide_code: "AL-5", note: expect.stringContaining("no la crees otra vez"),
      payload: expect.objectContaining({ outcome: "incierto", guide: "AL-5" }),
    })]);
    // No es una regla de Kapta: no sale de la cadena.
    expect(db.order_events!.some((e) => e.kind === "lima_retry_dismissed")).toBe(false);
  });

  it("la clase de aviso", () => {
    expect(retryFailureKind({ outcome: "incierto", guide: "AL-5" })).toBe("sin_vincular");
    expect(retryFailureKind({ outcome: "incierto" })).toBe("incierto");
    expect(retryFailureKind({ outcome: "fallo", kaptaBlock: true })).toBe("bloqueo_kapta");
    expect(retryFailureKind({ outcome: "fallo" })).toBe("fallo");
  });
});

describe("«Simular ahora» se corta antes que la página", () => {
  it("con el tiempo de la vista previa agotado, para y dice `tiempo`, con lo evaluado", async () => {
    let clock = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      // Cada cotización tarda 90 s: la tercera ya no entra en los 200 s.
      h.coreResult = () => {
        clock += 90_000;
        return { outcome: "simulada", transport: "AUTOECOM", detail: "x" };
      };
      const { admin, writes } = seed("simulacion", [order("a", "2026-11-01T17:00:00Z"), order("b", "2026-11-02T17:00:00Z"), order("c", "2026-11-03T17:00:00Z"), order("d", "2026-11-03T18:00:00Z")]);
      const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR, orgId: ORG, preview: true });
      expect(report.stopped).toBe("tiempo");
      expect(report.orgs[0]!.items.map((i) => i.orderId)).toEqual(["a", "b", "c"]);
      expect(writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("la página tiene 300 s y la acción no tumba el panel si se corta", () => {
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/automatizaciones/page.tsx"), "utf8");
    expect(page).toContain("export const maxDuration = 300;");
    const server = readFileSync(resolve(process.cwd(), "lib/lima-retry-auto-server.ts"), "utf8");
    expect(server).toContain("const PREVIEW_TIME_BUDGET_MS = 200_000;");
    const panel = readFileSync(resolve(process.cwd(), "components/automations-panel.tsx"), "utf8");
    expect(panel).toContain("La simulación se cortó por tiempo: muestra lo evaluado");
    expect(panel).toContain("No se pudo guardar. Revisa la conexión y vuelve a intentar.");
  });
});

// ---------------------------------------------------------------------------
// Segunda verificación del 04-11-2026: el candado de otra creación, la guía de
// Aliclik sin guardar, las excepciones entre la toma y la creación y el orden
// de «A Repro Lima».
// ---------------------------------------------------------------------------

describe("el candado de otra creación y la guía sin guardar", () => {
  it("el candado lo tiene otra creación: atendiendo (no cuenta ni se queda «Creándose»), y se reintenta", async () => {
    h.coreResult = () => ({ outcome: "en_curso", stage: "creacion", transport: "AUTOECOM", error: "Hay otra creación en curso.", locked: true, kaptaBlock: false });
    const { admin, db } = seed("activo", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.orgs[0]).toMatchObject({ capLeft: 5 });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "atendiendo", detail: "Hay otra creación en curso." })]);
    h.coreResult = () => ({ outcome: "creada", transport: "AUTOECOM", guide: "AL-9" });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "creada" })]);
  });

  const unsaved = { id: "i1", order_id: "a", status: "sent", order_number: "AL-5", released_at: null };

  it("Activo: una guía que Aliclik creó y Kapta no guardó no se cotiza, no se toma ni cuenta; se informa", async () => {
    const { admin, db } = seed("activo", [order("a")], { aliclik_order_requests: [unsaved], shipments: [] });
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
    expect(report.orgs[0]).toMatchObject({ capLeft: 5, items: [] });
    expect(report.orgs[0]!.held).toEqual([expect.objectContaining({ orderId: "a", detail: expect.stringContaining("Aliclik ya tiene la guía AL-5") })]);
    expect(h.telegrams).toEqual([]);
  });

  it("con su salida guardada no es eso: se cotiza como siempre", async () => {
    const { admin } = seed("activo", [order("a")], {
      aliclik_order_requests: [unsaved],
      shipments: [{ order_id: "a", courier: "aliclik", guide_code: "AL-5", external_order_number: "AL-5" }],
    });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
  });

  it("Simulación y «Simular ahora»: lo dicen como «Puede estar creada», sin cotizar", async () => {
    const sim = seed("simulacion", [order("a")], { aliclik_order_requests: [unsaved] });
    await runLimaRetryAuto(sim.admin, { now: OPEN_HOUR });
    expect(sim.db.lima_retry_auto_log).toEqual([expect.objectContaining({ mode: "simulacion", outcome: "incierto", detail: expect.stringContaining("AL-5") })]);
    const prev = seed("apagado", [order("a")], { aliclik_order_requests: [unsaved] });
    const report = await runLimaRetryAuto(prev.admin, { now: LATE, orgId: ORG, preview: true });
    expect(report.orgs[0]!.items[0]).toMatchObject({ outcome: "incierto" });
    expect(h.core).toEqual([]);
  });

  it("una creación aparece entre la carga y la creación: suelta sin crear", async () => {
    const { admin, db } = seed("activo", [order("a")]);
    h.onHealth = () => { db.aliclik_order_requests = [{ ...unsaved, status: "pending", order_number: null }]; };
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([]);
    expect(report.orgs[0]!.released[0]!.reason).toContain("sin respuesta o en curso");
  });

  it("retryHeldDetail", () => {
    expect(retryHeldDetail({ status: "sent", orderNumber: "AL-5" })).toContain("vincúlala o revísala a mano");
    expect(retryHeldDetail({ status: "pending", orderNumber: null })).toContain("revisa en Aliclik antes de crear otra");
  });
});

describe("una excepción entre la toma y la creación", () => {
  it("suelta el candado y sigue con el siguiente pedido", async () => {
    const { admin, db, ctl } = seed("activo", [order("a", "2026-11-01T17:00:00Z"), order("b", "2026-11-02T17:00:00Z")]);
    let once = true;
    // El tope no se puede leer para el primero.
    ctl.fail = (table, op) => (table === "lima_retry_auto_log" && op === "select" && once ? ((once = false), "sin conexión") : null);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core.map((c) => c.row.order_id)).toEqual(["b"]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ order_id: "b", outcome: "creada" })]);
    expect(report.error).toContain("No se pudo preparar #a");
  });

  it("si no se puede borrar el renglón, queda para reintentar sin contar", async () => {
    const { admin, db, ctl } = seed("activo", [order("a")]);
    let once = true;
    ctl.fail = (table, op) => {
      if (table !== "lima_retry_auto_log") return null;
      if (op === "delete") return "sin permiso";
      if (op === "select" && once) return ((once = false), "sin conexión");
      return null;
    };
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "esperando_aliclik", detail: expect.stringContaining("sin conexión") })]);
    expect(report.orgs[0]).toMatchObject({ capLeft: 5 });
    // La pasada siguiente lo vuelve a tomar.
    ctl.fail = null;
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toHaveLength(1);
  });

  it("si la creación lanza, queda en duda (pudo pasar el POST), avisa y sigue", async () => {
    let n = 0;
    h.coreResult = () => {
      n += 1;
      if (n === 1) throw new Error("socket hang up");
      return { outcome: "creada", transport: "AUTOECOM", guide: "AL-9" };
    };
    const { admin, db } = seed("activo", [order("a", "2026-11-01T17:00:00Z"), order("b", "2026-11-02T17:00:00Z")]);
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.lima_retry_auto_log).toEqual([
      expect.objectContaining({ order_id: "a", outcome: "incierto", detail: "Error inesperado al crear: socket hang up" }),
      expect.objectContaining({ order_id: "b", outcome: "creada" }),
    ]);
    expect(h.telegrams).toHaveLength(1);
    expect(h.telegrams[0]).toContain("Revisa en Aliclik antes de crearla otra vez");
  });
});

describe("una regla de Kapta: «pasó a Repro Lima» solo si quedó escrito", () => {
  it("si el hecho de «A Repro Lima» no se pudo escribir, el log y el aviso no lo dicen", async () => {
    h.coreResult = () => ({ outcome: "fallo", stage: "creacion", transport: "AUTOECOM", error: "Venta anulada.", locked: false, kaptaBlock: true });
    const { admin, db, ctl } = seed("activo", [order("a")]);
    ctl.fail = (table, op, value) => (table === "order_events" && op === "insert" && value?.kind === "lima_retry_dismissed" ? "sin permiso" : null);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "fallo", detail: "Venta anulada. No se pudo pasar a Repro Lima: sin permiso." })]);
    expect(h.telegrams[0]).not.toContain("pasó a Repro Lima");
    expect(h.telegrams[0]).toContain("No se pudo pasar a Repro Lima: sin permiso");
    expect(db.order_events).toEqual([expect.objectContaining({ kind: LIMA_RETRY_AUTO_FAILED, payload: expect.not.objectContaining({ kapta_block: true }) })]);
    expect(report.error).toContain("No se pudo pasar #a a Repro Lima");
  });
});

// ---------------------------------------------------------------------------
// Sin ubicación y la ubicación por dirección (Google), 05-11-2026
// ---------------------------------------------------------------------------

describe("«Sin ubicación»: lo puro", () => {
  it("se reintenta, no cuenta para el tope y tiene su etiqueta", () => {
    expect(RETRY_OUTCOMES_RETRYABLE).toContain("sin_ubicacion");
    expect(RETRY_OUTCOMES_COUNTED).not.toContain("sin_ubicacion");
    expect(RETRY_OUTCOME_LABEL.sin_ubicacion).toBe("Sin ubicación: falta la coordenada");
  });

  it("falta la coordenada, o el pin de GOOGLE no lo respalda el pedido; un pin del pedido sigue siendo fallo", () => {
    expect(retryLocationMissing({ ok: false, needsCoordinate: true }, "pedido")).toContain("no tiene coordenada");
    expect(retryLocationMissing({ ok: false, pinSinCorroborar: "El pin cae en Cusco." }, "google"))
      .toBe("La ubicación por dirección (Google) no la respalda el pedido: El pin cae en Cusco. Pon la ubicación de la clienta en la ficha del pedido («Corregir ubicación») y apruébalo en Repro Lima.");
    expect(retryLocationMissing({ ok: false, pinSinCorroborar: "El pin cae en Cusco." }, "pedido")).toBeNull();
    expect(retryLocationMissing({ ok: false }, "google")).toBeNull();
    expect(retryLocationMissing({ ok: true }, "google")).toBeNull();
  });

  it("el detalle dice por qué no hubo coordenada", () => {
    expect(retryNoLocationDetail("sin_edificio")).toContain("Google no dio el edificio");
    expect(retryNoLocationDetail("sin_cupo")).toContain("cupo diario de Google");
    // «Aprobar» de Repro Lima no tiene dónde pegarla: se pone en la ficha del pedido.
    expect(retryNoLocationDetail("apagado")).toBe(
      "El pedido no tiene coordenada y Aliclik la exige. Pon la ubicación de la clienta en la ficha del pedido («Corregir ubicación», con el enlace de Maps) y apruébalo en Repro Lima.",
    );
  });
});

/** Una medición de Lima que cumple B con el edificio. */
const MEETS_B = { at: "2026-11-05T15:00:00Z", summary: { ranAt: "2026-11-05T15:00:00Z", sampled: 120, passed: 60, rooftop: 40, rooftopWithin300Pct: 95, rejections: {} } };

function noPin(id: string) {
  return order(id, undefined, "alexis", { row: { latitude: null, longitude: null } });
}

describe("la pasada sin coordenada", () => {
  it("con el interruptor apagado: «Sin ubicación», sin Google, sin cotizar, sin aviso ni hecho; se reintenta y no cuenta", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    const { admin, db } = seed("activo", [noPin("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.geocoded).toEqual([]);
    expect(h.core).toEqual([]);
    expect(report.orgs[0]!.items).toEqual([expect.objectContaining({ orderId: "a", outcome: "sin_ubicacion" })]);
    expect(report.orgs[0]!.capLeft).toBe(5);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "sin_ubicacion", mode: "activo" })]);
    expect(db.order_events).toEqual([]);
    expect(h.telegrams).toEqual([]);
    // La pasada siguiente lo vuelve a tomar (se reintenta).
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.lima_retry_auto_log).toHaveLength(1);
    expect(db.lima_retry_auto_log![0]).toMatchObject({ outcome: "sin_ubicacion" });
    expect(h.telegrams).toEqual([]);
  });

  it("el núcleo dice «Sin ubicación» (Aliclik pide la coordenada): tampoco avisa ni deja hecho ni cuenta", async () => {
    h.coreResult = () => ({ outcome: "sin_ubicacion", stage: "ubicacion", transport: "AUTOECOM", error: "Falta la coordenada." });
    const { admin, db } = seed("activo", [order("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(report.orgs[0]).toMatchObject({ capLeft: 5 });
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "sin_ubicacion", detail: "Falta la coordenada." })]);
    expect(db.order_events).toEqual([]);
    expect(h.telegrams).toEqual([]);
  });

  it("encendido, con clave y la medición que cumple B: busca en Google UNA vez y cotiza y crea con ese punto", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.coreResult = (input) => ({ outcome: "creada", transport: "AUTOECOM", guide: "AL-9", coordinateNote: input.coordinate ? "Con la ubicación por dirección (Google, edificio)." : null });
    const { admin, db } = seed("activo", [noPin("a"), order("b", "2026-11-03T17:00:00Z")], {
      lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }],
    });
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    // Solo el que no tiene coordenada va a Google; a Google van la dirección, no el pedido entero.
    expect(h.geocoded).toEqual([{ order_id: "a", store_id: "s1", address: "Av. Larco 345", district: "Miraflores", province: "Lima", region: "Lima", key: "k" }]);
    expect(h.core.find((c) => c.row.order_id === "a")).toMatchObject({ dry: false, coordinate: { value: "-12.1211, -77.0297", source: "google" } });
    expect(h.core.find((c) => c.row.order_id === "b")!.coordinate).toBeUndefined();
    expect(db.lima_retry_auto_log!.find((r) => r.order_id === "a")).toMatchObject({ outcome: "creada", detail: "Con la ubicación por dirección (Google, edificio)." });
    expect(report.geocode).toEqual({ lookups: 1, quotaHit: false });
  });

  it("en Simulación y en «Simular ahora» también usa Google", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.coreResult = () => ({ outcome: "simulada", transport: "AUTOECOM", detail: "x" });
    const settings = { lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }] };
    const sim = seed("simulacion", [noPin("a")], settings);
    await runLimaRetryAuto(sim.admin, { now: OPEN_HOUR });
    expect(h.core[0]).toMatchObject({ dry: true, coordinate: { source: "google" } });
    h.core = [];
    const prev = seed("apagado", [noPin("a")], settings);
    await runLimaRetryAuto(prev.admin, { now: LATE, orgId: ORG, preview: true });
    expect(h.core[0]).toMatchObject({ dry: true, coordinate: { source: "google" } });
  });

  it("encendido pero sin clave, o con una última medición que no cumple B: no usa Google", async () => {
    const settings = { lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }] };
    h.latest = MEETS_B;
    await runLimaRetryAuto(seed("activo", [noPin("a")], settings).admin, { now: OPEN_HOUR });
    expect(h.geocoded).toEqual([]);
    h.key = "k";
    h.latest = { ...MEETS_B, summary: { ...MEETS_B.summary, rooftopWithin300Pct: 85 } };
    const run = await runLimaRetryAuto(seed("activo", [noPin("a")], settings).admin, { now: OPEN_HOUR });
    expect(h.geocoded).toEqual([]);
    expect(run.orgs[0]!.items[0]).toMatchObject({ outcome: "sin_ubicacion" });
  });

  it("Google no da el edificio: «Sin ubicación» con el motivo, sin cotizar", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.geo = () => ({ kind: "rejected", reason: "impreciso", precision: "RANGE_INTERPOLATED", cached: false });
    const { admin, db } = seed("activo", [noPin("a")], { lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }] });
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "sin_ubicacion", detail: expect.stringContaining("Google no dio el edificio") })]);
    expect(h.telegrams).toEqual([]);
  });

  it("se acaba el cupo de Google: no se le pregunta más en la pasada y lo que falta queda «Sin ubicación»", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.coreResult = () => ({ outcome: "simulada", transport: "AUTOECOM", detail: "x" });
    h.geo = () => ({ kind: "unavailable", reason: "sin_cupo" });
    const rows = [noPin("a"), noPin("b"), noPin("c")];
    const { admin } = seed("simulacion", rows, { lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }] });
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.geocoded).toHaveLength(1);
    expect(report.geocode).toEqual({ lookups: 1, quotaHit: true });
    expect(report.orgs[0]!.items.map((i) => i.outcome)).toEqual(["sin_ubicacion", "sin_ubicacion", "sin_ubicacion"]);
    expect(report.orgs[0]!.items.every((i) => i.detail?.includes("cupo diario de Google"))).toBe(true);
    expect(h.core).toEqual([]);
  });

  it("el motor solo pasa la coordenada de Google al núcleo cuando el pedido no trae la suya (o la suya es la de Google)", () => {
    // La regla vive en lib/lima-retry-location.ts y la comparte «Aprobar» (owner, 08-11-2026).
    const server = readFileSync(resolve(process.cwd(), "lib/lima-retry-location.ts"), "utf8");
    expect(server).toContain("google = (await googlePinnedOrderIds(admin, [row])).has(row.order_id);");
    // El `?dry=1` del cron no busca en Google.
    const route = readFileSync(resolve(process.cwd(), "app/api/cron/lima-retry-auto/route.ts"), "utf8");
    expect(route).toContain("runLimaRetryAuto(createAdminSupabase(), { preview: dry, noGeocode: dry })");
    // «Aprobar» (la acción manual) busca la ubicación con la misma regla y el mismo candado (08-11-2026).
    const manual = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/repro-lima/retry-actions.ts"), "utf8");
    expect(manual).toContain("const where = await locateRetryOrder(admin, row, await retryGeocodeKeyForStore(admin, row.store_id), {");
  });
});

describe("«Pedir la ubicación por WhatsApp» en la pasada (0324, owner 08-11-2026)", () => {
  const withAsk = (mode: string) => ({ lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, chatby_ask_mode: mode }] });

  it("Apagado o sin la 0324: no se llama", async () => {
    await runLimaRetryAuto(seed("activo", [noPin("a")]).admin, { now: OPEN_HOUR });
    await runLimaRetryAuto(seed("activo", [noPin("a")], withAsk("apagado")).admin, { now: OPEN_HOUR });
    expect(h.asks).toEqual([]);
  });

  it("al llegar a «Sin ubicación» la pide, con el episodio del intento que falló, y el log lo dice; no cuenta para el tope", async () => {
    const { admin, db } = seed("activo", [noPin("a")], withAsk("activo"));
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.asks).toEqual([expect.objectContaining({
      orgId: ORG, episodeAt: "2026-11-02T17:00:00Z", attempt: 2, of: 3, mode: "activo", dry: false,
      row: expect.objectContaining({ order_id: "a" }),
    })]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({
      outcome: "sin_ubicacion", detail: expect.stringMatching(/«Corregir ubicación».*Kapta le pidió su ubicación por WhatsApp\.$/),
    })]);
    expect(report.chatbyAsk).toEqual({ sent: 1, simulated: 0 });
    expect(report.orgs[0]!.capLeft).toBe(5);
    expect(h.core).toEqual([]);
  });

  it("en la variante en Simulación también, y en «Simular ahora» nunca manda (dry)", async () => {
    h.askResult = (input) => (input.dry ? { outcome: "simulada", detail: "Habría pedido su ubicación por WhatsApp." } : { outcome: "pedida", detail: "Kapta le pidió su ubicación por WhatsApp." });
    const sim = seed("simulacion", [noPin("a")], withAsk("activo"));
    await runLimaRetryAuto(sim.admin, { now: OPEN_HOUR });
    expect(h.asks[0]).toMatchObject({ dry: false });
    h.asks = [];
    const prev = seed("apagado", [noPin("a")], withAsk("activo"));
    const report = await runLimaRetryAuto(prev.admin, { now: LATE, orgId: ORG, preview: true });
    expect(h.asks).toEqual([expect.objectContaining({ dry: true })]);
    expect(report.chatbyAsk).toEqual({ sent: 0, simulated: 1 });
    expect(report.orgs[0]!.items[0]!.detail).toContain("Habría pedido su ubicación por WhatsApp.");
  });

  it("no con el pin del pedido, ni con el caso tomado, ni con un error de la ubicación, ni en el `?dry=1` del cron", async () => {
    await runLimaRetryAuto(seed("activo", [order("a")], withAsk("activo")).admin, { now: OPEN_HOUR });
    h.facts.clear();
    h.googlePinsError = "caída";
    const pinned = order("b", undefined, "alexis", { row: { latitude: -12.1, longitude: -77.0, geo_source: "courier" } });
    await runLimaRetryAuto(seed("activo", [pinned], withAsk("activo")).admin, { now: OPEN_HOUR });
    h.googlePinsError = null;
    await runLimaRetryAuto(seed("apagado", [noPin("c")], withAsk("activo")).admin, { now: LATE, orgId: ORG, preview: true, noGeocode: true });
    // El caso tomado en Repro Lima: en Activo y en Simulación.
    const open = { episode_key: "ep", claimed_by: "ana", claimed_until: "2026-11-04T15:20:00Z", agreed_on: null };
    const claimed = () => order("d", undefined, "alexis", { open, row: { latitude: null, longitude: null } });
    await runLimaRetryAuto(seed("activo", [claimed()], withAsk("activo")).admin, { now: OPEN_HOUR });
    await runLimaRetryAuto(seed("simulacion", [claimed()], withAsk("activo")).admin, { now: OPEN_HOUR });
    expect(h.asks).toEqual([]);
  });

  it("si la pedida no devuelve nada (Apagado adentro), el log queda como antes", async () => {
    h.askResult = () => null;
    const { admin, db } = seed("activo", [noPin("a")], withAsk("simulacion"));
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(db.lima_retry_auto_log![0]!.detail).toBe(retryNoLocationDetail("apagado"));
  });
});

describe("el reintento siguiente a una guía creada con Google", () => {
  // La guía del reintento 2 se creó con el punto de Google: la guía lo guarda y
  // el Master lo toma como pin del pedido. El reintento 3 ve una coordenada,
  // pero es la de Google, no la de la clienta.
  const googlePinned = (id: string) => order(id, undefined, "alexis", { row: { latitude: -12.1211, longitude: -77.0297, geo_source: "courier" } });
  const ON = { lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }] };

  it("con el interruptor apagado no usa ese punto: «Sin ubicación», sin cotizar, sin aviso ni hecho", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.googlePins = ["a"];
    const { admin, db } = seed("activo", [googlePinned("a")]);
    const report = await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(h.geocoded).toEqual([]);
    expect(report.orgs[0]!.items).toEqual([expect.objectContaining({ orderId: "a", outcome: "sin_ubicacion" })]);
    expect(report.orgs[0]!.capLeft).toBe(5);
    expect(db.order_events).toEqual([]);
    expect(h.telegrams).toEqual([]);
  });

  it("con una medición nueva que ya no cumple B, tampoco", async () => {
    h.key = "k";
    h.latest = { ...MEETS_B, summary: { ...MEETS_B.summary, rooftopWithin300Pct: 85 } };
    h.googlePins = ["a"];
    const run = await runLimaRetryAuto(seed("activo", [googlePinned("a")], ON).admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(run.orgs[0]!.items[0]).toMatchObject({ outcome: "sin_ubicacion" });
  });

  it("encendido y cumpliendo B: lo trata como Google (la caché), con la nota en el log", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.googlePins = ["a"];
    h.geo = () => ({ kind: "ok", lat: -12.1211, lng: -77.0297, precision: "ROOFTOP", cached: true });
    h.coreResult = (input) => ({ outcome: "creada", transport: "ALIDRIVER", guide: "AL-10", coordinateNote: input.coordinate ? "Con la ubicación por dirección (Google, edificio)." : null });
    const { admin, db } = seed("activo", [googlePinned("a")], ON);
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.geocoded).toHaveLength(1);
    expect(h.core[0]).toMatchObject({ coordinate: { value: "-12.1211, -77.0297", source: "google" } });
    expect(db.lima_retry_auto_log![0]).toMatchObject({ outcome: "creada", detail: "Con la ubicación por dirección (Google, edificio)." });
  });

  it("un pin propio (no es el de Google) se cotiza tal cual, sin Google", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    h.coreResult = () => ({ outcome: "simulada", transport: "AUTOECOM", detail: "x" });
    await runLimaRetryAuto(seed("simulacion", [googlePinned("a")], ON).admin, { now: OPEN_HOUR });
    expect(h.geocoded).toEqual([]);
    expect(h.core[0]!.coordinate).toBeUndefined();
  });

  it("si no se pudo leer la caché de Google, no cotiza con ese pin: «Sin ubicación» y se reintenta", async () => {
    h.googlePinsError = "boom";
    const { admin, db } = seed("activo", [googlePinned("a")]);
    await runLimaRetryAuto(admin, { now: OPEN_HOUR });
    expect(h.core).toEqual([]);
    expect(db.lima_retry_auto_log).toEqual([expect.objectContaining({ outcome: "sin_ubicacion" })]);
    expect(h.telegrams).toEqual([]);
  });
});

describe("el ?dry=1 del cron no busca en Google", () => {
  it("con `noGeocode`, ni con el interruptor encendido consulta Google", async () => {
    h.key = "k";
    h.latest = MEETS_B;
    const settings = { lima_retry_auto_settings: [{ org_id: ORG, daily_cap: 5, geocode_enabled: true }] };
    const report = await runLimaRetryAuto(seed("simulacion", [noPin("a")], settings).admin, { now: LATE, preview: true, noGeocode: true });
    expect(h.geocoded).toEqual([]);
    expect(report.orgs[0]!.items[0]).toMatchObject({ outcome: "sin_ubicacion" });
  });
});
