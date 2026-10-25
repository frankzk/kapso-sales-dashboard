import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import {
  NO_ORDER_ID,
  PENDING_VOUCHER_LABEL,
  VOUCHER_AWAITING_STATUSES,
  awaitsPickupKey,
  indexPendingVouchers,
  pendingVoucherHint,
  pendingVoucherHref,
  pendingVoucherReason,
  sortHandoffWithPendingVouchers,
  withPendingVouchers,
} from "@/lib/pending-voucher";
import { applyServerFilters, withPendingVoucherFilter } from "@/lib/orders-master-access";
import { emptyFilters, hasActiveFilters, matchesFilters, type MasterFilters } from "@/lib/order-master-filters";
import { buildMasterQuery, hasQueryFilters, parseMasterQuery } from "@/lib/master-query";
import { getLeadQueueSnapshot, getStoreLeads } from "@/lib/leads-access";
import { leadMembership } from "@/lib/leads-local-update";
import type { LeadRow, OrderMasterRow } from "@/lib/types";

/**
 * «Comprobante por validar» en el Master y en Leads (MOM §16.1, owner,
 * 25-10-2026). #KP143616: la clienta depositó la diferencia, el comprobante
 * entró por la cobranza de Shalom y quedó «Pendiente de revisión»; escaló tres
 * veces y ella seguía esperando su clave, sin que el Master ni Leads lo
 * dijeran. Estas pruebas fijan que ahora se ve, que se filtra, que la ficha se
 * abre en Cobro y que se apaga con el mismo hecho que cierra el pop-up.
 */

const ORDER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function payment(over: Partial<{ order_id: string; kind: string; validation_status: string; amount: number | string | null; registered_at: string | null }> = {}) {
  return {
    order_id: ORDER,
    kind: "diferencia",
    validation_status: "pendiente_revision",
    amount: 50,
    registered_at: "2026-10-25T19:14:53.100Z",
    ...over,
  };
}

describe("qué es un comprobante por validar", () => {
  it("son los MISMOS estados que mantienen abierta la alerta de cobranza", () => {
    expect([...VOUCHER_AWAITING_STATUSES]).toEqual(["pendiente_revision", "info_incompleta"]);
    // El pop-up se cierra leyendo esta lista: si una de las dos copias cambiara
    // sola, el indicador y la alerta dejarían de apagarse a la vez.
    const sweep = readFileSync(join(process.cwd(), "lib/collection-alerts-access.ts"), "utf8");
    expect(sweep).toContain("VOUCHER_AWAITING_STATUSES");
    expect(sweep).not.toContain('s !== "pendiente_revision" && s !== "info_incompleta"');
  });

  it("indexa por pedido: cuántos, cuánto y desde cuándo; validar o rechazar lo apaga", () => {
    const index = indexPendingVouchers([
      payment({ kind: "adelanto", validation_status: "validado", amount: 30 }),
      payment({ amount: "50.00", registered_at: "2026-10-25T19:14:53.100Z" }),
      payment({ validation_status: "info_incompleta", amount: 20, registered_at: "2026-10-24T10:00:00.000Z" }),
      payment({ order_id: OTHER, validation_status: "rechazado" }),
      payment({ order_id: OTHER, validation_status: "revision_admin" }),
      payment({ order_id: OTHER, validation_status: "posible_duplicado" }),
    ]);
    expect([...index.keys()]).toEqual([ORDER]);
    expect(index.get(ORDER)).toEqual({ count: 2, amount: 70, since: "2026-10-24T10:00:00.000Z" });
  });

  it("el efectivo que remite el motorizado no es un comprobante de la clienta", () => {
    expect(indexPendingVouchers([payment({ kind: "cobro_courier" })]).size).toBe(0);
    expect(indexPendingVouchers([payment({ kind: "total" })]).size).toBe(1);
  });

  it("«espera su clave» solo en el flujo de agencia y mientras no se le haya enviado", () => {
    expect(awaitsPickupKey({ current_courier: "shalom", shipping_mode: null, key_state: "clave_bloqueada" })).toBe(true);
    expect(awaitsPickupKey({ current_courier: null, shipping_mode: "agency", key_state: null })).toBe(true);
    expect(awaitsPickupKey({ current_courier: "shalom", shipping_mode: "agency", key_state: "clave_enviada" })).toBe(false);
    expect(awaitsPickupKey({ current_courier: "aliclik", shipping_mode: "cod", key_state: null })).toBe(false);
    expect(pendingVoucherReason(true)).toBe("Comprobante por validar · espera su clave");
    expect(pendingVoucherReason(false)).toBe(PENDING_VOUCHER_LABEL);
    expect(pendingVoucherHint({ count: 1, amount: 50, since: null }, true)).toBe(
      "1 comprobante por S/ 50.00 esperando validación. Validar y enviar la clave, en Cobro.",
    );
  });

  it("lleva a la ficha del pedido en Cobro, como «Ir a validar» del pop-up", () => {
    expect(pendingVoucherHref(ORDER)).toBe(`/dashboard/pedidos?abrir=${ORDER}&ir=pagos`);
    const popup = readFileSync(join(process.cwd(), "components/collection-alerts.tsx"), "utf8");
    expect(popup).toContain("/dashboard/pedidos?abrir=${a.orderId}&ir=pagos");
  });
});

describe("Master de Pedidos: indicador y filtro rápido", () => {
  const row = (orderId: string) => ({ ...({} as OrderMasterRow), id: `m-${orderId}`, order_id: orderId });

  it("decora las filas de la página con el índice ya leído, sin consultar por fila", () => {
    const index = indexPendingVouchers([payment()]);
    const rows = withPendingVouchers([row(ORDER), row(OTHER)], index);
    expect(rows[0]!.pending_voucher).toEqual({ count: 1, amount: 50, since: "2026-10-25T19:14:53.100Z" });
    expect(rows[1]!.pending_voucher).toBeNull();
    // Lectura caída: no se afirma que no haya.
    expect(withPendingVouchers([row(ORDER)], null)[0]!.pending_voucher).toBeUndefined();
  });

  it("el filtro viaja por la URL como pv=1 y cuenta como filtro puesto", () => {
    const f: MasterFilters = { ...emptyFilters(), pendingVoucher: true };
    const params = buildMasterQuery({ filters: f, sortKey: "created", page: 1 });
    expect(params.get("pv")).toBe("1");
    expect(parseMasterQuery(new URLSearchParams("pv=1")).filters.pendingVoucher).toBe(true);
    expect(parseMasterQuery(new URLSearchParams("pv=0")).filters.pendingVoucher).toBe(false);
    expect(hasActiveFilters(f)).toBe(true);
    expect(hasQueryFilters(f)).toBe(true);
    // Los ids resueltos NO viajan por la URL.
    const withIds = { ...f, pendingVoucherOrderIds: [ORDER] };
    expect(buildMasterQuery({ filters: withIds, sortKey: "created", page: 1 }).toString()).toBe("pv=1");
  });

  const sb = createClient("http://local", "anon");
  const url = (f: MasterFilters) =>
    (applyServerFilters(sb.from("order_master").select("id"), f, new Date("2026-10-25T20:00:00Z")) as unknown as { url: URL }).url;

  it("en la base, trae los pedidos que resolvió el servidor", () => {
    const f = withPendingVoucherFilter({ ...emptyFilters(), pendingVoucher: true }, indexPendingVouchers([payment(), payment({ order_id: OTHER })]));
    expect(url(f).searchParams.get("order_id")).toBe(`in.(${ORDER},${OTHER})`);
  });

  it("sin ninguno, o con la lectura caída, no trae ninguno (nunca todos)", () => {
    const vacio = withPendingVoucherFilter({ ...emptyFilters(), pendingVoucher: true }, new Map());
    expect(url(vacio).searchParams.get("order_id")).toBe(`in.(${NO_ORDER_ID})`);
    const caido = withPendingVoucherFilter({ ...emptyFilters(), pendingVoucher: true }, null);
    expect(caido.pendingVoucherOrderIds).toBeNull();
    expect(url(caido).searchParams.get("order_id")).toBe(`in.(${NO_ORDER_ID})`);
  });

  it("sin el filtro puesto no toca la consulta", () => {
    const f = withPendingVoucherFilter(emptyFilters(), indexPendingVouchers([payment()]));
    expect(f).toEqual(emptyFilters());
    expect(url(f).searchParams.get("order_id")).toBeNull();
  });

  it("matchesFilters dice lo mismo sobre la fila decorada", () => {
    const f: MasterFilters = { ...emptyFilters(), pendingVoucher: true };
    const [con, sin] = withPendingVouchers([row(ORDER), row(OTHER)], indexPendingVouchers([payment()]));
    const base = { attempt_count: 0, courier_count: 1, comment_count: 0 } as Partial<OrderMasterRow>;
    expect(matchesFilters({ ...con, ...base } as OrderMasterRow, f)).toBe(true);
    expect(matchesFilters({ ...sin, ...base } as OrderMasterRow, f)).toBe(false);
  });

  it("la fila con comprobante abre la ficha en Cobro, y la página lee los pagos una sola vez", () => {
    const board = readFileSync(join(process.cwd(), "components/orders-master.tsx"), "utf8");
    expect(board).toContain('r.pending_voucher ? "pagos" : undefined');
    expect(board).toContain("onOpen(r.order_id, focus)");
    expect(board).toContain("label={PENDING_VOUCHER_LABEL}");
    const page = readFileSync(join(process.cwd(), "app/dashboard/pedidos/page.tsx"), "utf8");
    expect(page.match(/getPendingVoucherIndex\(/g)).toHaveLength(1);
    expect(page).toContain("withPendingVouchers(pageData.rows, pendingVouchers)");
  });
});

describe("Leads: «Atender ahora» sube a quien ya pagó y espera", () => {
  it("los comprobantes por validar van arriba, el más antiguo primero; los handoffs siguen en su orden", () => {
    const leads = [
      { id: "h1" },
      { id: "v-nuevo", pending_voucher: { since: "2026-10-25T19:00:00Z" } },
      { id: "h2" },
      { id: "v-viejo", pending_voucher: { since: "2026-10-23T10:00:00Z" } },
    ];
    expect(sortHandoffWithPendingVouchers(leads).map((l) => l.id)).toEqual(["v-viejo", "v-nuevo", "h1", "h2"]);
  });

  it("una gestión sobre su lead no lo saca de Atender ahora: solo validar o rechazar", () => {
    const lead = { needs_attention: false, handoff_at: null, category: "won", status: "ya_tiene_pedido" } as unknown as LeadRow;
    expect(leadMembership(lead).handoff).toBe(0);
    expect(
      leadMembership({ ...lead, pending_voucher: { orderId: ORDER, orderName: "#KP143616", reason: "x", amount: 50, since: null } }).handoff,
    ).toBe(1);
  });

  /**
   * Supabase de mentira, por tabla. `leads` contesta dos preguntas distintas:
   * la vista de handoffs y «los leads de estos pedidos» (con `in order_id`).
   */
  function fakeSupabase(tables: {
    handoffs: Record<string, unknown>[];
    byOrder: Record<string, unknown>[];
    payments: Record<string, unknown>[];
    master: Record<string, unknown>[];
    paymentsError?: boolean;
  }) {
    const calls: string[] = [];
    const from = (table: string) => {
      let byOrderId = false;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gte", "lte", "order", "not", "limit", "range"]) q[m] = () => q;
      q.in = (column: string) => {
        if (column === "order_id") byOrderId = true;
        return q;
      };
      q.then = (resolve: (v: unknown) => void) => {
        calls.push(`${table}${byOrderId ? ":order_id" : ""}`);
        if (table === "order_payments") {
          return resolve(tables.paymentsError ? { data: null, error: { code: "x", message: "caído" } } : { data: tables.payments, error: null });
        }
        if (table === "order_master") return resolve({ data: tables.master, error: null });
        if (table === "leads") return resolve({ data: byOrderId ? tables.byOrder : tables.handoffs, error: null });
        return resolve({ data: [], error: null });
      };
      return q;
    };
    return { client: { from, rpc: () => ({ maybeSingle: async () => ({ data: null, error: { message: "sin rpc" } }) }) }, calls };
  }

  beforeEach(() => createServerSupabaseMock.mockReset());

  it("#KP143616: la clienta de Shalom sube con «Comprobante por validar · espera su clave»", async () => {
    const { client } = fakeSupabase({
      handoffs: [{ id: "lead-handoff", needs_attention: true, handoff_at: "2026-10-25T18:00:00Z" }],
      byOrder: [{ id: "lead-kp", order_id: ORDER, needs_attention: false, handoff_at: null }],
      payments: [payment(), payment({ kind: "adelanto", validation_status: "validado" })],
      master: [{ order_id: ORDER, order_name: "#KP143616", current_courier: "shalom", shipping_mode: "agency", key_state: "clave_bloqueada" }],
    });
    createServerSupabaseMock.mockResolvedValue(client);
    const rows = await getStoreLeads(["kenku"], "handoff");
    expect(rows.map((r) => r.id)).toEqual(["lead-kp", "lead-handoff"]);
    expect(rows[0]!.pending_voucher).toEqual({
      orderId: ORDER,
      orderName: "#KP143616",
      reason: "Comprobante por validar · espera su clave",
      amount: 50,
      since: "2026-10-25T19:14:53.100Z",
    });
    expect(rows[1]!.pending_voucher).toBeUndefined();
  });

  it("un lead que ya estaba por un handoff no se duplica: gana el motivo y sube", async () => {
    const { client } = fakeSupabase({
      handoffs: [{ id: "otro" }, { id: "lead-kp", order_id: ORDER }],
      byOrder: [{ id: "lead-kp", order_id: ORDER }],
      payments: [payment()],
      master: [{ order_id: ORDER, order_name: "#KP1", current_courier: "aliclik", shipping_mode: "cod", key_state: null }],
    });
    createServerSupabaseMock.mockResolvedValue(client);
    const rows = await getStoreLeads(["kenku"], "handoff");
    expect(rows.map((r) => r.id)).toEqual(["lead-kp", "otro"]);
    // Fuera del flujo de agencia no se promete ninguna clave.
    expect(rows[0]!.pending_voucher?.reason).toBe("Comprobante por validar");
  });

  it("validado o rechazado, el lead deja de subir (nadie pulsa «Resuelto»)", async () => {
    const { client, calls } = fakeSupabase({
      handoffs: [{ id: "lead-handoff" }],
      byOrder: [{ id: "lead-kp", order_id: ORDER }],
      payments: [payment({ validation_status: "validado" })],
      master: [],
    });
    createServerSupabaseMock.mockResolvedValue(client);
    const rows = await getStoreLeads(["kenku"], "handoff");
    expect(rows.map((r) => r.id)).toEqual(["lead-handoff"]);
    // Sin comprobantes por validar no se buscan leads por pedido.
    expect(calls).not.toContain("leads:order_id");
  });

  it("si la lectura de pagos falla, Atender ahora queda como era", async () => {
    const { client } = fakeSupabase({
      handoffs: [{ id: "lead-handoff" }],
      byOrder: [{ id: "lead-kp", order_id: ORDER }],
      payments: [],
      master: [],
      paymentsError: true,
    });
    createServerSupabaseMock.mockResolvedValue(client);
    expect((await getStoreLeads(["kenku"], "handoff")).map((r) => r.id)).toEqual(["lead-handoff"]);
  });

  it("el contador de Atender ahora suma a quien sube por comprobante y no estaba ya", async () => {
    const fresh = new Date(Date.now() - 3_600_000).toISOString();
    const { client } = fakeSupabase({
      handoffs: [],
      byOrder: [
        { id: "ya-estaba", needs_attention: true, handoff_at: fresh },
        { id: "sube", needs_attention: false, handoff_at: null },
      ],
      payments: [payment(), payment({ order_id: OTHER })],
      master: [],
    });
    const rpcRow = { por_llamar: 0, handoff: 1, yape: 0, seguimientos: 0, ganados: 0, perdidos: 0, sin_llamar: 0, total: 5, last_change: "t" };
    createServerSupabaseMock.mockResolvedValue({
      ...client,
      rpc: () => ({ maybeSingle: async () => ({ data: rpcRow, error: null }) }),
    });
    const snap = await getLeadQueueSnapshot(["kenku"]);
    expect(snap.counts.handoff).toBe(2);
    // La firma cambia con quién espera: el refresco en vivo se entera al validar.
    expect(snap.signature).toMatch(/^5:t\|cv:2:/);
  });
});
