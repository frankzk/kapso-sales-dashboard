// Grupo GF en el escáner de Devoluciones de Almacén (05-10-2026): KP137351-S01
// y KP137320-S01 respondían «no es de Tanders ni de Shalom». Lo que vuelve de
// Grupo GF se recibe como en Despacho del día y el pedido queda por asignar.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { gfReturnDecision } from "@/lib/gf-returns-scan";

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
});

const state = vi.hoisted(() => ({
  courier: "propio",
  custody: "courier",
  inBox: true,
  stopStatus: "no_entregado" as string | null,
  cancelledAt: null as string | null,
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
  const reply = (client: string, table: string) => {
    if (table === "shipments") return { data: client === "user" ? [SHIPMENT()] : null, error: null };
    if (table === "dispatch_manifest_items") {
      return {
        data: state.inBox ? [{ id: "item-1", manifest_id: "box-1", dispatch_manifests: { route_date: "2026-10-04", driver_name: "Yhoni" } }] : [],
        error: null,
      };
    }
    if (table === "delivery_stops") return { data: state.stopStatus ? { status: state.stopStatus } : null, error: null };
    if (table === "orders") return { data: { name: "#KP137351", cancelled_at: state.cancelledAt, cancel_reason: "customer" }, error: null };
    if (table === "order_master") return { data: { order_name: "#KP137351", general_status: null }, error: null };
    return { data: [], error: null };
  };
  const from = (client: string, table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "ilike", "limit", "or", "order"]) q[m] = () => q;
    q.maybeSingle = q.single = async () => reply(client, table);
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(reply(client, table)).then(resolve, reject);
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
        return { data: "order-1", error: null };
      },
    }),
  };
});

import { receiveReturnedPackage } from "@/app/dashboard/pedidos/despacho/actions";

beforeEach(() => {
  Object.assign(state, { courier: "propio", custody: "courier", inBox: true, stopStatus: "no_entregado", cancelledAt: null, rpcs: [], recomputed: [] });
});

describe("receiveReturnedPackage con un paquete de Grupo GF", () => {
  it("un «No entregado» sale de la caja del motorizado y el pedido queda por asignar", async () => {
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toBe("KP137351-S01 recibido en oficina: vuelve a «por asignar» en Grupo GF para reprogramarlo.");
    expect(state.rpcs).toEqual([{ fn: "gf_return_to_office", args: { p_item_id: "item-1", p_actor: "persona" } }]);
    expect(state.recomputed).toEqual([["order-1"]]);
  });

  it("anulado en Shopify: se recibe igual y se dice que no vuelve a salir", async () => {
    state.cancelledAt = "2026-10-04T20:00:00Z";
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.error).toContain("recibido en oficina");
    expect(result.error).toContain("ANULADO en Shopify");
    expect(state.rpcs).toHaveLength(1);
  });

  it("#KP137351 sin courier ni caja: nunca salió, no escribe nada", async () => {
    Object.assign(state, { courier: "por_definir", custody: "empresa", inBox: false });
    const result = await receiveReturnedPackage("KP137351-S01");
    expect(result.notice).toContain("nunca salió en Kapta");
    expect(state.rpcs).toEqual([]);
  });

  it("sin reporte de la parada no se recibe", async () => {
    state.stopStatus = "pendiente";
    expect((await receiveReturnedPackage("KP137351-S01")).error).toContain("sin reporte");
    expect(state.rpcs).toEqual([]);
  });
});
