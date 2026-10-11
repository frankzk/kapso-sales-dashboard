// El orquestador del estado de cuenta de Yape (MOM §16.2): lo que escribe y lo
// que NO escribe. El cruce en sí se prueba en yape-statement.test.ts; aquí se
// fija que una coincidencia se valide por el MISMO núcleo que una persona, que
// el simulacro no toque nada y que un pago que cambió de estado libere su
// movimiento.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatementMovement } from "@/lib/yape-statement/parse";

const h = vi.hoisted(() => ({
  movements: [] as StatementMovement[],
  apply: vi.fn(),
  deliver: vi.fn(),
  backfill: vi.fn(async () => ({ candidates: 0, filled: 0, unreadable: 0, amountMismatch: 0, deferred: 0 })),
}));

vi.mock("@/lib/yape-statement/parse", () => ({
  parseYapeStatement: async () => {
    const times = h.movements.map((m) => m.occurredAt).sort();
    return { movements: h.movements, unreadable: 0, from: times[0] ?? null, to: times[times.length - 1] ?? null };
  },
}));
vi.mock("@/lib/payment-validation", () => ({ applyPaymentValidation: h.apply }));
vi.mock("@/lib/pickup-key-delivery", () => ({ deliverPickupKey: h.deliver }));
vi.mock("@/lib/tanders/collection-time-backfill", () => ({ backfillCourierPaidAt: h.backfill }));
vi.mock("@/lib/collection-accounts", () => ({
  loadCollectionAccounts: async (_: unknown, ids: string[]) =>
    new Map(ids.map((id) => [id, [{ name: "Grupo GF S.A.C.", phoneLastDigits: "309" }]])),
}));

import { ingestYapeStatement } from "@/lib/yape-statement/ingest";

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

function movimiento(origin: string, amount: number, occurredAt: string): StatementMovement {
  const [channel, payerName] = origin.includes(" - ") ? origin.split(" - ") : ["YAPE", origin];
  return {
    key: `${origin}@${occurredAt}`,
    kind: "ingreso",
    origin,
    destination: "GRUPO GF  S.A.C.",
    channel: channel!,
    payerName: payerName!,
    amount,
    occurredAt,
    extra: null,
  };
}

function base(extraPayment: Row = {}) {
  return {
    store_collection_accounts: [{ store_id: STORE, label: "Grupo GF S.A.C.", aliases: [], active: true }],
    order_payments: [
      {
        id: "pay-1",
        order_id: "ord-1",
        store_id: STORE,
        kind: "adelanto",
        amount: 30,
        paid_at: "2026-10-04T14:22:00.000Z",
        registered_at: "2026-10-04T14:25:00.000Z",
        validation_status: "pendiente_revision",
        operation_number: "06519706",
        operation_completed_by: null,
        payer_name: null,
        vision: { extracted: { recipient_name: "Grupo Gf S.a.c.", recipient_phone_last_digits: "309" } },
        ...extraPayment,
      },
    ],
    order_master: [{ order_id: "ord-1", order_name: "#KP138765", customer_name: "Benito Cachique puga" }],
  } as Record<string, Row[]>;
}

const INPUT = {
  messageId: "msg-1",
  fileName: "YAPE_REPORTE_MOVIMIENTOS_04102026.xlsx",
  receivedAt: "2026-10-04T17:32:00Z",
  subject: "Te compartimos tus movimientos",
  bytes: Buffer.from("PK"),
  dryRun: false,
  budgetMs: 240_000,
};

beforeEach(() => {
  h.movements = [movimiento("Benito Cac*", 30, "2026-10-04T14:22:42.000Z")];
  h.apply.mockReset();
  h.apply.mockResolvedValue({ ok: true, confirmado: false });
  h.deliver.mockReset();
  h.deliver.mockResolvedValue({ sent: false, noKey: true, note: "El pedido no tiene clave de recojo registrada." });
  h.backfill.mockClear();
});

describe("ingestYapeStatement", () => {
  it("valida por el MISMO núcleo que una persona, firmado por el reporte", async () => {
    const db = fakeDb(base());
    const res = await ingestYapeStatement(db.admin, INPUT);

    expect(res.outcome).toBe("procesado");
    expect(res.validados).toEqual([
      expect.objectContaining({ pedido: "#KP138765", movimiento: "Benito Cac*", hora: "2026-10-04 09:22:42" }),
    ]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    const call = h.apply.mock.calls[0]![1];
    expect(call.who).toEqual({ storeId: STORE, actor: null, source: "estado_yape" });
    // Solo si sigue pendiente: una persona pudo haberlo observado entretanto.
    expect(call.onlyIfStatus).toBe("pendiente_revision");
    expect(call.payload.movimiento.origen).toBe("Benito Cac*");

    expect(db.tables.yape_statement_movements).toHaveLength(1);
    expect(db.tables.yape_statement_matches).toEqual([
      expect.objectContaining({ payment_id: "pay-1", rule: "minuto_y_clienta", validated: true }),
    ]);
    expect(db.tables.yape_statement_imports?.[0]).toEqual(expect.objectContaining({ validated: 1 }));
    expect(h.backfill).toHaveBeenCalledTimes(1);
  });

  it("el simulacro calcula y no escribe nada", async () => {
    const db = fakeDb(base());
    const res = await ingestYapeStatement(db.admin, { ...INPUT, dryRun: true });
    expect(res.outcome).toBe("simulacro");
    expect(res.validados).toHaveLength(1);
    expect(db.writes).toEqual([]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.backfill).not.toHaveBeenCalled();
  });

  it("si el pago cambió de estado antes de validar, el movimiento queda libre", async () => {
    h.apply.mockResolvedValue({ ok: false, error: "cambió", stale: true });
    const db = fakeDb(base());
    const res = await ingestYapeStatement(db.admin, INPUT);
    expect(res.validados).toHaveLength(0);
    expect(res.omitidos.cambio_de_estado).toBe(1);
    expect(db.tables.yape_statement_matches).toEqual([]);
  });

  it("un movimiento ya conciliado no se vuelve a usar", async () => {
    const tables = base();
    tables.yape_statement_matches = [{ movement_key: "Benito Cac*@2026-10-04T14:22:42.000Z", payment_id: "otro" }];
    const db = fakeDb(tables);
    const res = await ingestYapeStatement(db.admin, INPUT);
    expect(h.apply).not.toHaveBeenCalled();
    expect(res.omitidos.sin_movimiento).toBe(1);
  });

  it("si la lectura dice que el dinero fue a otra cuenta, no lo valida el cruce", async () => {
    const db = fakeDb(
      base({ vision: { extracted: { recipient_name: "Rosa Pérez", recipient_phone_last_digits: "555" } } }),
    );
    const res = await ingestYapeStatement(db.admin, INPUT);
    expect(h.apply).not.toHaveBeenCalled();
    expect(res.omitidos.receptor_no_cuadra).toBe(1);
  });

  it("un reporte de una cuenta que no es de ninguna tienda no toca nada", async () => {
    const tables = base();
    tables.store_collection_accounts = [{ store_id: STORE, label: "Otra Empresa SAC", aliases: [], active: true }];
    const db = fakeDb(tables);
    const res = await ingestYapeStatement(db.admin, INPUT);
    expect(res.outcome).toBe("sin_tienda");
    expect(h.apply).not.toHaveBeenCalled();
    expect(db.tables.yape_statement_movements ?? []).toEqual([]);
  });

  // #KP139240 (10-10-2026): el estado de cuenta validó la diferencia que
  // completaba el pago y la clave de recojo no salió. Ahora sale como cuando
  // valida una persona, con las mismas rejas (lib/pickup-key-delivery.ts).
  it("al validar, suelta la clave de recojo como una persona, y lo deja en el reporte", async () => {
    h.deliver.mockResolvedValue({ sent: true, note: "Clave de recojo enviada por WhatsApp." });
    const db = fakeDb(
      base({ kind: "diferencia", vision: { source: "wa_cobranza_shalom", extracted: { recipient_name: "Grupo Gf S.a.c.", recipient_phone_last_digits: "309" } } }),
    );
    const res = await ingestYapeStatement(db.admin, INPUT);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]![1]).toEqual({
      storeId: STORE,
      orderId: "ord-1",
      actor: null,
      trigger: "estado_yape",
      // La suelta ESTE pago, solo si es el que completa lo validado.
      releasedByPaymentId: "pay-1",
      // El comprobante llegó por WhatsApp: es su mensaje, la ventana cuenta desde ahí.
      extraInboundAt: "2026-10-04T14:25:00.000Z",
    });
    expect(res.validados[0]!.clave).toBe("enviada");
    // Después de validar, nunca antes: la reja relee el pago ya validado.
    expect(h.apply.mock.invocationCallOrder[0]!).toBeLessThan(h.deliver.mock.invocationCallOrder[0]!);
  });

  it("si la clave no sale, el reporte dice por qué; sin clave (no es de agencia), no dice nada", async () => {
    h.deliver.mockResolvedValue({ sent: false, note: "La clave NO se envió: la clienta no escribe hace más de 24 h." });
    let res = await ingestYapeStatement(fakeDb(base()).admin, INPUT);
    expect(res.validados[0]!.clave).toBe("La clave NO se envió: la clienta no escribe hace más de 24 h.");
    // Un comprobante que no llegó por WhatsApp no abre la ventana.
    expect(h.deliver.mock.calls[0]![1].extraInboundAt).toBeNull();

    h.deliver.mockResolvedValue({ sent: false, noKey: true, note: "El pedido no tiene clave de recojo registrada." });
    res = await ingestYapeStatement(fakeDb(base()).admin, INPUT);
    expect(res.validados[0]!.clave).toBeUndefined();
  });

  it("validado pero sin tiempo para la clave: el reporte lo dice, no la da por entregada", async () => {
    // El presupuesto se acaba justo al validar.
    const realNow = Date.now.bind(Date);
    h.apply.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3_600_000);
      return { ok: true, confirmado: false };
    });
    try {
      const res = await ingestYapeStatement(fakeDb(base()).admin, INPUT);
      expect(res.validados).toHaveLength(1);
      expect(h.deliver).not.toHaveBeenCalled();
      expect(res.validados[0]!.clave).toContain("envíala desde la ficha");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("no intenta la clave si el pago no llegó a validarse, ni en el simulacro", async () => {
    h.apply.mockResolvedValue({ ok: false, error: "cambió", stale: true });
    await ingestYapeStatement(fakeDb(base()).admin, INPUT);
    h.apply.mockResolvedValue({ ok: true, confirmado: false });
    await ingestYapeStatement(fakeDb(base()).admin, { ...INPUT, dryRun: true });
    expect(h.deliver).not.toHaveBeenCalled();
  });
});
