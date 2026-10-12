// La clave de recojo del listado de Shalom Pro en Cotejar Shalom (MOM §12,
// 12-10-2026). El 12-10-2026 a las 01:12 UTC el cotejo vinculó 7 guías
// (#KP131631 … #KP138154) sin clave: el listado trae `pickup_code`, pero nadie
// había comprobado que fuera la clave. Ahora se compara en cada pasada con las
// claves que Kapta mandó al crear por API y, solo si coinciden, se usa: al
// vincular y para rellenar las guías manuales vivas que no la tienen.
//
// Una pasada entera contra una base de mentira, con el cifrado de verdad. Lo
// que más importa: NINGUNA clave sale en el informe, en la línea de tiempo ni
// en la bitácora.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, generateEncryptionKey } from "@/lib/crypto";
import type { NormalizedManualShalomGuide } from "@/lib/shalom/manual";
import type { ExistingGuideOrder, RegisterExistingGuideOptions } from "@/lib/shalom/register-guide";
import type { ShalomAccountOrder } from "@/lib/shalom/types";

process.env.ENCRYPTION_KEY = generateEncryptionKey();

const h = vi.hoisted(() => ({
  listing: [] as unknown[],
  register: vi.fn(),
  recompute: vi.fn(async () => ({ requested: 0, written: 0 })),
}));

vi.mock("@/lib/shalom/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shalom/session")>()),
  // Sin red: el listado entero cabe en la página 1, y la 2 llega vacía.
  readWithFreshSession: async (_a: unknown, _s: unknown, _st: unknown, run: (c: unknown) => Promise<unknown>) =>
    run({
      ordersSince: async (_from: string, _perPage: number, opts: { page?: number } = {}) =>
        (opts.page ?? 1) === 1 ? h.listing : [],
    }),
}));
vi.mock("@/lib/order-master", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-master")>()),
  recomputeOrderMasterSafe: h.recompute,
}));
vi.mock("@/lib/shalom/register-guide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shalom/register-guide")>()),
  registerExistingShalomGuide: h.register,
}));
vi.mock("@/lib/route-output-fill", () => ({
  writeCourierGuide: async () => ({ shipmentId: "s-nueva", filled: false, outputCode: null }),
}));

import { cotejarShalom, KEY_REGISTERED_EVENT, LISTING_KEY_NOTE } from "@/lib/shalom/account-cotejo";

type Row = Record<string, unknown>;
interface Write {
  table: string;
  op: "insert" | "upsert";
  row: Row;
  opts?: Row;
}

/** Lo justo de PostgREST para una pasada: filtros, inserciones y upserts. */
function fakeDb(tables: Record<string, Row[]>, fail: { upsert?: string } = {}) {
  const writes: Write[] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let write: Write | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let single = false;
    const run = () => {
      const rows = (tables[table] ??= []);
      if (write?.op === "insert") {
        rows.push({ ...write.row });
        writes.push(write);
        return { data: null, error: null };
      }
      if (write?.op === "upsert") {
        if (fail.upsert) return { data: null, error: { message: fail.upsert } };
        writes.push(write);
        const key = String(write.opts?.onConflict ?? "id");
        const existing = rows.find((r) => r[key] === write!.row[key]);
        if (existing && write.opts?.ignoreDuplicates) return { data: [], error: null };
        if (existing) Object.assign(existing, write.row);
        else rows.push({ ...write.row });
        return { data: [{ ...write.row }], error: null };
      }
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return { data: single ? (out[0] ?? null) : out, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      gte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) >= v), b),
      // Solo se usa como `.not(col, "is", null)`.
      not: (c: string) => (filters.push((r) => r[c] != null), b),
      order: () => b,
      range: (a: number, z: number) => ((range = [a, z]), b),
      limit: (n: number) => ((limit = n), b),
      insert: (row: Row) => ((write = { table, op: "insert", row }), b),
      upsert: (row: Row, opts: Row = {}) => ((write = { table, op: "upsert", row, opts }), b),
      maybeSingle: async () => ((single = true), run()),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
    };
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient, writes, tables };
}

const NOW = new Date("2026-10-12T03:00:00Z");
const STORE = "store-kenku";
const pad = (i: number, n: number) => String(i).padStart(n, "0");

// Las claves que Kapta eligió para doce guías de la API, y las del listado.
const CLAVES_API = ["4821", "5937", "7046", "8152", "2968", "6083", "3719", "9405", "1586", "6274", "4093", "8530"];
const CLAVE_CANDIDATO = "5826";
const CLAVE_SIN_CLAVE = "7391";
const CLAVE_LISTADO_CON_CLAVE = "9157";
const CLAVE_YA_GUARDADA = "4862";
const CLAVE_ENTREGADA = "2648";
const TODAS = [...CLAVES_API, CLAVE_CANDIDATO, CLAVE_SIN_CLAVE, CLAVE_LISTADO_CON_CLAVE, CLAVE_YA_GUARDADA, CLAVE_ENTREGADA];

function order(id: string, over: Row = {}): Row {
  return {
    order_id: id,
    store_id: STORE,
    order_name: `#${id}`,
    order_created_at: "2026-09-24T10:00:00Z",
    customer_name: "Cliente",
    customer_phone: null,
    district: "Arequipa",
    province: "Arequipa",
    region: "Arequipa",
    payment_state: "pago_completo",
    macro_stage: "cierre",
    macro_substage: "cerrado",
    ...over,
  };
}

function manualShipment(id: string, orderId: string, guide: string, over: Row = {}): Row {
  return {
    id,
    order_id: orderId,
    store_id: STORE,
    courier: "shalom",
    created_via: "shalom_pro_manual",
    delivery_status: "pendiente",
    guide_code: guide,
    shalom_ose_id: null,
    created_at: "2026-10-12T01:12:00Z",
    ...over,
  };
}

/**
 * La cuenta de Kenku: doce guías de la API para comprobar el listado, un
 * pedido que espera su guía (#KP140001) y cuatro guías manuales — una
 * vinculada sin clave, una con su clave ya puesta, una con una «clave» que no
 * es clave y una ya entregada.
 */
function world(opts: { listingKeyIsTheKey: boolean }) {
  const api = CLAVES_API.map((key, i) => ({ key, i, guide: `91${pad(i, 6)}`, orderId: `o-api-${i}` }));
  const tables: Record<string, Row[]> = {
    stores: [{ id: STORE, org_id: "org-1", shalom_pro_email: "ops@kenku.pe", shalom_pro_password_enc: "cifrada" }],
    order_master: [
      order("KP140001", {
        order_id: "o-cand",
        order_name: "#KP140001",
        order_created_at: "2026-10-01T15:00:00Z",
        customer_name: "Rosa Quispe",
        customer_phone: "51987654321",
        payment_state: "adelanto_validado",
        macro_stage: "preparacion",
        macro_substage: "por_generar_rotulo",
      }),
      ...api.map((a) => order(a.orderId, { customer_phone: `5191000${pad(a.i, 4)}` })),
      order("o-sin-clave", { order_created_at: "2026-09-20T10:00:00Z", customer_phone: "51955000002" }),
      order("o-con-clave", { order_created_at: "2026-09-26T10:00:00Z", customer_phone: "51955000003" }),
      order("o-mala", { order_created_at: "2026-09-27T10:00:00Z", customer_phone: "51955000005" }),
      order("o-entregada", { order_created_at: "2026-09-05T10:00:00Z", customer_phone: "51955000004" }),
    ],
    shalom_order_drafts: [
      { order_id: "o-cand", store_id: STORE, document: "45678912" },
      ...api.map((a) => ({ order_id: a.orderId, store_id: STORE, document: `4100${pad(a.i, 4)}` })),
    ],
    shipments: [
      ...api.map((a) => ({
        id: `s-api-${a.i}`,
        order_id: a.orderId,
        store_id: STORE,
        courier: "shalom",
        created_via: "shalom_pro_api",
        delivery_status: "entregado",
        guide_code: a.guide,
        shalom_ose_id: null,
        created_at: "2026-09-25T12:00:00Z",
      })),
      manualShipment("s-sin-clave", "o-sin-clave", "93000002"),
      manualShipment("s-con-clave", "o-con-clave", "93000003"),
      manualShipment("s-mala", "o-mala", "93000005"),
      manualShipment("s-entregada", "o-entregada", "93000004", { delivery_status: "entregado", created_at: "2026-09-10T12:00:00Z" }),
    ],
    shalom_pickup_keys: [
      ...api.map((a) => ({ order_id: a.orderId, store_id: STORE, key_enc: encrypt(a.key), created_by: "u-api" })),
      { order_id: "o-con-clave", store_id: STORE, key_enc: encrypt(CLAVE_YA_GUARDADA), created_by: "u-ana" },
    ],
    order_events: [],
  };
  const listing: ShalomAccountOrder[] = [
    ...api.map((a) => ({
      id: 100 + a.i,
      guia: a.guide,
      created_at: "2026-09-25T12:00:00Z",
      receiver: { document: `4100${pad(a.i, 4)}`, phone: `5191000${pad(a.i, 4)}`, full_name: "CLIENTE" },
      // Si el campo no fuera la clave: la de otra guía.
      pickup_code: opts.listingKeyIsTheKey ? a.key : CLAVES_API[(a.i + 1) % CLAVES_API.length]!,
    })),
    {
      id: 200,
      guia: "93000001",
      codigo: "77PH",
      serie: "V872",
      created_at: "2026-10-03T10:00:00Z",
      receiver: { document: "45678912", phone: "51987654321", full_name: "ROSA QUISPE" },
      pickup_code: CLAVE_CANDIDATO,
    },
    { id: 201, guia: "93000002", created_at: "2026-09-22T10:00:00Z", receiver: { document: "47000002" }, pickup_code: CLAVE_SIN_CLAVE },
    { id: 202, guia: "93000003", created_at: "2026-09-27T10:00:00Z", receiver: { document: "47000003" }, pickup_code: CLAVE_LISTADO_CON_CLAVE },
    { id: 203, guia: "93000004", created_at: "2026-09-06T10:00:00Z", receiver: { document: "47000004" }, pickup_code: CLAVE_ENTREGADA },
    { id: 204, guia: "93000005", created_at: "2026-09-28T10:00:00Z", receiver: { document: "47000005" }, pickup_code: "1111" },
  ];
  return { tables, listing };
}

const logs: unknown[][] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.register.mockReset();
  h.register.mockImplementation(async (_a: unknown, _row: ExistingGuideOrder, guide: NormalizedManualShalomGuide) => ({
    ok: true,
    alreadyLinked: false,
    shipmentId: "s-nueva",
    filledOutput: null,
    keyWarning: guide.pickupCode ? "" : " No se ingresó la clave de recojo; regístrala después.",
  }));
  h.recompute.mockClear();
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pasada(opts: { listingKeyIsTheKey: boolean }) {
  const w = world(opts);
  h.listing = w.listing;
  const db = fakeDb(w.tables);
  const report = await cotejarShalom(db.admin, { deadlineMs: Date.now() + 270_000 });
  const keyOf = (orderId: string) => {
    const row = db.tables.shalom_pickup_keys!.find((k) => k.order_id === orderId);
    return row ? decrypt(String(row.key_enc)) : null;
  };
  return { db, report, keyOf };
}

function expectNoKeyIn(what: string, text: string) {
  for (const k of TODAS) expect(text, `${what} no debe llevar la clave ${k}`).not.toContain(k);
}

describe("Cotejar Shalom con la clave del listado comprobada", () => {
  it("la comprueba con las guías de la API y solo informa cuentas", async () => {
    const { report } = await pasada({ listingKeyIsTheKey: true });
    expect(report.errores).toEqual([]);
    expect(report.cuentas).toHaveLength(1);
    expect(report.cuentas[0]!.contrato?.clave).toEqual({ comparadas: 12, coinciden: 12, confiable: true });
    expectNoKeyIn("el informe", JSON.stringify(report));
  });

  it("vincula la guía del pedido CON su clave", async () => {
    const { report } = await pasada({ listingKeyIsTheKey: true });
    expect(h.register).toHaveBeenCalledTimes(1);
    const [, row, guide, options] = h.register.mock.calls[0] as [unknown, ExistingGuideOrder, NormalizedManualShalomGuide, RegisterExistingGuideOptions];
    expect(row.order_id).toBe("o-cand");
    expect(guide).toMatchObject({ guideCode: "93000001", pickupCode: CLAVE_CANDIDATO });
    expect(options).toMatchObject({ actor: null, onlyIfNew: true, cotejo: { payload: { clave_del_listado: true } } });
    expectNoKeyIn("lo que va a la línea de tiempo", JSON.stringify(options));
    expect(report.vinculados).toBe(1);
    expect(report.detalle).toEqual([{ pedido: "#KP140001", resultado: "vinculado", guia: "93000001", via: "dni", clave: true }]);
  });

  it("rellena la guía manual viva sin clave, cifrada, sin autor y sin pisar nada", async () => {
    const { db, report, keyOf } = await pasada({ listingKeyIsTheKey: true });
    expect(report.clavesRellenadas).toBe(1);
    expect(report.cuentas[0]!.claves).toEqual({ sinClave: 2, rellenadas: 1, motivo: null });

    expect(keyOf("o-sin-clave")).toBe(CLAVE_SIN_CLAVE);
    const keyWrites = db.writes.filter((w) => w.table === "shalom_pickup_keys");
    expect(keyWrites).toHaveLength(1);
    expect(keyWrites[0]!.row).toEqual({
      order_id: "o-sin-clave",
      store_id: STORE,
      key_enc: expect.stringMatching(/^v1:/),
      created_by: null,
    });
    // Nunca pisa: si alguien la puso entre la lectura y la escritura, la base no escribe.
    expect(keyWrites[0]!.opts).toEqual({ onConflict: "order_id", ignoreDuplicates: true });

    // La clave que ya tenía el pedido se queda, aunque el listado diga otra.
    expect(keyOf("o-con-clave")).toBe(CLAVE_YA_GUARDADA);
    // «1111» no es una clave que Shalom emita; a la entregada ya no le sirve.
    expect(keyOf("o-mala")).toBeNull();
    expect(keyOf("o-entregada")).toBeNull();

    expect(h.recompute).toHaveBeenCalledWith(db.admin, ["o-sin-clave"]);
  });

  it("deja el hecho en la línea de tiempo, sin la clave y sin contarla como entregada", async () => {
    const { db } = await pasada({ listingKeyIsTheKey: true });
    const events = db.writes.filter((w) => w.table === "order_events").map((w) => w.row);
    expect(events).toEqual([
      {
        store_id: STORE,
        order_id: "o-sin-clave",
        kind: KEY_REGISTERED_EVENT,
        occurred_at: NOW.toISOString(),
        actor: null,
        source: "shalom",
        courier: "shalom",
        guide_code: "93000002",
        shipment_id: "s-sin-clave",
        note: LISTING_KEY_NOTE,
        payload: { registered_by: "cotejar_shalom", origen: "listado_shalom_pro", shipment_id: "s-sin-clave" },
      },
    ]);
    // `key_shared`/`key_view` dirían que la clave salió hacia la clienta.
    expect(KEY_REGISTERED_EVENT).toBe("key_registered");
    expect(LISTING_KEY_NOTE).toBe("Clave de recojo tomada del listado de Shalom Pro (Cotejar Shalom).");
    expectNoKeyIn("la línea de tiempo", JSON.stringify(events));
  });

  it("no escribe nada en la bitácora con una clave", async () => {
    const { report } = await pasada({ listingKeyIsTheKey: true });
    // Lo que el cron escribe en la bitácora es el informe entero.
    console.info("[shalom-cotejo]", JSON.stringify(report));
    expectNoKeyIn("la bitácora", JSON.stringify(logs));
  });
});

describe("Cotejar Shalom con una clave del listado que NO es la clave", () => {
  it("no guarda ninguna clave y el informe lo dice con cuentas", async () => {
    const { db, report, keyOf } = await pasada({ listingKeyIsTheKey: false });
    expect(report.cuentas[0]!.contrato?.clave).toEqual({ comparadas: 12, coinciden: 0, confiable: false });
    expect(report.clavesRellenadas).toBe(0);
    expect(report.cuentas[0]!.claves).toMatchObject({ sinClave: 2, rellenadas: 0 });
    expect(report.cuentas[0]!.claves.motivo).toContain("coinciden 0 de 12");
    expect(db.writes.filter((w) => w.table === "shalom_pickup_keys")).toEqual([]);
    expect(db.writes.filter((w) => w.table === "order_events")).toEqual([]);
    expect(keyOf("o-sin-clave")).toBeNull();
    expect(h.recompute).not.toHaveBeenCalled();
    expectNoKeyIn("el informe", JSON.stringify(report));
  });

  it("vincula igual por DNI, pero SIN clave: la nota la seguirá pidiendo", async () => {
    const { report } = await pasada({ listingKeyIsTheKey: false });
    expect(h.register).toHaveBeenCalledTimes(1);
    const [, , guide, options] = h.register.mock.calls[0] as [unknown, ExistingGuideOrder, NormalizedManualShalomGuide, RegisterExistingGuideOptions];
    expect(guide.pickupCode).toBeNull();
    expect(options.cotejo?.payload).toMatchObject({ clave_del_listado: false });
    expect(report.detalle).toEqual([{ pedido: "#KP140001", resultado: "vinculado", guia: "93000001", via: "dni", clave: false }]);
  });
});

describe("registrar la guía con la clave del listado (lib/shalom/register-guide.ts)", () => {
  const row: ExistingGuideOrder = {
    order_id: "o-cand",
    store_id: STORE,
    order_name: "#KP140001",
    customer_name: "Rosa Quispe",
    customer_phone: "51987654321",
    district: "Arequipa",
    province: "Arequipa",
    region: "Arequipa",
  };
  const guide = (pickupCode: string | null): NormalizedManualShalomGuide => ({
    guideCode: "93000001",
    codigo: "77PH",
    pickupCode,
    agencyBranch: null,
    serie: "V872",
    oseId: null,
    shalomOrderId: null,
  });
  const cotejo = { motivo: "mismo DNI", payload: { via: "dni", clave_del_listado: true } };
  const real = () => vi.importActual<typeof import("@/lib/shalom/register-guide")>("@/lib/shalom/register-guide");

  it("guarda la clave cifrada y la nota dice de dónde salió, sin decir cuál es", async () => {
    const db = fakeDb({ shipments: [], shalom_pickup_keys: [], order_payments: [], order_events: [] });
    const res = await (await real()).registerExistingShalomGuide(db.admin, row, guide(CLAVE_CANDIDATO), { actor: null, onlyIfNew: true, cotejo });
    expect(res).toMatchObject({ ok: true, keyWarning: "" });
    expect(decrypt(String(db.tables.shalom_pickup_keys![0]!.key_enc))).toBe(CLAVE_CANDIDATO);
    const event = db.writes.find((w) => w.table === "order_events")!.row;
    expect(event.note).toContain("registrada por Cotejar Shalom (mismo DNI)");
    expect(event.note).toContain("Clave de recojo tomada del listado de Shalom Pro.");
    expect(event.note).not.toContain("Falta la clave");
    expect(event.payload).toMatchObject({ has_pickup_key: true, registered_by: "cotejar_shalom", clave_del_listado: true });
    expectNoKeyIn("el evento", JSON.stringify(event));
  });

  it("sin clave, o si no se pudo guardar, la nota la sigue pidiendo", async () => {
    const sin = fakeDb({ shipments: [], shalom_pickup_keys: [], order_payments: [], order_events: [] });
    await (await real()).registerExistingShalomGuide(sin.admin, row, guide(null), { actor: null, onlyIfNew: true, cotejo });
    expect(sin.writes.find((w) => w.table === "order_events")!.row.note).toContain("Falta la clave de recojo");

    const fallo = fakeDb({ shipments: [], shalom_pickup_keys: [], order_payments: [], order_events: [] }, { upsert: "sin permiso" });
    const res = await (await real()).registerExistingShalomGuide(fallo.admin, row, guide(CLAVE_CANDIDATO), { actor: null, onlyIfNew: true, cotejo });
    expect(res).toMatchObject({ ok: true, keyWarning: expect.stringContaining("no pudo guardarse") });
    const note = String(fallo.writes.find((w) => w.table === "order_events")!.row.note);
    expect(note).toContain("Falta la clave de recojo");
    expect(note).not.toContain("tomada del listado");
    expectNoKeyIn("el evento", note);
  });
});
