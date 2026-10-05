// El escáner de Devoluciones con una caja de Shalom (MOM §9.4, 03-10-2026):
// qué escribe al recibirla, cuándo corrige un «recogido» que era el retorno, y
// que sin poder leer la clave no decide nada.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  client: "user" | "admin";
  table: string;
  op: "select" | "update" | "insert";
  value?: Record<string, unknown>;
  filters: [string, unknown][];
}

const state = vi.hoisted(() => ({
  courier: "shalom",
  guide: {} as Record<string, unknown>,
  received: false,
  hasKey: true,
  keyViewed: false,
  keyShared: false,
  keyReadFails: false,
  raceLost: false,
  calls: [] as Call[],
  recomputed: [] as string[][],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect login"); } }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({
  recomputeOrderMasterSafe: async (_admin: unknown, ids: string[]) => {
    state.recomputed.push(ids);
  },
}));
vi.mock("@/lib/db", () => {
  const SHIPMENT = () => ({
    id: "ship-1", store_id: "store-1", courier: state.courier, guide_code: "92083386", output_number: 1,
    output_code: "KP128064-S01", qr_token: null, preparation_state: "no_iniciado", custody_state: "empresa",
    ready_at: null, order_id: "order-1", order_name: "#KP128064", customer_name: null, customer_phone: null,
    district: null, province: null, product: null,
  });
  const reply = (call: Call): { data: unknown; error: { message: string } | null } => {
    const has = (key: string, value?: unknown) => call.filters.some(([k, v]) => k === key && (value === undefined || v === value));
    if (call.op === "insert") return { data: null, error: null };
    if (call.op === "update") return { data: state.raceLost ? [] : [{ id: "ship-1" }], error: null };
    if (call.table === "shipments") return { data: call.client === "user" ? [SHIPMENT()] : state.guide, error: null };
    if (call.table === "stores") return { data: { org_id: "org-1" }, error: null };
    if (call.table === "shalom_pickup_keys") {
      return state.keyReadFails ? { data: null, error: { message: "521 origin down" } } : { data: state.hasKey ? [{ order_id: "order-1" }] : [], error: null };
    }
    if (call.table === "pickup_key_shares") return { data: state.keyShared ? [{ id: "s" }] : [], error: null };
    if (call.table === "order_events" && has("eq:kind", "return_received")) return { data: state.received ? [{ id: "r" }] : [], error: null };
    if (call.table === "order_events" && has("in:kind")) return { data: state.keyViewed ? [{ id: "v" }] : [], error: null };
    return { data: null, error: null };
  };
  const from = (client: "user" | "admin", table: string) => {
    const call: Call = { client, table, op: "select", filters: [] };
    state.calls.push(call);
    const q: Record<string, unknown> = {};
    q.select = () => q;
    for (const m of ["eq", "in", "is", "ilike", "limit", "or"]) q[m] = (col: unknown, val?: unknown) => (call.filters.push([`${m}:${String(col)}`, val]), q);
    q.update = (value: Record<string, unknown>) => ((call.op = "update"), (call.value = value), q);
    q.insert = (value: Record<string, unknown>) => ((call.op = "insert"), (call.value = value), q);
    q.maybeSingle = q.single = async () => reply(call);
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(reply(call)).then(resolve, reject);
    return q;
  };
  return {
    createServerSupabase: async () => ({
      from: (table: string) => from("user", table),
      auth: { getUser: async () => ({ data: { user: { id: "persona" } } }) },
    }),
    createAdminSupabase: () => ({ from: (table: string) => from("admin", table) }),
  };
});

import { receiveReturnedPackage } from "@/app/dashboard/pedidos/despacho/actions";

const RECOGIDA_SIN_CLAVE = {
  delivery_status: "entregado", custody_state: "empresa", returned_at: null,
  pickup_state: "recogido", dispatched_at: null, out_for_delivery_at: null,
};
const DE_VUELTA = { ...RECOGIDA_SIN_CLAVE, delivery_status: "anulado", custody_state: "retorno", pickup_state: "retorno_iniciado" };

const writes = () => state.calls.filter((c) => c.op !== "select");

beforeEach(() => {
  Object.assign(state, {
    courier: "shalom", guide: RECOGIDA_SIN_CLAVE, received: false, hasKey: true, keyViewed: false,
    keyShared: false, keyReadFails: false, raceLost: false, calls: [], recomputed: [],
  });
});

describe("receiveReturnedPackage con una caja de Shalom", () => {
  it("#KP128064: Shalom la dio por recogida, la clienta nunca tuvo la clave → se recibe y se corrige", async () => {
    const result = await receiveReturnedPackage("92083386", { returnGuide: "9690 8440" });
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("queda corregida como retorno");
    expect(result.notice).toContain("Guía de retorno 96908440 anotada");

    const [update, ...audit] = writes();
    expect(update).toMatchObject({
      client: "admin",
      table: "shipments",
      op: "update",
      value: {
        custody_state: "devuelto",
        pickup_state: "devuelto",
        returned_source: "manual",
        returned_by: "persona",
        delivery_status: "anulado",
        status_category: "closed",
      },
    });
    // Solo si sigue como se leyó: entregada y sin sellar.
    expect(update!.filters).toEqual([["eq:id", "ship-1"], ["eq:delivery_status", "entregado"], ["is:returned_at", null]]);
    expect(audit.map((c) => `${c.table}:${(c.value as { kind: string }).kind}`)).toEqual([
      "dispatch_events:return_received",
      "order_events:return_received",
    ]);
    const event = audit[1]!.value as { actor: string; note: string; payload: Record<string, unknown> };
    expect(event.actor).toBe("persona");
    expect(event.note).toContain("la clienta nunca tuvo la clave");
    expect(event.note).toContain("Guía de retorno de Shalom: 96908440");
    expect(event.payload).toMatchObject({
      correccion_recogido: true,
      guia_retorno: "96908440",
      antes: { delivery_status: "entregado", pickup_state: "recogido", custody_state: "empresa" },
    });
    expect(state.recomputed).toEqual([["order-1"]]);
  });

  it.each([
    ["se reveló en pantalla", { keyViewed: true }],
    ["se envió por WhatsApp", { keyShared: true }],
  ])("si la clave %s, no se recibe como retorno: es devolución del cliente", async (_, over) => {
    Object.assign(state, over);
    const result = await receiveReturnedPackage("92083386");
    expect(result.error).toContain("devolución del cliente");
    expect(writes()).toEqual([]);
  });

  it("sin clave registrada se escala, no se adivina", async () => {
    state.hasKey = false;
    expect((await receiveReturnedPackage("92083386")).error).toContain("no tiene clave registrada");
    expect(writes()).toEqual([]);
  });

  it("si no se puede leer la clave, no decide y pide volver a escanear", async () => {
    state.keyReadFails = true;
    const result = await receiveReturnedPackage("92083386");
    expect(result.error).toContain("Vuelve a escanearla");
    expect(writes()).toEqual([]);
  });

  it("lo que el rastreo ya dejó de vuelta solo se sella: la guía ya estaba anulada", async () => {
    state.guide = DE_VUELTA;
    const result = await receiveReturnedPackage("92083386");
    expect(result.notice).toBe("KP128064-S01 recibida en almacén.");
    const [update] = writes();
    expect(update!.value).not.toHaveProperty("delivery_status");
    expect(update!.filters).toEqual([["eq:id", "ship-1"], ["is:returned_at", null]]);
    expect((writes()[2]!.value as { payload: Record<string, unknown> }).payload).toMatchObject({
      correccion_recogido: false,
      guia_retorno: null,
    });
  });

  it("si la guía cambió entre la lectura y la escritura, no audita nada y pide repetir", async () => {
    state.raceLost = true;
    expect((await receiveReturnedPackage("92083386")).error).toContain("cambió mientras escaneabas");
    expect(writes().filter((c) => c.op === "insert")).toEqual([]);
    expect(state.recomputed).toEqual([]);
  });

  it("la misma caja dos veces se avisa sin alarma y no escribe", async () => {
    state.received = true;
    expect((await receiveReturnedPackage("92083386")).notice).toContain("ya se había recibido");
    expect(writes()).toEqual([]);
  });

  it("una guía de retorno con otra forma se rechaza antes de leer nada", async () => {
    expect((await receiveReturnedPackage("92083386", { returnGuide: "96/908" })).error).toContain("guía de retorno no es válida");
    expect(state.calls).toEqual([]);
  });

  it("las cajas de Aliclik siguen recibiéndose desde el Master", async () => {
    state.courier = "aliclik";
    expect((await receiveReturnedPackage("92083386")).error).toContain("no es de Tanders, Shalom ni Grupo GF");
    expect(writes()).toEqual([]);
  });
});
