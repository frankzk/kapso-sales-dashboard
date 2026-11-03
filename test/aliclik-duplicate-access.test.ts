import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, any>[]>, fail: "", writes: [] as any[] }));

// Query double actually applies filters and pagination: catches scope errors,
// history truncation and accidentally reading the prior order's payment.
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let filters: ((r: any) => boolean)[] = [];
    let single = false;
    let start = 0, end = Infinity;
    let insert: any;
    const q: any = {
      select: () => q,
      eq: (key: string, val: any) => { filters.push((r) => r[key] === val); return q; },
      neq: (key: string, val: any) => { filters.push((r) => r[key] !== val); return q; },
      in: (key: string, values: any[]) => { filters.push((r) => values.includes(r[key])); return q; },
      order: () => q,
      range: (a: number, b: number) => { start = a; end = b + 1; return q; },
      limit: (count: number) => { end = count; return q; },
      single: () => { single = true; return q; },
      maybeSingle: () => { single = true; return q; },
      insert: (row: any) => { insert = row; return q; },
      then: (resolve: any, reject: any) => {
        if (db.fail === table) return Promise.resolve({ data: null, error: { message: "read/write failed" } }).then(resolve, reject);
        if (insert) { db.writes.push(insert); (db.tables[table] ??= []).unshift(insert); }
        const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(start, end);
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  const client = { from, auth: { getUser: async () => ({ data: { user: { id: "operator" } }, error: null }) } };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import { loadAliclikDuplicateHold } from "@/lib/aliclik-duplicate-access";
import { getAliclikDuplicateHold, resolveAliclikDuplicate } from "@/app/dashboard/pedidos/aliclik-duplicate-actions";

beforeEach(() => {
  const line_items = [{ variant_id: "52334227128540", sku: "48143430779134", quantity: 1 }];
  db.fail = "";
  db.writes = [];
  db.tables = {
    stores: [{ id: "store", org_id: "org" }, { id: "other-store", org_id: "other-org" }],
    order_master: [
      { order_id: "new", store_id: "store", customer_phone: "51912345678", coverage: "provincia_cod", region: "Cusco", province: "Cusco", district: "Cusco", shipping_mode: null },
      { order_id: "prior", store_id: "store", customer_phone: "51912345678", order_name: "#AUR177107", general_status: "anulado" },
    ],
    orders: [{ id: "new", line_items }, { id: "prior", line_items }],
    shipments: [{ id: "box", order_id: "prior", store_id: "store", guide_code: "AUR5X", courier: "aliclik", dispatched_at: "2026-09-18T21:25:31Z", returned_at: null, delivery_status: "anulado", custody_state: "courier" }],
    order_events: [], order_payments: [],
    memberships: [{ user_id: "operator", org_id: "org", role: "vendedora" }], user_permissions: [],
  };
});

describe("retención autoritativa y resolución auditada", () => {
  it("retiene incluso con pedido y guía anulados; no confunde anulación con retorno", async () => {
    expect(await loadAliclikDuplicateHold("new")).toMatchObject({ allowed: false, canResolve: true, canOverride: false, conflicts: [{ orderId: "prior" }] });
  });
  it("solo ambos con dinero validado en el pedido nuevo abre la guía", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    await resolveAliclikDuplicate("new", { decision: "both", reason: "Confirmó ambos por llamada de hoy", fingerprint: hold.fingerprint! });
    expect(db.writes[0]).toMatchObject({ actor: "operator", kind: "aliclik_duplicate_resolution", payload: { decision: "both" } });
    db.tables.order_payments!.push({ order_id: "prior", store_id: "store", kind: "total", amount: 100, validation_status: "validado" },
      { order_id: "new", store_id: "store", kind: "adelanto", amount: 20, validation_status: "pendiente_revision" },
      { order_id: "new", store_id: "store", kind: "cobro_courier", amount: 100, validation_status: "validado" });
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
    db.tables.order_payments![1]!.validation_status = "validado";
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(true);
    db.tables.order_payments![1]!.validation_status = "rechazado";
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
  });
  it("rechaza una excepción enviada directamente por la vendedora", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    expect(await resolveAliclikDuplicate("new", { decision: "exception", reason: "Cliente confirmó compra adicional", fingerprint: hold.fingerprint! })).toHaveProperty("error");
    expect(db.writes).toHaveLength(0);
  });
  it("permite al responsable, respeta revocación y no acepta rol de otra organización", async () => {
    db.tables.memberships!.push({ user_id: "operator", org_id: "other-org", role: "owner" });
    expect((await loadAliclikDuplicateHold("new")).canOverride).toBe(false);
    db.tables.memberships![0]!.role = "admin";
    const hold = await loadAliclikDuplicateHold("new");
    const saved = await resolveAliclikDuplicate("new", { decision: "exception", reason: "Se revisó la compra adicional", fingerprint: hold.fingerprint! });
    expect(saved).toMatchObject({ hold: { allowed: true } });
    db.tables.user_permissions!.push({ user_id: "operator", org_id: "org", permission: "master.override_status", granted: false });
    expect((await loadAliclikDuplicateHold("new")).canOverride).toBe(false);
  });
  it("rechaza resoluciones obsoletas cuando hay una nueva salida", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    db.tables.shipments!.push({ ...db.tables.shipments![0]!, id: "second-box" });
    expect(await resolveAliclikDuplicate("new", { decision: "both", reason: "Confirmó expresamente ambos", fingerprint: hold.fingerprint! })).toHaveProperty("error");
    expect(db.writes).toHaveLength(0);
  });
  it("revisa todas las salidas y libera solo cuando ya no queda ninguna afuera", async () => {
    db.tables.shipments!.push({ ...db.tables.shipments![0]!, id: "second-box", returned_at: "2026-09-30" });
    expect((await loadAliclikDuplicateHold("new")).conflicts).toHaveLength(1);
    db.tables.shipments![0]!.returned_at = "2026-10-01";
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(true);
  });
  it("libera KP201004 cuando Yhoni ya entregó la salida propia de KP141320", async () => {
    db.tables.order_master![0]!.order_name = "#KP201004";
    db.tables.order_master![1]!.order_name = "#KP141320";
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente", created_at: "2026-10-14T12:09:43Z" });
    db.tables.order_events!.push({ order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported",
      occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado", stop_id: "yhoni-stop" } });
    expect(await loadAliclikDuplicateHold("new")).toMatchObject({ allowed: true, conflicts: [] });
    expect(db.writes).toHaveLength(0);
  });
  it("no libera otra caja del mismo pedido por la entrega de la primera", async () => {
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente" });
    db.tables.shipments!.push({ ...db.tables.shipments![0]!, id: "second-box" });
    db.tables.order_events!.push({ order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported",
      occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado" } });
    expect((await loadAliclikDuplicateHold("new")).conflicts.map((c) => c.shipmentId)).toEqual(["second-box"]);
  });
  it.each(["pendiente", "no_entregado"])("un reporte posterior %s vuelve a retener la salida propia", async (status) => {
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente" });
    db.tables.order_events!.push(
      { order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported", occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado" } },
      { order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported", occurred_at: "2026-10-14T21:00:00Z", payload: { status } },
    );
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
  });
  it("la entrega propia no resuelve una salida de courier externo", async () => {
    db.tables.order_events!.push({ order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported",
      occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado" } });
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
  });
  it("una nueva recepción del motorizado deja sin efecto la entrega anterior", async () => {
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente" });
    db.tables.order_events!.push(
      { order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported", occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado" } },
      { order_id: "prior", store_id: "store", shipment_id: "box", kind: "custody_transferred", occurred_at: "2026-10-15T15:00:00Z", note: "Paquete cotejado y recibido por el motorizado." },
    );
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
  });
  it("lee el historial completo del motorizado y no usa eventos de otra tienda", async () => {
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente" });
    db.tables.order_events!.push(...Array.from({ length: 105 }, (_, i) => ({
      order_id: "prior", store_id: "store", shipment_id: "box", kind: "pickup_checked",
      occurred_at: `2026-10-14T15:00:${String(i % 60).padStart(2, "0")}Z`, payload: {},
    })), { order_id: "prior", store_id: "other-store", shipment_id: "box", kind: "stop_reported",
      occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado" } });
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
    db.tables.order_events!.push({ order_id: "prior", store_id: "store", shipment_id: "box", kind: "stop_reported",
      occurred_at: "2026-10-14T20:41:14Z", payload: { status: "entregado" } });
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(true);
  });
  it("el cuaderno sin salida respeta la fecha de creación y las cajas reemplazadas", async () => {
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente", created_at: "2026-10-14T12:09:43Z" });
    const report = { order_id: "prior", store_id: "store", shipment_id: null, kind: "stop_reported",
      occurred_at: "2026-10-13T20:41:14Z", payload: { status: "entregado" } };
    db.tables.order_events!.push(report);
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
    report.occurred_at = "2026-10-14T20:41:14Z";
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(true);
    db.tables.order_events!.push({ order_id: "prior", store_id: "store", shipment_id: "box", kind: "output_replaced", occurred_at: "2026-10-14T21:00:00Z" });
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
  });
  it("un fallo al leer el reporte propio retiene la guía", async () => {
    Object.assign(db.tables.shipments![0]!, { courier: "propio", delivery_status: "pendiente" });
    db.fail = "order_events";
    expect(await getAliclikDuplicateHold("new")).toHaveProperty("error");
  });
  it.each(["order_master", "stores", "shipments", "orders", "order_events", "order_payments", "memberships", "user_permissions"])("un fallo en %s cierra la compuerta", async (table) => {
    db.fail = table;
    expect(await getAliclikDuplicateHold("new")).toHaveProperty("error");
  });
  it("no trunca el historial a los 50 que se muestran en pantalla", async () => {
    db.tables.order_master!.splice(1, 0, ...Array.from({ length: 105 }, (_, i) => ({ ...db.tables.order_master![1]!, order_id: `unshipped-${i}` })));
    expect((await loadAliclikDuplicateHold("new")).conflicts[0]!.orderId).toBe("prior");
  });
  it("Lima y las tiendas de otra organización quedan fuera", async () => {
    db.tables.order_master![0]!.coverage = "lima";
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(true);
    db.tables.order_master![0]!.coverage = "provincia_cod";
    db.tables.order_master![1]!.store_id = "other-store";
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(true);
  });
});
