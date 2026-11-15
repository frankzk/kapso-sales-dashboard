// Grupo GF en el escáner de Devoluciones de Almacén (05-10-2026): KP137351-S01
// y KP137320-S01 respondían «no es de Tanders ni de Shalom». Lo que vuelve de
// Grupo GF se recibe como en Despacho del día y el pedido queda por asignar.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { gfReadyScanHint, gfReceptionOutcome, gfReturnDecision } from "@/lib/gf-returns-scan";

const NO_ENTREGADO = { riderName: "Yhoni", routeDate: "2026-10-04", stopStatus: "no_entregado" };

describe("gfReturnDecision", () => {
  it("un «No entregado» en la caja del motorizado se recibe", () => {
    expect(gfReturnDecision("KP1-S01", { box: NO_ENTREGADO, custodyState: "courier", receivedInOffice: false })).toEqual({ kind: "recibir" });
  });

  it("un entregado no se toca", () => {
    const d = gfReturnDecision("KP1-S01", { box: { ...NO_ENTREGADO, stopStatus: "entregado" }, custodyState: "courier", receivedInOffice: false });
    expect(d).toMatchObject({ kind: "error" });
    expect((d as { message: string }).message).toContain("Yhoni lo reportó entregado (la caja de Yhoni del 04/10)");
  });

  it.each([null, "pendiente"])("sin reporte (%s) pide que el motorizado lo reporte", (stopStatus) => {
    const d = gfReturnDecision("KP1-S01", { box: { ...NO_ENTREGADO, stopStatus }, custodyState: "courier", receivedInOffice: false });
    expect(d).toMatchObject({ kind: "error" });
    expect((d as { message: string }).message).toContain("pide a Yhoni que lo reporte «No entregado»");
  });

  it("#KP137351: sin caja y en la empresa, nunca salió: se avisa que sigue por asignar", () => {
    expect(gfReturnDecision("KP137351-S01", { box: null, custodyState: "empresa", receivedInOffice: false })).toEqual({
      kind: "aviso",
      message: "KP137351-S01 nunca salió en Kapta: no hay devolución que registrar. Sigue por asignar en Grupo GF.",
    });
  });

  it("ya recibido en oficina: se avisa sin alarma", () => {
    const d = gfReturnDecision("KP1-S01", { box: null, custodyState: "empresa", receivedInOffice: true });
    expect(d).toMatchObject({ kind: "aviso" });
    expect((d as { message: string }).message).toContain("ya estaba recibido en oficina");
  });

  it("fuera de caja y fuera de la empresa no se adivina", () => {
    expect(gfReturnDecision("KP1-S01", { box: null, custodyState: "devuelto", receivedInOffice: false })).toMatchObject({ kind: "error" });
  });

  it("anulado en la tienda ya recibido (devuelto, sin caja): lo dice sin alarma, ya fue a inventario (0307)", () => {
    const d = gfReturnDecision("KP1-S01", { box: null, custodyState: "devuelto", receivedInOffice: false, saleEnded: true });
    expect(d).toEqual({
      kind: "aviso",
      toInventory: true,
      repeat: true,
      message: "KP1-S01 ya se recibió: el pedido está anulado en la tienda (o su venta terminó), así que fue a inventario —Almacén decide stock o merma—. No vuelve a «por asignar».",
    });
    // Vivo y en la empresa: el aviso de siempre, no el de inventario.
    expect(gfReturnDecision("KP1-S01", { box: null, custodyState: "empresa", receivedInOffice: true, saleEnded: true })).toMatchObject({ kind: "aviso" });
    expect(gfReturnDecision("KP1-S01", { box: null, custodyState: "empresa", receivedInOffice: true, saleEnded: true })).not.toHaveProperty("toInventory");
  });
});

describe("gfReadyScanHint: la caja del motorizado escaneada en Armar (13-11-2026)", () => {
  it("manda a Devoluciones y pide el reporte «No entregado»", () => {
    const msg = gfReadyScanHint("KP201841-S01");
    expect(msg).toContain("KP201841-S01 está con el motorizado de Grupo GF");
    expect(msg).toContain("recíbelo en Devoluciones");
    expect(msg).toContain("«No entregado»");
  });
});

describe("gfReceptionOutcome: qué fue el escaneo (05-11-2026)", () => {
  it("recibir es una recepción nueva, también la reemplazada a stock", () => {
    expect(gfReceptionOutcome(gfReturnDecision("KP1-S01", { box: NO_ENTREGADO, custodyState: "courier", receivedInOffice: false }))).toBe("nueva");
    expect(gfReceptionOutcome(gfReturnDecision("KP1-S01", { box: NO_ENTREGADO, custodyState: "retorno", receivedInOffice: false, replaced: true }))).toBe("nueva");
  });

  it("#KP201949: ya recibido en oficina y escaneado otra vez es repetida (no suma)", () => {
    expect(gfReceptionOutcome(gfReturnDecision("KP201949-S01", { box: null, custodyState: "empresa", receivedInOffice: true }))).toBe("repetida");
  });

  it("los «ya se recibió» de la reemplazada y del anulado a inventario también son repetidas", () => {
    expect(gfReceptionOutcome(gfReturnDecision("KP1-S01", { box: null, custodyState: "devuelto", receivedInOffice: false, replaced: true }))).toBe("repetida");
    expect(gfReceptionOutcome(gfReturnDecision("KP1-S01", { box: null, custodyState: "devuelto", receivedInOffice: false, saleEnded: true }))).toBe("repetida");
  });

  it("la que ya constaba devuelta y se recibió, escaneada otra vez: repetida, no «no está en una caja»", () => {
    const d = gfReturnDecision("KP1-S01", { box: null, custodyState: "devuelto", receivedInOffice: true });
    expect(d).toEqual({ kind: "aviso", repeat: true, message: "KP1-S01 ya se recibió en oficina y consta devuelto: ya salió de la caja y no vuelve a «por asignar»." });
    expect(gfReceptionOutcome(d)).toBe("repetida");
    // Devuelta sin ninguna recepción registrada: sigue siendo para revisar.
    expect(gfReturnDecision("KP1-S01", { box: null, custodyState: "devuelto", receivedInOffice: false }).kind).toBe("error");
  });

  it("«nunca salió en Kapta» es solo informativa; un error no tiene resultado", () => {
    expect(gfReceptionOutcome(gfReturnDecision("KP137351-S01", { box: null, custodyState: "empresa", receivedInOffice: false }))).toBe("informativa");
    expect(gfReceptionOutcome(gfReturnDecision("KP1-S01", { box: { ...NO_ENTREGADO, stopStatus: "entregado" }, custodyState: "courier", receivedInOffice: false }))).toBeNull();
  });
});

const state = vi.hoisted(() => ({
  courier: "propio",
  custody: "courier",
  inBox: true,
  stopStatus: "no_entregado" as string | null,
  cancelledAt: null as string | null,
  generalStatus: null as string | null,
  /** La custodia que deja la base al recibir (null = la misma de antes). */
  custodyAfter: null as string | null,
  /** Las recepciones en oficina de la salida (`returned_to_office` / `return_received`), con su hora. */
  receivedAt: [] as string[],
  /** Lo que contesta `gf_return_to_office` cuando falla. */
  rpcError: null as string | null,
  /** Cuándo la caja soltó el paquete (`dispatch_manifest_items.removed_at`). */
  removedAt: null as string | null,
  /** Los `kind` que se pidieron a `order_events` (la lectura de las recepciones). */
  eventKinds: [] as unknown[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
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
    id: "ship-1", store_id: "store-1", courier: state.courier, guide_code: "MOM-KP137351", output_number: 1,
    output_code: "KP137351-S01", qr_token: null, preparation_state: "listo_despacho", custody_state: state.custody,
    ready_at: null, order_id: "order-1", order_name: "#KP137351", customer_name: null, customer_phone: null,
    district: null, province: null, product: null,
  });
  const reply = (client: string, table: string, many = false, single = false) => {
    if (table === "shipments") {
      return { data: client === "user" ? [SHIPMENT()] : { custody_state: state.custodyAfter ?? state.custody }, error: null };
    }
    if (table === "dispatch_manifest_items") {
      if (single) return { data: { removed_at: state.removedAt }, error: null };
      return {
        data: state.inBox ? [{ id: "item-1", manifest_id: "box-1", dispatch_manifests: { route_date: "2026-10-04", driver_name: "Yhoni" } }] : [],
        error: null,
      };
    }
    if (table === "delivery_stops") return { data: state.stopStatus ? { status: state.stopStatus } : null, error: null };
    if (table === "orders") {
      const order = { id: "order-1", name: "#KP137351", cancelled_at: state.cancelledAt, cancel_reason: "customer" };
      return { data: many ? [order] : order, error: null };
    }
    if (table === "order_master") return { data: { order_name: "#KP137351", general_status: state.generalStatus }, error: null };
    if (table === "order_events" && many && state.receivedAt.length) {
      return { data: state.receivedAt.map((at, i) => ({ id: `e${i}`, occurred_at: at })), error: null };
    }
    return { data: [], error: null };
  };
  const from = (client: string, table: string) => {
    const q: Record<string, unknown> = {};
    let many = false;
    for (const m of ["select", "eq", "is", "ilike", "limit", "or", "order"]) q[m] = () => q;
    q.in = (col: string, vals: unknown) => {
      many = true;
      if (table === "order_events" && col === "kind") state.eventKinds.push(vals);
      return q;
    };
    q.maybeSingle = q.single = async () => reply(client, table, false, true);
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(reply(client, table, many)).then(resolve, reject);
    return q;
  };
  return {
    createServerSupabase: async () => ({
      from: (table: string) => from("user", table),
      auth: { getUser: async () => ({ data: { user: { id: "persona" } } }) },
    }),
    createAdminSupabase: () => ({
      from: (table: string) => from("admin", table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcs.push({ fn, args });
        return state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: "order-1", error: null };
      },
    }),
  };
});

import { receiveReturnedPackage } from "@/app/dashboard/pedidos/despacho/actions";

beforeEach(() => {
  Object.assign(state, { courier: "propio", custody: "courier", inBox: true, stopStatus: "no_entregado", cancelledAt: null, generalStatus: null, custodyAfter: null, receivedAt: [], rpcError: null, removedAt: null, eventKinds: [], rpcs: [], recomputed: [] });
});

describe("receiveReturnedPackage con un paquete de Grupo GF", () => {
  it("un «No entregado» sale de la caja del motorizado y el pedido queda por asignar", async () => {
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toBe("KP137351-S01 recibido en oficina: vuelve a «por asignar» en Grupo GF para reprogramarlo.");
    expect(state.rpcs).toEqual([{ fn: "gf_return_to_office", args: { p_item_id: "item-1", p_actor: "persona" } }]);
    expect(state.recomputed).toEqual([["order-1"]]);
    expect(result.reception).toEqual({ outcome: "nueva", courier: "grupo_gf", label: "KP137351-S01" });
  });

  it("anulado en la tienda (owner, 04-11-2026): se recibe y va a inventario, no a «por asignar»", async () => {
    // La base (0307) lo manda a stock: custodia `devuelto` y `return_received`.
    Object.assign(state, { cancelledAt: "2026-10-04T20:00:00Z", custodyAfter: "devuelto" });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toBe(
      "KP137351-S01 recibido en oficina (Yhoni del 04/10): el pedido está ANULADO en la tienda, así que va a inventario —Almacén decide stock o merma—. No vuelve a «por asignar».",
    );
    expect(result.notice).not.toContain("por asignar» en Grupo GF");
    expect(state.rpcs).toEqual([{ fn: "gf_return_to_office", args: { p_item_id: "item-1", p_actor: "persona" } }]);
    expect(state.recomputed).toEqual([["order-1"]]);
  });

  it("reactivado en la tienda (cancelled_at nulo): como siempre, vuelve a «por asignar»", async () => {
    Object.assign(state, { cancelledAt: null, custodyAfter: "empresa" });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.notice).toBe("KP137351-S01 recibido en oficina: vuelve a «por asignar» en Grupo GF para reprogramarlo.");
  });

  it("anulado solo en Kapta (sin anular en la tienda): se recibe, vuelve a la cola y se avisa", async () => {
    Object.assign(state, { generalStatus: "anulado", custodyAfter: "empresa" });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toContain("recibido en oficina");
    expect(result.error).toContain("está ANULADO: no sale");
    expect(state.rpcs).toHaveLength(1);
    // Se recibió de verdad: suma, aunque el aviso vaya en rojo.
    expect(result.reception?.outcome).toBe("nueva");
  });

  it("#KP201949: ya recibido en oficina (16:45) y escaneado otra vez: repetida, con la hora de ESTA vuelta, sin escribir", async () => {
    // La misma salida volvió «No entregado» el 28/10, se reprogramó y volvió
    // otra vez hoy: la que se repite es la de hoy, no la del 28/10.
    Object.assign(state, { courier: "propio", custody: "empresa", inBox: false, receivedAt: ["2026-10-28T15:00:00Z", "2026-11-05T21:45:00Z"] });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("ya estaba recibido en oficina");
    expect(result.reception).toEqual({ outcome: "repetida", courier: "grupo_gf", label: "KP137351-S01", firstReceivedAt: "2026-11-05T21:45:00Z" });
    expect(state.rpcs).toEqual([]);
    // La rama a stock solo deja `return_received`: también es una recepción.
    expect(state.eventKinds).toContainEqual(["returned_to_office", "reclaimed_in_office", "return_received"]);
  });

  it("la que ya constaba devuelta, escaneada otra vez: repetida (no un error rojo), con la hora de su `return_received`", async () => {
    Object.assign(state, { courier: "propio", custody: "devuelto", inBox: false, receivedAt: ["2026-11-05T21:45:00Z"] });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("ya se recibió en oficina y consta devuelto");
    expect(result.reception).toMatchObject({ outcome: "repetida", firstReceivedAt: "2026-11-05T21:45:00Z" });
    expect(state.rpcs).toEqual([]);
  });

  it("dos lecturas a la vez: si la otra ya la recibió (misma transacción), es repetida, no error", async () => {
    Object.assign(state, { rpcError: "Ese paquete ya no está en la caja.", removedAt: "2026-11-05T21:45:00Z", receivedAt: ["2026-11-05T21:45:00Z"] });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("ya se recibió en oficina en otra lectura");
    expect(result.reception).toEqual({ outcome: "repetida", courier: "grupo_gf", label: "KP137351-S01", firstReceivedAt: "2026-11-05T21:45:00Z" });
  });

  it("…pero si la sacaron de la caja por otra vía (sin recepción de esa vez), sigue siendo el error", async () => {
    Object.assign(state, { rpcError: "Ese paquete ya no está en la caja.", removedAt: "2026-11-05T21:45:00Z", receivedAt: ["2026-10-28T15:00:00Z"] });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBe("KP137351-S01: Ese paquete ya no está en la caja.");
    expect(result.reception).toBeUndefined();
  });

  it("#KP137351 sin courier ni caja: nunca salió, no escribe nada", async () => {
    Object.assign(state, { courier: "por_definir", custody: "empresa", inBox: false });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.notice).toContain("nunca salió en Kapta");
    expect(result.reception).toEqual({ outcome: "informativa", courier: "grupo_gf", label: "KP137351-S01" });
    expect(state.rpcs).toEqual([]);
  });

  it("anulado en la tienda ya recibido (a inventario), escaneado otra vez: lo dice sin error y no escribe", async () => {
    Object.assign(state, { cancelledAt: "2026-10-04T20:00:00Z", custody: "devuelto", inBox: false });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toContain("KP137351-S01 ya se recibió: el pedido está anulado en la tienda");
    expect(result.notice).toContain("fue a inventario");
    expect(state.rpcs).toEqual([]);
  });

  it("sin reporte de la parada no se recibe", async () => {
    state.stopStatus = "pendiente";
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toContain("sin reporte");
    expect(result.reception).toBeUndefined();
    expect(state.rpcs).toEqual([]);
  });
});
