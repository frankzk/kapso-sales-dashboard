// «Repro Lima» en el servidor: programar el acuerdo en Grupo GF (MOM §9.5,
// §29.6, §29.13; enmiendas E21-E30). Con una base en memoria: la marca del
// acuerdo (CAS), lo que impide programar, el programa que ya era de Repro
// Lima, el acuerdo que cambia mientras se escribe, el gancho de «Recibir en
// oficina» y las chapas de la cola.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyReproReception,
  loadReproFacts,
  loadReproQueueFlags,
  materializeAgreement,
  materializeWaitingAgreementsSafe,
  reproCaseProblem,
  reproReceptionNotice,
  REPRO_NO_LO_QUIERE_CHIP,
  REPRO_NO_LO_QUIERE_NOTICE,
  type ReproCaseRow,
} from "@/lib/repro-lima-program";
import { clearGfDispatchPrograms } from "@/lib/gf-dispatch-program";
import { materializationPlan, noEsperarCajaAplica } from "@/lib/repro-lima";

// ---------------------------------------------------------------------------
// Una base en memoria con lo justo del query builder de Supabase
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
type Write = { table: string; op: string; value: any };

function fakeDb(seed: Record<string, Row[]>, opts: {
  onWrite?: (write: Write, db: Record<string, Row[]>) => void;
  failUpsert?: string;
  /** Una tabla cuya lectura falla. */
  failRead?: string;
} = {}) {
  const db: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const writes: Write[] = [];
  const reads: string[] = [];
  let seq = 0;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "update" | "delete" | "insert" | "upsert" = "select";
    let value: any = null;
    let single = false;
    let limit = Infinity;
    let order: { col: string; asc: boolean } | null = null;
    let returning = false;
    const q: any = {};
    q.select = () => { if (op !== "select") returning = true; return q; };
    q.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return q; };
    q.neq = (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; };
    q.in = (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return q; };
    q.is = (col: string, v: unknown) => { filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return q; };
    q.gt = (col: string, v: string) => { filters.push((r) => r[col] != null && r[col] > v); return q; };
    q.not = (col: string, operator: string, v: unknown) => { filters.push((r) => (operator === "is" && v === null ? r[col] != null : r[col] !== v)); return q; };
    q.order = (col: string, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return q; };
    q.limit = (n: number) => { limit = n; return q; };
    q.range = () => q;
    q.update = (v: any) => { op = "update"; value = v; return q; };
    q.delete = () => { op = "delete"; return q; };
    q.insert = (v: any) => { op = "insert"; value = v; return q; };
    q.upsert = (v: any) => { op = "upsert"; value = v; return q; };
    const run = () => {
      const rows = (db[table] ??= []);
      const match = (r: Row) => filters.every((f) => f(r));
      if (op === "select") {
        reads.push(table);
        if (opts.failRead === table) return { data: null, error: { message: `sin ${table}` } };
        let out = rows.filter(match);
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (a[col] ?? "") < (b[col] ?? "") ? (asc ? -1 : 1) : (a[col] ?? "") > (b[col] ?? "") ? (asc ? 1 : -1) : 0);
        }
        out = out.slice(0, limit);
        return { data: single ? out[0] ?? null : out, error: null };
      }
      if (op === "upsert" && table === "gf_dispatch_programs" && opts.failUpsert) return { data: null, error: { message: opts.failUpsert } };
      let affected: Row[] = [];
      if (op === "update") {
        affected = rows.filter(match);
        for (const r of affected) Object.assign(r, value);
      } else if (op === "delete") {
        affected = rows.filter(match);
        db[table] = rows.filter((r) => !match(r));
      } else if (op === "insert") {
        affected = (Array.isArray(value) ? value : [value]).map((v: Row) => ({ id: v.id ?? `${table}-${++seq}`, ...v }));
        rows.push(...affected);
      } else {
        const existing = rows.find((r) => r.order_id === value.order_id);
        if (existing) Object.assign(existing, value);
        else rows.push({ ...value });
        affected = [value];
      }
      const write = { table, op, value: op === "delete" ? affected : value };
      writes.push(write);
      opts.onWrite?.(write, db);
      return { data: returning ? (single ? affected[0] ?? null : affected) : null, error: null };
    };
    q.maybeSingle = q.single = async () => { single = true; return run(); };
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject);
    return q;
  };
  const admin = {
    from,
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: id === "u-diana" ? "diana@kapta.pe" : null } } }) } },
  };
  return { admin: admin as never, db, writes, reads, rpc: admin.rpc };
}

// ---------------------------------------------------------------------------
// El pedido de siempre: KP1, Roy no lo entregó el sáb 10/10 y la caja ya
// está en la oficina. Hoy es lun 12/10 a las 10:00 de Lima.
// ---------------------------------------------------------------------------

const EPISODE = "s:stop-1|o:-";

function agreement(over: Partial<ReproCaseRow> = {}): ReproCaseRow {
  return {
    id: "case-1",
    store_id: "s1",
    order_id: "o1",
    episode_key: EPISODE,
    episode_at: "2026-10-10T20:00:00.000Z",
    opened_at: "2026-10-12T14:00:00Z",
    opened_by: "u-diana",
    claimed_by: "u-diana",
    claimed_until: "2026-10-12T15:10:00Z",
    call_count: 1,
    no_answer_count: 0,
    last_call_at: "2026-10-12T14:55:00Z",
    last_outcome: "confirma",
    next_call_at: null,
    agreement_call_id: "call-1",
    agreed_on: "2026-10-13",
    agreed_courier: "propio",
    changes: {},
    box_action: "mantener",
    box_location: "en_oficina",
    decided_by: "u-diana",
    decided_at: "2026-10-12T14:55:00Z",
    materialized_at: null,
    materialized_on: null,
    closed_at: null,
    closed_by: null,
    close_reason: null,
    close_note: null,
    ...over,
  };
}

function seed(over: { cases?: ReproCaseRow[]; programs?: Row[]; items?: Row[]; requests?: Row[]; stage?: string; cancelled?: string | null; stops?: Row[] } = {}): Record<string, Row[]> {
  return {
    order_master: [{
      order_id: "o1", store_id: "s1", order_name: "#KP1", customer_name: "Ana", customer_phone: "987654321",
      district: "Surco", region: "Lima", province: "Lima", order_total: 120, macro_since: "2026-10-10T20:00:00Z",
      macro_stage: "en_curso", macro_substage: over.stage ?? "por_reprogramar_lima", operational_status: null,
    }],
    orders: [{ id: "o1", store_id: "s1", cancelled_at: over.cancelled ?? null }],
    shipments: [{
      id: "sh1", order_id: "o1", store_id: "s1", courier: "propio", created_via: "grupo_gf_courier", delivery_status: "pendiente",
      custody_state: "empresa", custody_transferred_at: null, output_number: 1, output_code: "KP1-S01", guide_code: null,
      status_category: "pending", reported_status: null, swayp_state: null, returned_at: null, dispatched_at: "2026-10-10T14:00:00Z",
      updated_at: "2026-10-10T20:00:00Z", closed_at: null,
    }],
    delivery_stops: over.stops ?? [{
      id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta",
      note: null, photo_path: null, reported_at: "2026-10-10T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-1",
    }],
    delivery_routes: [{ id: "r1", route_date: "2026-10-10", rider_id: "rd1" }],
    riders: [{ id: "rd1", full_name: "Roy" }],
    stores: [{ id: "s1", org_id: "org1" }],
    logistics_providers: [{ id: "p1", org_id: "org1", status: "active", same_day_cutoff: "12:00:00", code: "grupo-gf-courier" }],
    logistics_requests: over.requests ?? [],
    gf_dispatch_programs: over.programs ?? [],
    order_events: [{ id: "ev-1", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-12T13:00:00Z" }],
    lima_repro_cases: over.cases ?? [agreement()],
    lima_repro_calls: [],
    dispatch_manifest_items: over.items ?? [],
    dispatch_manifests: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const caseRow = (db: Record<string, Row[]>) => db.lima_repro_cases!.find((r) => r.id === "case-1")!;

describe("los hechos del pedido", () => {
  it("el episodio es la parada «No entregado» y la caja está en oficina", async () => {
    const { admin } = fakeDb(seed());
    const facts = (await loadReproFacts(admin, ["o1"])).get("o1")!;
    expect(facts.episode).toEqual({ key: EPISODE, at: "2026-10-10T20:00:00.000Z" });
    expect(facts.inStage).toBe(true);
    expect(facts.box).toMatchObject({ kind: "en_oficina", courier: "propio" });
    expect(facts.lastStop).toMatchObject({ id: "stop-1", riderName: "Roy", routeDate: "2026-10-10" });
    expect(facts.provider?.same_day_cutoff).toBe("12:00:00");
    expect(facts.open?.id).toBe("case-1");
  });

  it("E29: reabierto después de «Desarmar y cerrar» con la caja en oficina, no consta que siga armada", async () => {
    const closed = agreement({ id: "case-0", opened_at: "2026-10-11T14:00:00Z", closed_at: "2026-10-11T15:00:00Z", close_reason: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, box_action: "desarmar_cerrar", claimed_by: null, claimed_until: null });
    const { admin } = fakeDb(seed({ cases: [closed, agreement({ agreement_call_id: null, agreed_on: null, agreed_courier: null, box_action: null })] }));
    const facts = (await loadReproFacts(admin, ["o1"])).get("o1")!;
    expect(facts.reopened).toBe(true);
    expect(facts.box).toEqual({ kind: "desconocida", own: true });
  });

  it("E29: la caja recibida en oficina después de reabrir sigue en oficina: nadie pidió desarmarla", async () => {
    // Cerrado el 11/10 con la caja todavía con Roy; reabierto el 12/10 a las
    // 09:00; Roy la trae a las 09:30. Con el caso abierto, la recepción no
    // dio el aviso de desarmarla: está armada en el estante.
    const closed = agreement({ id: "case-0", opened_at: "2026-10-11T14:00:00Z", closed_at: "2026-10-11T15:00:00Z", close_reason: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, box_action: "desarmar_cerrar", claimed_by: null, claimed_until: null });
    const s = seed({ cases: [closed, agreement({ agreement_call_id: null, agreed_on: null, agreed_courier: null, box_action: null })] });
    s.order_events = [{ id: "ev-1", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-12T14:30:00Z" }];
    const facts = (await loadReproFacts(fakeDb(s).admin, ["o1"])).get("o1")!;
    expect(facts.reopened).toBe(true);
    expect(facts.box).toEqual({ kind: "en_oficina", since: "2026-10-12T14:30:00Z", courier: "propio" });
    // «Mantener» se programa al decidir; «No esperar la caja» no se ofrece.
    expect(materializationPlan({ courier: "propio", boxAction: "mantener", box: facts.box, retryAdmission: facts.retryAdmission })).toBe("ahora");
    expect(noEsperarCajaAplica(facts.box, facts.reopened)).toBe(false);
  });

  it("F1: la solicitud vigente del pedido con su S01 no es «otra solicitud»: la caja recibida está en oficina", async () => {
    // `gf_return_to_office` devuelve la solicitud a `accepted` con la misma salida.
    const own = { id: "req-1", order_id: "o1", provider_id: "p1", shipment_id: "sh1", scheduled_for: "2026-10-12", status: "accepted", created_at: "2026-10-11T13:30:00Z" };
    const { admin } = fakeDb(seed({ requests: [own] }));
    const facts = (await loadReproFacts(admin, ["o1"])).get("o1")!;
    expect(facts.ownInOtherRequest).toBe(false);
    expect(facts.box).toMatchObject({ kind: "en_oficina", courier: "propio" });
    expect(materializationPlan({ courier: "propio", boxAction: "mantener", box: facts.box, retryAdmission: facts.retryAdmission })).toBe("ahora");
    // Una solicitud cancelada que tuvo la S01 sí la bloquea (`logistics_requests_shipment_uniq`).
    const cancelled = fakeDb(seed({ requests: [{ ...own, status: "cancelled" }] }));
    const blocked = (await loadReproFacts(cancelled.admin, ["o1"])).get("o1")!;
    expect(blocked.ownInOtherRequest).toBe(true);
    expect(blocked.box).toEqual({ kind: "desconocida", own: true, block: "salida_en_otra_solicitud" });
  });

  it("F0: corregir el reporte de una parada de un día anterior no cambia el episodio ni cierra el caso", async () => {
    // stop-1 es de la ruta del sáb 10/10; stop-2, de la del lun 12/10 (09:00),
    // abrió el caso. A las 09:30 Liquidaciones 2 reescribe el reporte de stop-1.
    const stops = [
      { id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta", note: "corregida", photo_path: null, reported_at: "2026-10-12T14:30:00Z", requested_date: null, dispatch_manifest_id: "box-1" },
      { id: "stop-2", order_id: "o1", shipment_id: "sh1", route_id: "r2", status: "no_entregado", outcome_reason: "ausente", note: null, photo_path: null, reported_at: "2026-10-12T14:00:00Z", requested_date: "2026-10-15", dispatch_manifest_id: "box-2" },
    ];
    const s = seed({ stops, cases: [agreement({ episode_key: "s:stop-2|o:-", episode_at: "2026-10-12T14:00:00.000Z" })] });
    s.delivery_routes!.push({ id: "r2", route_date: "2026-10-12", rider_id: "rd1" });
    const { admin } = fakeDb(s);
    const facts = (await loadReproFacts(admin, ["o1"])).get("o1")!;
    expect(facts.episode.key).toBe("s:stop-2|o:-");
    expect(facts.lastStop?.id).toBe("stop-2");
    expect(facts.failedStops.map((stop) => stop.id)).toEqual(["stop-2", "stop-1"]);
    expect(reproCaseProblem(facts, facts.open!)).toBeNull();
  });

  it("F0: dos paradas del mismo día de ruta: corregir la que nació antes no cambia el episodio", async () => {
    // Lun 12/10: Roy falla S01 (stop-1, nacida a las 08:00); «Sacar con salida
    // nueva» manda la S02 con Johnny (stop-2, nacida a las 12:30), que falla a
    // las 17:00 y abre el caso. Al día siguiente Liquidaciones 2 corrige la
    // nota de stop-1: su `reported_at` pasa a ser el más reciente.
    const stops = [
      { id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta", note: "corregida", photo_path: null, reported_at: "2026-10-13T14:00:00Z", requested_date: null, dispatch_manifest_id: "box-1", created_at: "2026-10-12T13:00:00Z" },
      { id: "stop-2", order_id: "o1", shipment_id: "sh2", route_id: "r2", status: "no_entregado", outcome_reason: "ausente", note: null, photo_path: null, reported_at: "2026-10-12T22:00:00Z", requested_date: null, dispatch_manifest_id: "box-2", created_at: "2026-10-12T17:30:00Z" },
    ];
    const s = seed({ stops, cases: [agreement({ episode_key: "s:stop-2|o:-", episode_at: "2026-10-12T22:00:00.000Z" })] });
    s.delivery_routes = [{ id: "r1", route_date: "2026-10-12", rider_id: "rd1" }, { id: "r2", route_date: "2026-10-12", rider_id: "rd2" }];
    s.riders!.push({ id: "rd2", full_name: "Johnny" });
    const facts = (await loadReproFacts(fakeDb(s).admin, ["o1"])).get("o1")!;
    expect(facts.episode.key).toBe("s:stop-2|o:-");
    expect(facts.lastStop).toMatchObject({ id: "stop-2", riderName: "Johnny" });
    expect(facts.failedStops.map((stop) => stop.id)).toEqual(["stop-2", "stop-1"]);
    expect(reproCaseProblem(facts, facts.open!)).toBeNull();
  });

  it("F9/F16: la recepción de un episodio anterior no cuenta para la caja de este", async () => {
    // La caja se recibió el 01/10; el pedido volvió a salir el sáb 10/10 y falló.
    const s = seed();
    s.order_events = [{ id: "ev-0", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-01T15:00:00Z" }];
    const old = (await loadReproFacts(fakeDb(s).admin, ["o1"])).get("o1")!;
    expect(old.receivedAt).toBeNull();
    // Recibida el mismo día de su ruta, cuenta (desde el inicio del día en Lima).
    s.order_events.push({ id: "ev-1", order_id: "o1", shipment_id: "sh1", kind: "returned_to_office", occurred_at: "2026-10-10T23:30:00Z" });
    const fresh = (await loadReproFacts(fakeDb(s).admin, ["o1"])).get("o1")!;
    expect(fresh.receivedAt).toBe("2026-10-10T23:30:00Z");
    expect(fresh.box).toEqual({ kind: "en_oficina", since: "2026-10-10T23:30:00Z", courier: "propio" });
  });

  it("un caso de otro episodio: nuevo intento si el fallo es más reciente, «cambió» si no", () => {
    const facts = { inStage: true, cancelled: false, episode: { key: "s:stop-2|o:-", at: "2026-10-11T20:00:00Z" } };
    expect(reproCaseProblem(facts, agreement())?.reason).toBe("nuevo_intento");
    expect(reproCaseProblem({ ...facts, episode: { key: "s:stop-0|o:-", at: "2026-10-09T20:00:00Z" } }, agreement())?.reason).toBe("cambio");
    expect(reproCaseProblem({ ...facts, inStage: false }, agreement())?.reason).toBe("fuera_de_etapa");
    expect(reproCaseProblem({ ...facts, cancelled: true, episode: { key: EPISODE, at: null } }, agreement())?.reason).toBe("fuera_de_etapa");
    expect(reproCaseProblem({ ...facts, episode: { key: EPISODE, at: null } }, agreement())).toBeNull();
  });
});

describe("materializeAgreement", () => {
  it("marca el acuerdo y programa con el escritor de «Programar», a nombre de quien decidió", async () => {
    const { admin, db, writes } = fakeDb(seed({ requests: [{ id: "req-1", order_id: "o1", provider_id: "p1", shipment_id: "sh1", scheduled_for: "2026-10-12", status: "accepted", created_at: "2026-10-12T13:30:00Z" }] }));
    const result = await materializeAgreement(admin, { caseRow: agreement(), actor: "u-recibe" });
    expect(result).toEqual({ status: "programado", day: "2026-10-13", wrote: true, warning: null });
    expect(caseRow(db)).toMatchObject({ materialized_on: "2026-10-13" });
    expect(caseRow(db).materialized_at).toBeTruthy();
    const program = db.gf_dispatch_programs![0]!;
    expect(program).toMatchObject({ order_id: "o1", scheduled_for: "2026-10-13", reason: "Repro Lima: confirmado con el cliente (diana, 12/10)", set_by: "u-recibe" });
    // La solicitud se mueve a ese día y el historial lo dice.
    expect(db.logistics_requests![0]!.scheduled_for).toBe("2026-10-13");
    const event = writes.find((w) => w.table === "order_events" && w.value.kind === "dispatch_programmed")!;
    expect(event.value.note).toBe("Salida programada para el mar 13/10: Repro Lima: confirmado con el cliente (diana, 12/10).");
  });

  it("cada acuerdo se programa una vez: con la marca puesta no escribe nada", async () => {
    const marked = agreement({ materialized_at: "2026-10-12T14:56:00Z", materialized_on: "2026-10-13" });
    const { admin, writes } = fakeDb(seed({ cases: [marked] }));
    expect(await materializeAgreement(admin, { caseRow: agreement(), actor: "u" })).toEqual({ status: "omitido" });
    expect(writes.filter((w) => w.table === "gf_dispatch_programs")).toEqual([]);
  });

  it("E21: fuera de la etapa o anulado no programa y cierra el caso", async () => {
    for (const over of [{ stage: "por_cerrar" }, { cancelled: "2026-10-12T14:00:00Z" }]) {
      const { admin, db, writes } = fakeDb(seed(over));
      const result = await materializeAgreement(admin, { caseRow: agreement(), actor: "u" });
      expect(result).toMatchObject({ status: "cerrado", reason: "fuera_de_etapa" });
      expect(caseRow(db)).toMatchObject({ close_reason: "fuera_de_etapa", claimed_by: null, claimed_until: null });
      expect(writes.some((w) => w.table === "gf_dispatch_programs")).toBe(false);
    }
  });

  it("E21: un fallo posterior (otro episodio) cierra el caso como nuevo intento", async () => {
    const stops = [
      { id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta", note: null, photo_path: null, reported_at: "2026-10-10T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-1" },
      { id: "stop-2", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "ausente", note: null, photo_path: null, reported_at: "2026-10-11T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-2" },
    ];
    const { admin, db } = fakeDb(seed({ stops }));
    expect(await materializeAgreement(admin, { caseRow: agreement(), actor: "u" })).toMatchObject({ status: "cerrado", reason: "nuevo_intento" });
    expect(caseRow(db).close_reason).toBe("nuevo_intento");
  });

  it("lo que sigue en la caja de un motorizado no se programa y la marca se deshace", async () => {
    const { admin, db, writes } = fakeDb(seed({ items: [{ id: "item-1", shipment_id: "sh1", manifest_id: "box-1", removed_at: null }] }));
    const result = await materializeAgreement(admin, { caseRow: agreement(), actor: "u" });
    expect(result).toEqual({ status: "error", message: "La caja sigue con el motorizado: se programa al recibirla." });
    expect(caseRow(db)).toMatchObject({ materialized_at: null, materialized_on: null });
    expect(writes.some((w) => w.table === "gf_dispatch_programs")).toBe(false);
  });

  it("«Caja nueva desde stock» se programa aunque la caja siga con el motorizado (sale otra)", async () => {
    const { admin, db } = fakeDb(seed({ items: [{ id: "item-1", shipment_id: "sh1", manifest_id: "box-1", removed_at: null }] }));
    const result = await materializeAgreement(admin, { caseRow: agreement({ box_action: "caja_nueva_stock" }), actor: "u" });
    expect(result).toMatchObject({ status: "programado", wrote: true });
    expect(db.gf_dispatch_programs).toHaveLength(1);
  });

  it("E26: el programa de Repro Lima para ese día no se reescribe; el del motorizado sí", async () => {
    const ours = { order_id: "o1", store_id: "s1", scheduled_for: "2026-10-13", reason: "Repro Lima: confirmado con el cliente (diana, 11/10)", set_at: "2026-10-11T15:00:00Z" };
    const kept = fakeDb(seed({ programs: [ours] }));
    expect(await materializeAgreement(kept.admin, { caseRow: agreement(), actor: "u" })).toEqual({ status: "programado", day: "2026-10-13", wrote: false });
    expect(kept.writes.filter((w) => w.table === "gf_dispatch_programs")).toEqual([]);

    const rider = { ...ours, reason: "Reprogramado por el cliente (reporte de la parada de Roy)" };
    const rewritten = fakeDb(seed({ programs: [rider] }));
    expect(await materializeAgreement(rewritten.admin, { caseRow: agreement(), actor: "u" })).toMatchObject({ status: "programado", wrote: true });
    expect(rewritten.db.gf_dispatch_programs![0]!.reason).toBe("Repro Lima: confirmado con el cliente (diana, 12/10)");
  });

  it("si escribir falla, la marca se deshace y se dice por qué", async () => {
    const { admin, db } = fakeDb(seed(), { failUpsert: "boom" });
    expect(await materializeAgreement(admin, { caseRow: agreement(), actor: "u" })).toEqual({ status: "error", message: "boom" });
    expect(caseRow(db).materialized_at).toBeNull();
  });

  it("E22: si el acuerdo cambia mientras se escribe, se quita SU programa y queda el evento", async () => {
    const { admin, db, writes } = fakeDb(seed(), {
      onWrite: (write, tables) => {
        if (write.table === "gf_dispatch_programs" && write.op === "upsert") {
          tables.lima_repro_cases!.find((r) => r.id === "case-1")!.agreement_call_id = "call-2";
        }
      },
    });
    const result = await materializeAgreement(admin, { caseRow: agreement(), actor: "u" });
    expect(result).toEqual({ status: "error", message: "El acuerdo cambió mientras se programaba: vuelve a abrir el caso." });
    expect(db.gf_dispatch_programs).toEqual([]);
    const cleared = writes.find((w) => w.table === "order_events" && w.op === "insert" && (w.value as Row[])[0]?.kind === "dispatch_program_cleared")!;
    expect((cleared.value as Row[])[0]!.note).toContain("Repro Lima: el acuerdo cambió mientras se programaba.");
  });

  it("F6: si el acuerdo nuevo del mismo día ya se marcó contando con este programa, no se quita", async () => {
    // La tienda reconfirma el mismo día mientras se recibe la caja: su RPC
    // borra la marca, su materialización marca de nuevo y ve este programa
    // (paso 5), así que no escribe el suyo.
    const { admin, db, writes } = fakeDb(seed(), {
      onWrite: (write, tables) => {
        if (write.table === "gf_dispatch_programs" && write.op === "upsert") {
          Object.assign(tables.lima_repro_cases!.find((r) => r.id === "case-1")!, {
            agreement_call_id: "call-2",
            materialized_at: "2026-10-12T15:00:30.000Z",
            materialized_on: "2026-10-13",
          });
        }
      },
    });
    const result = await materializeAgreement(admin, { caseRow: agreement(), actor: "u" });
    expect(result).toMatchObject({ status: "programado", day: "2026-10-13" });
    expect(db.gf_dispatch_programs).toHaveLength(1);
    expect(writes.some((w) => w.table === "order_events" && w.op === "insert" && (w.value as Row[])[0]?.kind === "dispatch_program_cleared")).toBe(false);

    // Si el acuerdo nuevo es de otro día, el programa sí se quita.
    const other = fakeDb(seed(), {
      onWrite: (write, tables) => {
        if (write.table === "gf_dispatch_programs" && write.op === "upsert") {
          Object.assign(tables.lima_repro_cases!.find((r) => r.id === "case-1")!, {
            agreement_call_id: "call-2",
            agreed_on: "2026-10-14",
            materialized_at: "2026-10-12T15:00:30.000Z",
            materialized_on: "2026-10-14",
          });
        }
      },
    });
    expect(await materializeAgreement(other.admin, { caseRow: agreement(), actor: "u" })).toMatchObject({ status: "error" });
    expect(other.db.gf_dispatch_programs).toEqual([]);
  });
});

describe("clearGfDispatchPrograms (E22)", () => {
  it("borra solo lo leído y deja el evento solo de lo borrado", async () => {
    const program = { order_id: "o1", store_id: "s1", scheduled_for: "2026-10-13", reason: "Programar", set_at: "2026-10-12T10:00:00Z" };
    const { admin, db, writes } = fakeDb(seed({ programs: [{ ...program, set_at: "2026-10-12T11:00:00Z" }] }));
    // Alguien lo reprogramó después de leerlo: no se borra.
    expect((await clearGfDispatchPrograms(admin, [program], "u", "Repro Lima: el cliente ya no lo quiere.")).cleared).toEqual([]);
    expect(db.gf_dispatch_programs).toHaveLength(1);
    expect(writes.some((w) => w.table === "order_events")).toBe(false);

    const fresh = { ...program, set_at: "2026-10-12T11:00:00Z" };
    const { cleared } = await clearGfDispatchPrograms(admin, [fresh], "u", "Repro Lima: el cliente ya no lo quiere.");
    expect(cleared).toHaveLength(1);
    expect(db.gf_dispatch_programs).toEqual([]);
    const event = (writes.find((w) => w.table === "order_events")!.value as Row[])[0]!;
    expect(event).toMatchObject({ kind: "dispatch_program_cleared", actor: "u" });
    expect(event.note).toBe("Se quitó la salida programada para el mar 13/10 («Programar»). Repro Lima: el cliente ya no lo quiere.");
  });
});

describe("«Recibir en oficina» programa el acuerdo que esperaba la caja (§29.13)", () => {
  it("sin casos, una sola lectura y nada que decir", async () => {
    const { admin, reads, writes } = fakeDb(seed({ cases: [] }));
    expect(await materializeWaitingAgreementsSafe(admin, ["o1"], "u")).toEqual(emptyReproReception());
    expect(reads).toEqual(["lima_repro_cases"]);
    expect(writes).toEqual([]);
  });

  it("programa el día acordado y lo dice", async () => {
    const { admin, db, rpc } = fakeDb(seed());
    const result = await materializeWaitingAgreementsSafe(admin, ["o1"], "u-recibe");
    expect(result.programmed).toEqual([{ orderId: "o1", orderName: "#KP1", day: "2026-10-13" }]);
    expect(db.gf_dispatch_programs![0]).toMatchObject({ scheduled_for: "2026-10-13", set_by: "u-recibe" });
    // E30: ni RPC ni nada más que la base.
    expect(rpc).not.toHaveBeenCalled();
    expect(reproReceptionNotice(result)).toEqual(["1 con acuerdo de Repro Lima: quedó programado para su día (va al anaquel de ese día)."]);
    expect(reproReceptionNotice(result, { single: true })).toEqual(["Repro Lima: programado para el mar 13/10, el día acordado con el cliente (va al anaquel de ese día)."]);
    expect(reproReceptionNotice(result, { single: true, omitProgrammed: true })).toEqual([]);
  });

  it("solo «Mantener» o «Reimprimir» con Grupo GF esperan la caja", async () => {
    for (const over of [{ box_action: "salida_nueva_rearmar" }, { agreed_courier: "tanders" }, { materialized_at: "2026-10-12T14:00:00Z", materialized_on: "2026-10-13" }]) {
      const { admin, db } = fakeDb(seed({ cases: [agreement(over)] }));
      expect((await materializeWaitingAgreementsSafe(admin, ["o1"], "u")).programmed).toEqual([]);
      expect(db.gf_dispatch_programs).toEqual([]);
    }
  });

  it("un día que ya pasó no se programa: se pide confirmarlo de nuevo", async () => {
    const { admin, db } = fakeDb(seed({ cases: [agreement({ agreed_on: "2026-10-11" })] }));
    const result = await materializeWaitingAgreementsSafe(admin, ["o1"], "u");
    expect(result.pasadas).toBe(1);
    expect(db.gf_dispatch_programs).toEqual([]);
    expect(reproReceptionNotice({ ...result, pasadas: 2 })).toEqual(["2 con fecha acordada que ya pasó: vuelve a confirmarla en Repro Lima."]);
  });

  it("E25: hoy después del corte no se programa al recibir; en el escaneo de asignación, sí", async () => {
    vi.setSystemTime(new Date("2026-10-12T17:30:00Z")); // 12:30 en Lima
    const today = agreement({ agreed_on: "2026-10-12" });
    const reception = fakeDb(seed({ cases: [today] }));
    expect(await materializeWaitingAgreementsSafe(reception.admin, ["o1"], "u", { via: "recepcion" })).toMatchObject({ tarde: 1, programmed: [] });
    expect(reception.db.gf_dispatch_programs).toEqual([]);
    const scan = fakeDb(seed({ cases: [today] }));
    expect((await materializeWaitingAgreementsSafe(scan.admin, ["o1"], "u", { via: "escaneo" })).programmed).toHaveLength(1);
  });

  it("E27: el último caso del episodio es «Desarmar y cerrar»: el aviso dice que ya no lo quiere", async () => {
    const closed = agreement({ closed_at: "2026-10-12T14:00:00Z", close_reason: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, box_action: "desarmar_cerrar", claimed_by: null, claimed_until: null });
    const { admin, db } = fakeDb(seed({ cases: [closed] }));
    const result = await materializeWaitingAgreementsSafe(admin, ["o1"], "u");
    expect(result.noLoQuiere).toEqual([{ orderId: "o1", orderName: "#KP1" }]);
    expect(db.gf_dispatch_programs).toEqual([]);
    expect(reproReceptionNotice(result, { single: true })).toEqual([REPRO_NO_LO_QUIERE_NOTICE]);
    expect(REPRO_NO_LO_QUIERE_NOTICE).toBe("Repro Lima: el cliente ya no lo quiere. Desármala (cuaderno «DESARMAR»); no va al estante.");
    // De otro episodio ya no dice nada.
    const old = fakeDb(seed({ cases: [{ ...closed, episode_key: "s:stop-0|o:-" }] }));
    expect((await materializeWaitingAgreementsSafe(old.admin, ["o1"], "u")).noLoQuiere).toEqual([]);
  });

  it("E30: nunca lanza, ni con la base caída ni con un cliente simulado a medias", async () => {
    const broken = { from: () => { throw new Error("sin base"); } } as never;
    expect(await materializeWaitingAgreementsSafe(broken, ["o1"], "u")).toEqual(emptyReproReception());
    // Como los de test/gf-returns-scan.test.ts: sin .neq, .not ni .gt.
    const partial = {
      from: () => {
        const q: any = {};
        for (const m of ["select", "eq", "in", "is", "limit", "order"]) q[m] = () => q;
        q.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [agreement()], error: null }).then(resolve);
        return q;
      },
    } as never;
    expect(await materializeWaitingAgreementsSafe(partial, ["o1"], "u")).toEqual(emptyReproReception());
  });
});

describe("las chapas de la cola de Despacho del día (E28)", () => {
  it("«no lo quiere» mientras no vuelva a salir; «caja nueva desde stock» con su día", async () => {
    const closed = agreement({ closed_at: "2026-10-12T14:00:00Z", close_reason: "desarmar_cerrar", box_action: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, claimed_by: null, claimed_until: null });
    const nueva = agreement({ id: "case-2", order_id: "o2", box_action: "caja_nueva_stock", agreed_on: "2026-10-15" });
    const { admin } = fakeDb(seed({ cases: [closed, nueva] }));
    const flags = await loadReproQueueFlags(admin, ["o1", "o2"], new Map());
    expect([...flags.noLoQuiere]).toEqual(["o1"]);
    expect(flags.cajaNueva.get("o2")).toEqual({ day: "2026-10-15", open: true });
    expect(REPRO_NO_LO_QUIERE_CHIP).toBe("Repro Lima: no lo quiere · desarmar");
  });

  it("«caja nueva desde stock» solo con Grupo GF: con otro courier su salida sale de la Mesa de ruta", async () => {
    // Con Tanders, Swayp o Axel la chapa le diría a Grupo GF que la saque con
    // «Sacar con salida nueva» (§9.3, fila 2): no lleva chapa.
    const cases = [
      agreement({ id: "case-t", order_id: "o2", box_action: "caja_nueva_stock", agreed_on: "2026-10-15", agreed_courier: "tanders" }),
      agreement({ id: "case-f", order_id: "o3", box_action: "caja_nueva_stock", agreed_on: "2026-10-15", agreed_courier: "fenix" }),
      agreement({ id: "case-g", order_id: "o4", box_action: "caja_nueva_stock", agreed_on: "2026-10-15", agreed_courier: "propio" }),
    ];
    const { admin } = fakeDb(seed({ cases }));
    const flags = await loadReproQueueFlags(admin, ["o2", "o3", "o4"], new Map());
    expect([...flags.cajaNueva.keys()]).toEqual(["o4"]);
    expect(flags.noLoQuiere.size).toBe(0);
  });

  it("F2: recibir la caja (o corregir el reporte) después del cierre no esconde «no lo quiere»", async () => {
    const closed = agreement({ closed_at: "2026-10-12T14:00:00Z", close_reason: "desarmar_cerrar", box_action: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, claimed_by: null, claimed_until: null });
    // `gf_order_departures` cuenta el `returned_to_office` de las 16:00 como salida.
    const { admin } = fakeDb(seed({ cases: [closed] }));
    const received = await loadReproQueueFlags(admin, ["o1"], new Map([["o1", "2026-10-12T16:00:00Z"]]));
    expect([...received.noLoQuiere]).toEqual(["o1"]);
  });

  it("F2: un fallo nuevo después del cierre es otro episodio: la chapa se va", async () => {
    const closed = agreement({ closed_at: "2026-10-12T14:00:00Z", close_reason: "desarmar_cerrar", box_action: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, claimed_by: null, claimed_until: null });
    const stops = [
      { id: "stop-1", order_id: "o1", shipment_id: "sh1", route_id: "r1", status: "no_entregado", outcome_reason: "no_contesta", note: null, photo_path: null, reported_at: "2026-10-10T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-1" },
      { id: "stop-2", order_id: "o1", shipment_id: "sh1", route_id: "r2", status: "no_entregado", outcome_reason: "ausente", note: null, photo_path: null, reported_at: "2026-10-12T20:00:00Z", requested_date: null, dispatch_manifest_id: "box-2" },
    ];
    const s = seed({ cases: [closed], stops });
    s.delivery_routes!.push({ id: "r2", route_date: "2026-10-12", rider_id: "rd1" });
    const { admin } = fakeDb(s);
    expect((await loadReproQueueFlags(admin, ["o1"], new Map([["o1", "2026-10-12T20:00:00Z"]]))).noLoQuiere.size).toBe(0);
  });

  it("F2: sin los hechos del pedido, se cae a las salidas después del cierre", async () => {
    const closed = agreement({ closed_at: "2026-10-12T14:00:00Z", close_reason: "desarmar_cerrar", box_action: "desarmar_cerrar", agreement_call_id: null, agreed_on: null, agreed_courier: null, claimed_by: null, claimed_until: null });
    const { admin } = fakeDb(seed({ cases: [closed] }), { failRead: "shipments" });
    expect([...(await loadReproQueueFlags(admin, ["o1"], new Map())).noLoQuiere]).toEqual(["o1"]);
    expect((await loadReproQueueFlags(admin, ["o1"], new Map([["o1", "2026-10-12T16:00:00Z"]]))).noLoQuiere.size).toBe(0);
  });
});
