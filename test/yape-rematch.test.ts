// El recruce con los movimientos de Yape ya guardados (MOM §16.2, 13-11-2026):
// el comprobante cargado DESPUÉS de que llegó el reporte de su hora se valida
// en la pasada siguiente, por la misma función y las mismas rejas.

import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ apply: vi.fn(), deliver: vi.fn() }));
vi.mock("@/lib/payment-validation", () => ({ applyPaymentValidation: h.apply }));
vi.mock("@/lib/pickup-key-delivery", () => ({ deliverPickupKey: h.deliver }));
vi.mock("@/lib/tanders/collection-time-backfill", () => ({ backfillCourierPaidAt: async () => null }));
vi.mock("@/lib/collection-accounts", () => ({
  loadCollectionAccounts: async (_: unknown, ids: string[]) =>
    new Map(ids.map((id) => [id, [{ name: "Grupo GF S.A.C.", phoneLastDigits: "309" }]])),
}));

import { movementsByAccount, rematchStoredMovements, REMATCH_MESSAGE_PREFIX, storedMovement } from "@/lib/yape-statement/rematch";

type Row = Record<string, unknown>;
type Write = { table: string; op: string; payload: unknown };

/** Una base en memoria con lo justo de PostgREST para el orquestador. */
function fakeDb(tables: Record<string, Row[]>) {
  const writes: Write[] = [];
  const from = (table: string) => {
    const st = {
      op: "select",
      payload: null as unknown,
      filters: [] as ((r: Row) => boolean)[],
      range: null as [number, number] | null,
      single: false,
    };
    const rows = () => (tables[table] ??= []);
    const matching = () => rows().filter((r) => st.filters.every((f) => f(r)));
    const run = () => {
      if (st.op === "select") {
        let data = matching();
        if (st.range) data = data.slice(st.range[0], st.range[1] + 1);
        return { data, error: null };
      }
      if (st.op === "insert" || st.op === "upsert") {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]) as Row[];
        for (const row of list) {
          if (table === "yape_statement_matches") {
            const clash = rows().some((r) => r.movement_key === row.movement_key || r.payment_id === row.payment_id);
            if (clash) return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
          if (st.op === "upsert" && rows().some((r) => r.movement_key === row.movement_key)) continue;
          rows().push({ id: `${table}-${rows().length + 1}`, ...row });
        }
        writes.push({ table, op: st.op, payload: st.payload });
        return { data: st.single ? { id: `${table}-${rows().length}` } : list, error: null };
      }
      if (st.op === "update") {
        const hit = matching();
        for (const r of hit) Object.assign(r, st.payload as Row);
        writes.push({ table, op: "update", payload: st.payload });
        return { data: hit, error: null };
      }
      if (st.op === "delete") {
        const hit = new Set(matching());
        tables[table] = rows().filter((r) => !hit.has(r));
        writes.push({ table, op: "delete", payload: null });
        return { data: [...hit], error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((st.op = "insert"), (st.payload = p), b),
      upsert: (p: unknown) => ((st.op = "upsert"), (st.payload = p), b),
      update: (p: unknown) => ((st.op = "update"), (st.payload = p), b),
      delete: () => ((st.op = "delete"), b),
      eq: (c: string, v: unknown) => (st.filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (st.filters.push((r) => r[c] !== v), b),
      in: (c: string, v: unknown[]) => (st.filters.push((r) => v.includes(r[c])), b),
      gte: (c: string, v: string) => (st.filters.push((r) => typeof r[c] === "string" && (r[c] as string) >= v), b),
      lte: (c: string, v: string) => (st.filters.push((r) => typeof r[c] === "string" && (r[c] as string) <= v), b),
      order: () => b,
      limit: () => b,
      range: (a: number, z: number) => ((st.range = [a, z]), b),
      single: () => ((st.single = true), b),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient, writes, tables };
}

const STORE = "store-kenku";
const NOW = new Date("2026-11-13T03:00:00.000Z");

/** #KP204474: el adelanto de S/ 30 del 08-11, cargado después de su reporte. */
function tables(payment: Row = {}): Record<string, Row[]> {
  return {
    store_collection_accounts: [{ store_id: STORE, label: "Grupo GF S.A.C.", aliases: [], active: true }],
    yape_statement_movements: [
      {
        movement_key: "mov-1",
        kind: "ingreso",
        origin: "Benjamin Hue*",
        destination: "GRUPO GF  S.A.C.",
        channel: "YAPE",
        payer_name: "Benjamin Hue*",
        amount: 30,
        occurred_at: "2026-11-09T00:43:20.000Z",
        extra: null,
      },
    ],
    order_payments: [
      {
        id: "pay-1",
        order_id: "ord-1",
        store_id: STORE,
        kind: "adelanto",
        amount: 30,
        paid_at: "2026-11-09T00:43:00.000Z",
        registered_at: "2026-11-09T01:30:00.000Z",
        validation_status: "pendiente_revision",
        operation_number: "26193682",
        operation_completed_by: null,
        payer_name: null,
        vision: { extracted: { recipient_name: "Grupo Gf S.a.c.", recipient_phone_last_digits: "309" } },
        ...payment,
      },
    ],
    order_master: [{ order_id: "ord-1", order_name: "#KP204474", customer_name: "Benjamin Huerta Carrasco" }],
  };
}

beforeEach(() => {
  h.apply.mockReset();
  h.apply.mockResolvedValue({ ok: true, confirmado: false });
  h.deliver.mockReset();
  h.deliver.mockResolvedValue({ sent: false, noKey: true, note: "" });
});

describe("rematchStoredMovements", () => {
  it("valida el comprobante cargado después de su reporte, con el movimiento ya guardado", async () => {
    const db = fakeDb(tables());
    const res = await rematchStoredMovements(db.admin, { now: NOW, budgetMs: 60_000 });
    expect(res.validados).toEqual([expect.objectContaining({ pedido: "#KP204474", monto: 30 })]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0]![1].who).toEqual({ storeId: STORE, actor: null, source: "estado_yape" });
    expect(db.tables.yape_statement_matches).toEqual([expect.objectContaining({ payment_id: "pay-1", movement_key: "mov-1", validated: true })]);
    // Queda en el registro de «Validación de pagos», marcado como recruce.
    expect(db.tables.yape_statement_imports).toEqual([
      expect.objectContaining({ validated: 1, message_id: `${REMATCH_MESSAGE_PREFIX}${NOW.toISOString()}` }),
    ]);
  });

  it("no repite: el movimiento y el comprobante ya conciliados no se vuelven a usar", async () => {
    const db = fakeDb(tables());
    await rematchStoredMovements(db.admin, { now: NOW, budgetMs: 60_000 });
    const again = await rematchStoredMovements(db.admin, { now: NOW, budgetMs: 60_000 });
    expect(again.validados).toEqual([]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(db.tables.yape_statement_imports).toHaveLength(1);
  });

  it("las mismas rejas: si pagó otra persona no lo valida, y no deja rastro", async () => {
    const db = fakeDb(tables());
    db.tables.yape_statement_movements![0]!.origin = "Rosa Pal*";
    db.tables.yape_statement_movements![0]!.payer_name = "Rosa Pal*";
    const res = await rematchStoredMovements(db.admin, { now: NOW, budgetMs: 60_000 });
    expect(res.validados).toEqual([]);
    expect(res.omitidos.otro_pagador).toBe(1);
    expect(h.apply).not.toHaveBeenCalled();
    expect(db.tables.yape_statement_imports ?? []).toEqual([]);
  });

  it("sin comprobantes pendientes no lee movimientos; el simulacro no escribe", async () => {
    const quiet = fakeDb(tables({ validation_status: "validado" }));
    expect((await rematchStoredMovements(quiet.admin, { now: NOW, budgetMs: 60_000 })).cuentas).toBe(0);
    const dry = fakeDb(tables());
    const res = await rematchStoredMovements(dry.admin, { now: NOW, budgetMs: 60_000, dryRun: true });
    expect(res.validados).toHaveLength(1);
    expect(dry.writes).toEqual([]);
  });

  it("solo los comprobantes de los últimos días", async () => {
    const db = fakeDb(tables());
    const res = await rematchStoredMovements(db.admin, { now: new Date("2026-12-01T00:00:00Z"), budgetMs: 60_000 });
    expect(res.pendientes).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe("piezas", () => {
  it("agrupa los ingresos por cuenta con su periodo", () => {
    const rows = tables().yape_statement_movements!.map((r) => storedMovement(r as never));
    const groups = movementsByAccount(rows);
    expect([...groups.keys()]).toEqual(["GRUPO GF  S.A.C."]);
    expect(groups.get("GRUPO GF  S.A.C.")).toMatchObject({ from: "2026-11-09T00:43:20.000Z", to: "2026-11-09T00:43:20.000Z" });
  });

  it("el cron corre cada media hora y el MOM lo documenta", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.find((c) => c.path === "/api/cron/yape-rematch")?.schedule).toBe("17,47 * * * *");
    expect(readFileSync("docs/mom/master-pedidos-v1.md", "utf8")).toContain("El recruce con los movimientos ya guardados (13-11-2026");
  });
});
