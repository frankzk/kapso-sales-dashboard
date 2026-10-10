// La clave de recojo por WhatsApp desde cualquier puerta (lib/pickup-key-delivery.ts,
// 10-10-2026). #KP139240: el estado de cuenta de Yape validó la diferencia que
// completaba el pago y la clave no salió; la clienta reclamó dos horas después.
// Una sola función manda la clave para el botón «Validar», el estado de cuenta
// y «Enviar clave por WhatsApp» de la ficha, con las mismas rejas.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  creds: null as Record<string, unknown> | null,
  send: vi.fn(),
}));

vi.mock("@/lib/ingest", () => ({ getStoreCreds: async () => h.creds }));
vi.mock("@/lib/kapso", () => ({ sendWhatsappText: h.send }));
vi.mock("@/lib/crypto", () => ({ decryptOrNull: (v: string | null) => (v ? "4821" : null) }));

import { deliverPickupKey } from "@/lib/pickup-key-delivery";

type Row = Record<string, unknown>;

/** Lo justo de PostgREST: lecturas por igualdad y las inserciones anotadas. */
function fakeDb(tables: Record<string, Row[]>) {
  const inserts: { table: string; row: Row }[] = [];
  const reads: string[] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let single = false;
    let insert: Row | null = null;
    const run = () => {
      if (insert) {
        inserts.push({ table, row: insert });
        return { data: null, error: null };
      }
      reads.push(table);
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      order: () => b,
      limit: () => b,
      insert: (row: Row) => ((insert = row), b),
      maybeSingle: async () => ((single = true), run()),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient, inserts, reads };
}

const ORDER = "ord-139240";
const STORE = "store-kenku";
const NOW = new Date("2026-10-10T17:20:00Z");

function tables(over: { payments?: Row[]; master?: Row; key?: boolean; lastAlert?: string | null } = {}) {
  return {
    shalom_pickup_keys: over.key === false ? [] : [{ order_id: ORDER, key_enc: "cifrada" }],
    order_master: [{
      order_id: ORDER,
      order_name: "#KP139240",
      customer_name: "Augusto",
      customer_phone: "51900000000",
      general_status: "en_proceso",
      pickup_state: "disponible_para_recojo",
      order_total: 189,
      financial_status: "paid",
      total_refunded: 0,
      payment_state: "pago_completo",
      payment_gateway: "manual",
      ...over.master,
    }],
    order_payments: over.payments ?? [
      { order_id: ORDER, kind: "adelanto", validation_status: "validado", amount: 30 },
      { order_id: ORDER, kind: "diferencia", validation_status: "validado", amount: 159 },
    ],
    orders: [{ id: ORDER, name: "#KP139240", customer_phone: "51900000000" }],
    collection_alerts: over.lastAlert === null ? [] : [{ store_id: STORE, phone: "51900000000", created_at: over.lastAlert ?? "2026-10-10T17:14:24Z" }],
  } as Record<string, Row[]>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.creds = { shalom_pickup_key_autosend_enabled: true, kapso_api_key: "k", shalom_transit_phone_number_id: "pn" };
  h.send.mockReset();
  h.send.mockResolvedValue({ ok: true, id: "wamid.1" });
});

const deliver = (db: ReturnType<typeof fakeDb>, trigger: "validar" | "estado_yape" | "ficha" = "estado_yape", actor: string | null = null) =>
  deliverPickupKey(db.admin, { storeId: STORE, orderId: ORDER, actor, trigger });

describe("deliverPickupKey", () => {
  it("#KP139240: pago completo validado por el estado de cuenta → manda la clave y lo registra sin persona", async () => {
    const db = fakeDb(tables());
    const res = await deliver(db);
    expect(res).toEqual({ sent: true, note: "Clave de recojo enviada por WhatsApp a 51900000000." });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![1]).toMatchObject({ phoneNumberId: "pn", to: "51900000000" });
    expect(h.send.mock.calls[0]![1].body).toContain("4821");

    const by = (t: string) => db.inserts.filter((i) => i.table === t).map((i) => i.row);
    expect(by("pickup_key_views")).toEqual([expect.objectContaining({
      user_id: null,
      reason: "Enviada al cliente por WhatsApp al validar el pago con el estado de cuenta de Yape.",
    })]);
    expect(by("pickup_key_shares")).toEqual([expect.objectContaining({
      shared_by: null,
      channel: "whatsapp",
      confirmed: true,
      note: "Enviada al validar el pago con el estado de cuenta de Yape. Mensaje wamid.1.",
    })]);
    expect(by("order_events")).toEqual([expect.objectContaining({
      kind: "key_shared",
      actor: null,
      source: "estado_yape",
      note: "Clave de recojo enviada por WhatsApp a 51900000000 al validar el pago con el estado de cuenta de Yape.",
    })]);
  });

  it("sin clave registrada no lee credenciales ni manda nada (casi todo lo que valida el estado de cuenta)", async () => {
    const db = fakeDb(tables({ key: false }));
    const res = await deliver(db);
    expect(res).toMatchObject({ sent: false, noKey: true });
    expect(db.reads).toEqual(["shalom_pickup_keys"]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("con solo el adelanto la clave sigue bloqueada", async () => {
    const db = fakeDb(tables({
      payments: [{ order_id: ORDER, kind: "adelanto", validation_status: "validado", amount: 30 }],
      master: { payment_state: "adelanto_validado", financial_status: "pending" },
    }));
    const res = await deliver(db);
    expect(res.sent).toBe(false);
    expect(res.note).toMatch(/^La clave no se envió: /);
    expect(h.send).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([]);
  });

  it("fuera de la ventana de 24 h de WhatsApp no la manda y pide entregarla a mano", async () => {
    const db = fakeDb(tables({ lastAlert: "2026-10-08T13:10:27Z" }));
    const res = await deliver(db);
    expect(res.sent).toBe(false);
    expect(res.note).toContain("no escribe hace más de 24 h");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("el interruptor de envío automático rige para validar y el estado de cuenta, no para la ficha", async () => {
    h.creds = { ...h.creds, shalom_pickup_key_autosend_enabled: false };
    expect((await deliver(fakeDb(tables()), "estado_yape")).note).toBe("El envío automático de la clave está apagado en esta tienda.");
    expect((await deliver(fakeDb(tables()), "validar", "u1")).sent).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
    // Desde la ficha lo decide una persona, como cuando registra una entrega.
    const db = fakeDb(tables());
    expect((await deliver(db, "ficha", "u1")).sent).toBe(true);
    const event = db.inserts.find((i) => i.table === "order_events")!.row;
    expect(event).toMatchObject({ actor: "u1", source: "manual" });
    expect(event.note).toContain("desde la ficha del pedido");
  });

  it("si WhatsApp la rechaza, no registra ninguna entrega", async () => {
    h.send.mockResolvedValue({ ok: false, error: "fuera de ventana" });
    const db = fakeDb(tables());
    const res = await deliver(db);
    expect(res).toEqual({ sent: false, note: "La clave NO se envió (fuera de ventana)." });
    expect(db.inserts).toEqual([]);
  });
});

describe("el cableado", () => {
  const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

  it("el botón «Validar» y la ficha usan la misma función; el envío viejo ya no existe", () => {
    const src = read("app/dashboard/pedidos/payment-actions.ts");
    expect(src).not.toContain("async function deliverPickupKeyByWhatsapp(");
    expect(src).toContain('trigger: "validar",');
    const ficha = src.slice(src.indexOf("export async function sendPickupKeyByWhatsapp("));
    expect(ficha).toContain('if (!perms.can("shalom.reveal_pickup_key"))');
    expect(ficha).toContain('trigger: "ficha",');
    expect(read("components/pickup-key-panel.tsx")).toContain("Enviar clave por WhatsApp");
  });
});
