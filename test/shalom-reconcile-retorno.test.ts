// Lo que el cron de Shalom escribe cuando el rastreo dice «entregado» (MOM §12,
// 03-10-2026): el recojo de siempre, o el retorno si la clienta nunca tuvo la
// clave ni pagó y el paquete llevaba días en la agencia. Y que una lectura que
// falla no escribe nada: «no pude leer la clave» no es «no hay clave».

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { applyShalomTracking, type ShalomLiveGuide } from "@/lib/shalom/reconcile";

type Reply = { data: unknown; error: { message: string } | null };

interface Call {
  table: string;
  op: "select" | "update" | "insert";
  columns?: string;
  value?: Record<string, unknown>;
  filters: [string, unknown][];
}

/** Una base de mentira: responde por tabla y apunta cada llamada. */
function fakeAdmin(replies: Partial<Record<string, Reply>>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    b.select = (columns: string) => ((call.columns = columns), b);
    for (const m of ["eq", "in", "is", "limit"]) b[m] = (col: unknown, val?: unknown) => (call.filters.push([`${m}:${String(col)}`, val]), b);
    b.update = (value: Record<string, unknown>) => ((call.op = "update"), (call.value = value), b);
    b.insert = async (value: Record<string, unknown>) => ((call.op = "insert"), (call.value = value), { data: null, error: null });
    const result = (): Reply =>
      call.op === "select" ? (replies[table] ?? { data: [], error: null }) : (replies[`${table}:${call.op}`] ?? { data: null, error: null });
    b.maybeSingle = async () => result();
    b.then = (resolve: (r: Reply) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient, calls };
}

const GUIDE: ShalomLiveGuide = {
  id: "ship-1",
  store_id: "store-1",
  order_id: "order-1",
  guide_code: "92083386",
  delivery_status: "pendiente",
  pickup_state: "disponible_para_recojo",
};
const f = (fecha: string) => ({ fecha });
const SALIO_A_LOS_36_DIAS = {
  registrado: f("2026-08-15 08:00:43"),
  transito: f("2026-08-15 11:20:53"),
  destino: f("2026-08-17 04:48:09"),
  entregado: f("2026-09-22 10:25:24"),
};
const NOW = "2026-10-03T15:00:00.000Z";

/** #KP128064: clave registrada, nunca dada, adelanto validado y nada más. */
const SIN_CLAVE_NI_COBRO: Partial<Record<string, Reply>> = {
  shalom_pickup_keys: { data: [{ order_id: "order-1" }], error: null },
  pickup_key_shares: { data: [], error: null },
  order_events: { data: [], error: null },
  order_master: { data: { payment_state: "adelanto_validado", financial_status: "pending", total_refunded: 0 }, error: null },
};

const writes = (calls: Call[]) => calls.filter((c) => c.op !== "select");

describe("applyShalomTracking", () => {
  it("#KP128064: el «entregado» sin clave ni cobro tras 36 días se escribe como retorno", async () => {
    const { admin, calls } = fakeAdmin(SIN_CLAVE_NI_COBRO);
    expect(await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW)).toEqual({
      kind: "aplicado",
      retorno: true,
      pickupState: "retorno_iniciado",
    });
    const [update, insert] = writes(calls);
    expect(update).toMatchObject({
      table: "shipments",
      op: "update",
      value: {
        delivery_status: "anulado",
        status_category: "closed",
        pickup_state: "retorno_iniciado",
        custody_state: "retorno",
        closed_at: "2026-09-22 10:25:24",
        last_report_at: NOW,
        updated_at: NOW,
      },
      filters: [["eq:id", "ship-1"]],
    });
    expect(insert).toMatchObject({
      table: "order_events",
      op: "insert",
      value: {
        kind: "courier_status",
        source: "shalom",
        actor: null,
        occurred_at: "2026-09-22 10:25:24",
        new_status: "anulado",
        new_operational: "retorno_iniciado",
        payload: { dias_en_agencia: 36, regla: "retorno_sin_clave" },
      },
    });
  });

  it("si la clave se reveló, es un recojo y se escribe como siempre", async () => {
    const { admin, calls } = fakeAdmin({ ...SIN_CLAVE_NI_COBRO, order_events: { data: [{ id: "view" }], error: null } });
    expect(await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW)).toMatchObject({ retorno: false, pickupState: "recogido" });
    expect(writes(calls)[0]!.value).toMatchObject({ delivery_status: "entregado", status_category: "delivered", pickup_state: "recogido" });
    expect(writes(calls)[0]!.value).not.toHaveProperty("custody_state");
  });

  it("si se envió por WhatsApp, también", async () => {
    const { admin } = fakeAdmin({ ...SIN_CLAVE_NI_COBRO, pickup_key_shares: { data: [{ id: "share" }], error: null } });
    expect(await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW)).toMatchObject({ retorno: false });
  });

  it("cobrado por la web (Shopify `paid`) es un recojo aunque no haya comprobantes", async () => {
    const { admin } = fakeAdmin({
      ...SIN_CLAVE_NI_COBRO,
      order_master: { data: { payment_state: "sin_pago", financial_status: "paid", total_refunded: 0 }, error: null },
    });
    expect(await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW)).toMatchObject({ retorno: false });
  });

  it("sin fila en el Master no se adivina el cobro: se respeta el recojo", async () => {
    const { admin } = fakeAdmin({ ...SIN_CLAVE_NI_COBRO, order_master: { data: null, error: null } });
    expect(await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW)).toMatchObject({ retorno: false });
  });

  it.each(["shalom_pickup_keys", "pickup_key_shares", "order_events", "order_master"])(
    "si no se puede leer %s, no escribe nada y lo reintenta la pasada siguiente",
    async (table) => {
      const { admin, calls } = fakeAdmin({ ...SIN_CLAVE_NI_COBRO, [table]: { data: null, error: { message: "521 origin down" } } });
      const outcome = await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW);
      expect(outcome).toMatchObject({ kind: "error" });
      expect(outcome.kind === "error" && outcome.message).toContain("521 origin down");
      expect(writes(calls)).toEqual([]);
    },
  );

  it("de la clave solo pregunta si existe: nunca lee `key_enc`", async () => {
    const { admin, calls } = fakeAdmin(SIN_CLAVE_NI_COBRO);
    await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW);
    const keyReads = calls.filter((c) => c.table === "shalom_pickup_keys");
    expect(keyReads).toHaveLength(1);
    expect(keyReads[0]!.columns).toBe("order_id");
  });

  it("un hito que no es «entregado» no lee clave ni cobro", async () => {
    const { admin, calls } = fakeAdmin(SIN_CLAVE_NI_COBRO);
    const enTransito = { ...GUIDE, pickup_state: "registrado_en_agencia" };
    expect(await applyShalomTracking(admin, enTransito, { transito: f("2026-08-15 11:20:53") }, NOW)).toEqual({
      kind: "aplicado",
      retorno: false,
      pickupState: "en_transito",
    });
    expect(calls.map((c) => c.table)).toEqual(["shipments", "order_events"]);
  });

  it("sin novedad no toca la guía", async () => {
    const { admin, calls } = fakeAdmin(SIN_CLAVE_NI_COBRO);
    expect(await applyShalomTracking(admin, GUIDE, { destino: f("2026-08-17 04:48:09") }, NOW)).toEqual({ kind: "sin_cambio" });
    expect(writes(calls)).toEqual([]);
  });

  it("si falla la escritura de la guía, no deja evento en la línea de tiempo", async () => {
    const { admin, calls } = fakeAdmin({ ...SIN_CLAVE_NI_COBRO, "shipments:update": { data: null, error: { message: "deadlock" } } });
    expect(await applyShalomTracking(admin, GUIDE, SALIO_A_LOS_36_DIAS, NOW)).toMatchObject({ kind: "error" });
    expect(calls.filter((c) => c.op === "insert")).toEqual([]);
  });
});
