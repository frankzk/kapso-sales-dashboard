import { beforeEach, describe, expect, it, vi } from "vitest";

// Si no se puede leer cómo está un lead, no se le escribe estado (01-10-2026).
//
// Esa noche, con la base reiniciándose, la sincronización de conversaciones no
// leyó su cursor (y sin cursor pide TODAS las conversaciones), armó un `in()` de
// ~4.400 teléfonos que la pasarela devolvió con 400, y tomó cada error por «este
// lead no existe»: 2.290 leads de Kenku —ganados, gestionados, cerrados— volvieron
// a «Sin llamar». Estas pruebas cubren cada camino que decide el estado de un lead
// con una lectura que falla: ninguno puede escribir.

const { fetchAllConversationsRich } = vi.hoisted(() => ({ fetchAllConversationsRich: vi.fn() }));

vi.mock("@/lib/kapso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kapso")>()),
  fetchAllConversationsRich,
  // Las conversaciones de prueba ya vienen con forma de semilla.
  conversationToLeadSeed: (c: unknown) => c,
}));

import {
  applyHandoff,
  IN_CHUNK,
  ingestConversationEvent,
  lastDispositionAtByPhone,
  linkDraftOrdersToLeads,
  selectIn,
  syncStoreLeads,
} from "@/lib/leads-ingest";
import type { DraftOrderRow } from "@/lib/types";

interface Call {
  table: string;
  op: "select" | "upsert" | "update" | "insert" | "delete" | "rpc";
  columns?: string;
  payload?: unknown;
  filters: { method: string; column: string; value: unknown }[];
}
type Reply = { data: unknown; error: { message: string } | null };

/** Supabase de mentira: registra cada llamada y la responde con `reply`. */
function fakeSupabase(reply: (call: Call) => Reply = () => ({ data: null, error: null })) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    const b: Record<string, unknown> = {};
    const chain = (fn: (...args: unknown[]) => void) => (...args: unknown[]) => (fn(...args), b);
    b.select = chain((cols) => {
      if (call.op === "select") call.columns = cols as string;
    });
    b.upsert = chain((p) => ((call.op = "upsert"), (call.payload = p)));
    b.update = chain((p) => ((call.op = "update"), (call.payload = p)));
    b.insert = chain((p) => ((call.op = "insert"), (call.payload = p)));
    b.delete = chain(() => (call.op = "delete"));
    for (const method of ["eq", "in", "is", "not", "gte", "lte", "lt", "gt", "neq", "match", "order", "limit", "range", "or", "contains", "maybeSingle", "single"]) {
      b[method] = chain((column, value) => call.filters.push({ method, column: String(column), value }));
    }
    b.then = (resolve: (r: Reply) => unknown, reject: (e: unknown) => unknown) => {
      calls.push(call);
      return Promise.resolve().then(() => reply(call)).then(resolve, reject);
    };
    return b;
  };
  const rpc = (fn: string, args: unknown) => {
    const call: Call = { table: fn, op: "rpc", payload: args, filters: [] };
    calls.push(call);
    return Promise.resolve(reply(call));
  };
  return { client: { from, rpc } as never, calls };
}

const inValues = (call: Call) => call.filters.filter((f) => f.method === "in").map((f) => f.value as unknown[]);
const writesTo = (calls: Call[], table: string) =>
  calls.filter((c) => c.table === table && (c.op === "upsert" || c.op === "update" || c.op === "insert"));

const STORE = "store-1";
const KAPSO = { kapso_api_key: "k", whatsapp_phone_number_id: null };
const phoneOf = (i: number) => `519${String(10_000_000 + i).padStart(8, "0")}`;
const conversations = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    phone: phoneOf(i),
    kapso_conversation_id: `conv-${i}`,
    last_interaction_at: `2026-10-01T23:${String(i % 60).padStart(2, "0")}:00Z`,
  }));

beforeEach(() => {
  fetchAllConversationsRich.mockReset();
});

describe("selectIn", () => {
  it("parte los valores en trozos de IN_CHUNK y junta las filas", async () => {
    const values = Array.from({ length: 400 }, (_, i) => `v${i}`);
    const sizes: number[] = [];
    const rows = await selectIn<{ v: string }>(values, async (chunk) => {
      sizes.push(chunk.length);
      return { data: chunk.map((v) => ({ v })), error: null };
    });
    expect(IN_CHUNK).toBe(150);
    expect(sizes).toEqual([150, 150, 100]);
    expect(rows.map((r) => r.v)).toEqual(values);
  });

  it("lanza si cualquier trozo falla, en vez de seguir con lo que haya", async () => {
    const values = Array.from({ length: 400 }, (_, i) => `v${i}`);
    let n = 0;
    await expect(
      selectIn(values, async () => (++n === 2 ? { data: null, error: { message: "414 URI Too Long" } } : { data: [], error: null })),
    ).rejects.toThrow("414 URI Too Long");
  });

  it("un trozo que vuelve lleno puede venir cortado: se parte hasta que cada respuesta quepa", async () => {
    // 6 filas por valor: 150 valores son 900 filas; con el tope de 1.000, un trozo
    // de 200 (1.200 filas) volvería cortado sin avisar.
    const values = Array.from({ length: 150 }, (_, i) => `v${i}`);
    const rows = await selectIn<{ v: string; n: number }>(values, async (chunk) => {
      const all = chunk.flatMap((v) => Array.from({ length: 8 }, (_, n) => ({ v, n })));
      return { data: all.slice(0, 1000), error: null };
    });
    expect(rows).toHaveLength(150 * 8);
    expect(new Set(rows.map((r) => `${r.v}:${r.n}`)).size).toBe(150 * 8);
  });

  it("lanza si un solo valor tiene más filas de las que PostgREST devuelve", async () => {
    await expect(
      selectIn(["v0"], async () => ({ data: Array.from({ length: 1000 }, () => ({})), error: null })),
    ).rejects.toThrow("más de 1000 filas");
  });
});

describe("syncStoreLeads", () => {
  it("si no lee el cursor, no pide todas las conversaciones ni escribe nada", async () => {
    const { client, calls } = fakeSupabase((c) =>
      c.table === "sync_state" && c.op === "select" ? { data: null, error: { message: "521 origin down" } } : { data: null, error: null },
    );
    await expect(syncStoreLeads(client, STORE, KAPSO)).rejects.toThrow("cursor de leads: 521 origin down");
    expect(fetchAllConversationsRich).not.toHaveBeenCalled();
    expect(writesTo(calls, "leads")).toHaveLength(0);
    expect(writesTo(calls, "sync_state")).toHaveLength(0);
  });

  it("si no lee los leads existentes, no escribe ningún estado y el cursor se queda donde estaba", async () => {
    fetchAllConversationsRich.mockResolvedValue(conversations(400));
    const { client, calls } = fakeSupabase((c) => {
      if (c.table === "sync_state" && c.op === "select") return { data: { cursor: "2026-10-01T23:00:00Z" }, error: null };
      if (c.table === "leads" && c.op === "select" && c.columns?.includes("status")) {
        return { data: null, error: { message: "400 Bad Request" } };
      }
      return { data: [], error: null };
    });

    const res = await syncStoreLeads(client, STORE, KAPSO);

    expect(res.touched).toBe(0);
    expect(writesTo(calls, "leads")).toHaveLength(0);
    const state = writesTo(calls, "sync_state");
    expect(state).toHaveLength(1);
    expect(state[0]!.payload).toMatchObject({ source: "leads", status: "error", cursor: "2026-10-01T23:00:00Z" });
    expect((state[0]!.payload as { error: string }).error).toContain("400 Bad Request");
    // Y ninguna lectura salió con un `in()` más largo que IN_CHUNK.
    for (const c of calls) for (const v of inValues(c)) expect(v.length).toBeLessThanOrEqual(IN_CHUNK);
  });

  it("si no lee las gestiones de las asesoras, tampoco escribe", async () => {
    fetchAllConversationsRich.mockResolvedValue(conversations(3));
    const { client, calls } = fakeSupabase((c) => {
      if (c.table === "sync_state" && c.op === "select") return { data: { cursor: null }, error: null };
      if (c.table === "lead_calls") return { data: null, error: { message: "statement timeout" } };
      if (c.table === "leads" && c.op === "select") return { data: [{ id: "l1", phone: phoneOf(0) }], error: null };
      return { data: [], error: null };
    });

    const res = await syncStoreLeads(client, STORE, KAPSO);

    expect(res.touched).toBe(0);
    expect(writesTo(calls, "leads")).toHaveLength(0);
  });
});

describe("lastDispositionAtByPhone", () => {
  it("lanza en vez de devolver «nadie los gestionó»", async () => {
    const { client } = fakeSupabase((c) =>
      c.table === "leads" ? { data: null, error: { message: "timeout" } } : { data: [], error: null },
    );
    await expect(lastDispositionAtByPhone(client, STORE, [phoneOf(0)])).rejects.toThrow("timeout");
  });

  it("pide por trozos y se queda con la gestión más reciente de cada teléfono", async () => {
    const phones = Array.from({ length: 320 }, (_, i) => phoneOf(i));
    const { client, calls } = fakeSupabase((c) => {
      const ids = (inValues(c)[0] ?? []) as string[];
      if (c.table === "leads") return { data: ids.map((p) => ({ id: `lead-${p}`, phone: p })), error: null };
      return {
        data: ids.flatMap((id) => [
          { lead_id: id, occurred_at: "2026-09-30T10:00:00Z" },
          { lead_id: id, occurred_at: "2026-10-01T10:00:00Z" },
        ]),
        error: null,
      };
    });

    const out = await lastDispositionAtByPhone(client, STORE, phones);

    expect(out.size).toBe(320);
    expect(out.get(phoneOf(319))).toBe("2026-10-01T10:00:00Z");
    for (const c of calls) for (const v of inValues(c)) expect(v.length).toBeLessThanOrEqual(IN_CHUNK);
  });
});

describe("linkDraftOrdersToLeads", () => {
  const draft = (phone: string): DraftOrderRow =>
    ({
      store_id: STORE,
      draft_order_gid: `gid://shopify/DraftOrder/${phone}`,
      shopify_draft_order_id: phone,
      name: "#D1",
      status: "open",
      customer_phone: phone,
      customer_name: "Cliente",
      total_amount: 189,
      line_items: [{ title: "Producto", quantity: 1 }],
      tags: ["releasit_cod_form"],
      created_at: "2026-09-25T10:00:00Z",
      updated_at: "2026-09-25T10:00:00Z",
    }) as unknown as DraftOrderRow;

  it("si no lee los leads existentes, lanza sin escribir ninguno", async () => {
    const { client, calls } = fakeSupabase((c) =>
      c.table === "leads" && c.op === "select" ? { data: null, error: { message: "400 Bad Request" } } : { data: [], error: null },
    );
    await expect(linkDraftOrdersToLeads(client, STORE, [draft(phoneOf(0))])).rejects.toThrow("400 Bad Request");
    expect(writesTo(calls, "leads")).toHaveLength(0);
  });
});

describe("ingestConversationEvent", () => {
  const body = { conversation: { phone: phoneOf(7), kapso_conversation_id: "conv-7" } };

  it("si no lee el lead, no lo deriva desde cero", async () => {
    const { client, calls } = fakeSupabase((c) =>
      c.table === "leads" && c.op === "select" ? { data: null, error: { message: "521" } } : { data: null, error: null },
    );
    const res = await ingestConversationEvent(client, STORE, body);
    expect(res).toEqual({ ok: false, reason: "read-failed" });
    expect(writesTo(calls, "leads")).toHaveLength(0);
  });

  it("si no lee sus pedidos, tampoco", async () => {
    const { client, calls } = fakeSupabase((c) =>
      c.table === "orders" ? { data: null, error: { message: "521" } } : { data: null, error: null },
    );
    const res = await ingestConversationEvent(client, STORE, body);
    expect(res).toEqual({ ok: false, reason: "read-failed" });
    expect(writesTo(calls, "leads")).toHaveLength(0);
  });
});

describe("applyHandoff", () => {
  it("si no lee el lead, no le escribe «casi cierra» encima y deja rastro", async () => {
    const { client, calls } = fakeSupabase((c) =>
      c.table === "leads" && c.op === "select" ? { data: null, error: { message: "timeout" } } : { data: null, error: null },
    );
    const res = await applyHandoff(client, STORE, {
      handoff: { reason: "cliente_listo", context: "quiere pagar" },
      phone_number: phoneOf(9),
    });
    expect(res).toEqual({ ok: false, reason: "read-failed" });
    expect(writesTo(calls, "leads")).toHaveLength(0);
    const anomaly = calls.find((c) => c.op === "rpc" && c.table === "note_ingest_anomaly");
    expect(anomaly?.payload).toMatchObject({ p_source: "handoff", p_reason: "lectura_fallida" });
  });
});
