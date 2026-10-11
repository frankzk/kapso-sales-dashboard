import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «EL NUEVO REEMPLAZA AL ANTERIOR» TIENE QUE PODER TERMINAR (MOM §8.3).
 *
 * EL CASO. Del 02 al 10-10-2026, 4 pedidos y 15 intentos con «reemplaza», y los 4
 * terminaron en la excepción de un responsable. La opción esperaba una
 * constancia de entrega o retorno que el seguimiento no iba a traer nunca:
 *
 *   - #KP140375 → la guía Aliclik de #KP121918 quedó `transferido` en julio, y el
 *     seguimiento no vuelve a leer una guía transferida;
 *   - #KP139927 → la de #KP118726 figuraba «en ruta» desde el 30-06;
 *   - #KP139042 → «el motorizado de Aliclik extravió el anterior».
 *
 * Una vendedora no tiene la excepción. Ahora declara qué pasó con cada envío
 * anterior y la declaración pasa por la puerta que le corresponde.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, any>[]>, fail: "", writes: [] as any[] }));
const doors = vi.hoisted(() => ({
  closure: vi.fn(async (_orderId: string, _input: any): Promise<{ error?: string; notice?: string }> => ({ notice: "ok" })),
  recompute: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
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
      then: (ok: any, ko: any) => {
        if (db.fail === table) return Promise.resolve({ data: null, error: { message: "read/write failed" } }).then(ok, ko);
        if (insert) { db.writes.push({ table, ...insert }); (db.tables[table] ??= []).unshift(insert); }
        const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(start, end);
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(ok, ko);
      },
    };
    return q;
  };
  const client = { from, auth: { getUser: async () => ({ data: { user: { id: "samantha" } }, error: null }) } };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});
// Las dos puertas ya tienen sus pruebas; aquí se comprueba que se USEN.
vi.mock("@/app/dashboard/pedidos/actions", () => ({ registerClosureAction: doors.closure }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: doors.recompute }));

import {
  allowedPriorOutcomes,
  replacementOutcomesProblem,
  unresolvedDuplicateShipment,
  type DuplicateShipment,
} from "@/lib/aliclik-duplicate";
import { loadAliclikDuplicateHold } from "@/lib/aliclik-duplicate-access";
import { resolveAliclikDuplicate } from "@/app/dashboard/pedidos/aliclik-duplicate-actions";
import { resolveMacroStage, MACRO_SUBSTAGES_BY_STAGE, type ResolveMacroStageInput } from "@/lib/order-macro-stage";

const REASON = "La clienta confirmó por llamada de hoy";

beforeEach(() => {
  const line_items = [{ variant_id: "52334227128540", sku: "48143430779134", quantity: 1 }];
  db.fail = "";
  db.writes = [];
  doors.closure.mockClear();
  doors.closure.mockImplementation(async () => ({ notice: "ok" }));
  doors.recompute.mockClear();
  db.tables = {
    stores: [{ id: "store", org_id: "org" }],
    order_master: [
      { order_id: "new", order_name: "#KP140375", store_id: "store", customer_phone: "51912345678", coverage: "provincia_cod", region: "Cusco", province: "Cusco", district: "Cusco", shipping_mode: null },
      { order_id: "prior", order_name: "#KP121918", store_id: "store", customer_phone: "51912345678", general_status: "en_proceso" },
    ],
    orders: [{ id: "new", line_items }, { id: "prior", line_items }],
    // La guía de julio: transferida a Fénix y sin reporte desde el 21-07.
    shipments: [{ id: "box", order_id: "prior", store_id: "store", guide_code: "AUR5X218206466888", courier: "aliclik", dispatched_at: null, custody_transferred_at: "2026-07-14T21:55:27Z", returned_at: null, delivery_status: "transferido", custody_state: "courier" }],
    order_events: [], order_payments: [],
    // Samantha: vendedora, sin el permiso de excepción.
    memberships: [{ user_id: "samantha", org_id: "org", role: "vendedora" }], user_permissions: [],
  };
});

describe("la regla, pura", () => {
  const box: DuplicateShipment = {
    id: "box", order_id: "prior", guide_code: "AUR5X", courier: "aliclik", dispatched_at: "2026-07-14",
    custody_transferred_at: null, out_for_delivery_at: null, aliclik_reported_dispatch_date: null,
    returned_at: null, delivery_status: "transferido", custody_state: "courier", pickup_state: null,
  };

  it("una salida con destino declarado deja de ser una caja pendiente", () => {
    expect(unresolvedDuplicateShipment(box)).toBe(true);
    expect(unresolvedDuplicateShipment(box, new Set(["box"]))).toBe(false);
    expect(unresolvedDuplicateShipment(box, new Set(["otra"]))).toBe(true);
  });

  it("Aliclik admite los tres destinos; los demás couriers solo la devolución", () => {
    // Una entrega Fénix tiene su propia puerta (el resultado del courier) y la
    // indemnización formal es solo de Aliclik: una pérdida Fénix declarada
    // quedaría abierta sin nadie que pueda cerrarla.
    expect(allowedPriorOutcomes("aliclik")).toEqual(["devuelto", "entregado", "extraviado"]);
    expect(allowedPriorOutcomes("fenix")).toEqual(["devuelto"]);
  });

  it("exige un destino válido para cada salida, y no acepta salidas de más", () => {
    const conflicts = [{ shipmentId: "a", guideCode: "AUR5X1", courier: "aliclik" }, { shipmentId: "b", guideCode: "#KP1", courier: "fenix" }];
    expect(replacementOutcomesProblem(conflicts, undefined)).toMatch(/cada envío anterior/);
    expect(replacementOutcomesProblem(conflicts, { a: "entregado" })).toMatch(/#KP1/);
    expect(replacementOutcomesProblem(conflicts, { a: "entregado", b: "entregado" })).toMatch(/solo admite declarar que volvió/);
    expect(replacementOutcomesProblem(conflicts, { a: "inventado", b: "devuelto" })).toMatch(/AUR5X1/);
    expect(replacementOutcomesProblem(conflicts, { a: "entregado", b: "devuelto", c: "devuelto" })).toMatch(/cambiaron/);
    expect(replacementOutcomesProblem(conflicts, { a: "extraviado", b: "devuelto" })).toBeNull();
  });
});

describe("«reemplaza» libera la guía cuando se declara el destino", () => {
  it("sin declarar el destino no escribe nada y sigue retenido", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    expect(hold.allowed).toBe(false);
    expect(await resolveAliclikDuplicate("new", { decision: "replacement", reason: REASON, fingerprint: hold.fingerprint! })).toHaveProperty("error");
    expect(db.writes).toHaveLength(0);
  });

  it("«lo recibió el cliente» registra la entrega declarada en el pedido ANTERIOR y libera", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    const saved = await resolveAliclikDuplicate("new", {
      decision: "replacement", reason: REASON, fingerprint: hold.fingerprint!, outcomes: { box: "entregado" },
    });
    expect(saved).toMatchObject({ hold: { allowed: true } });
    // Primero la declaración —sobre el pedido y la salida anteriores—, después la resolución.
    expect(db.writes[0]).toMatchObject({
      table: "order_events", kind: "delivery_declared", order_id: "prior", shipment_id: "box",
      actor: "samantha", guide_code: "AUR5X218206466888", payload: { outcome: "entregado", replaced_by_order_id: "new" },
    });
    expect(db.writes[1]).toMatchObject({ kind: "aliclik_duplicate_resolution", order_id: "new", payload: { decision: "replacement", outcomes: { box: "entregado" } } });
    expect(doors.recompute).toHaveBeenCalledWith(expect.anything(), ["prior"]);
    // La guía del courier NO se toca: esa puerta es suya.
    expect(db.tables.shipments![0]!.delivery_status).toBe("transferido");
  });

  it("«el courier lo perdió» abre la indemnización y libera", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    const saved = await resolveAliclikDuplicate("new", {
      decision: "replacement", reason: "El motorizado de Aliclik extravió el anterior", fingerprint: hold.fingerprint!, outcomes: { box: "extraviado" },
    });
    expect(saved).toMatchObject({ hold: { allowed: true } });
    expect(db.writes[0]).toMatchObject({ kind: "courier_loss_declared", order_id: "prior", shipment_id: "box" });
  });

  it("«volvió al almacén» pasa por la recepción de devolución del pedido anterior", async () => {
    doors.closure.mockImplementation(async () => {
      db.tables.shipments![0]!.returned_at = "2026-10-10T15:00:00Z";
      return { notice: "ok" };
    });
    const hold = await loadAliclikDuplicateHold("new");
    const saved = await resolveAliclikDuplicate("new", {
      decision: "replacement", reason: REASON, fingerprint: hold.fingerprint!, outcomes: { box: "devuelto" },
    });
    expect(doors.closure).toHaveBeenCalledWith("prior", expect.objectContaining({ action: "return_receive", shipmentId: "box" }));
    expect(saved).toMatchObject({ hold: { allowed: true } });
    // La recepción escribe su propio evento; aquí solo queda la resolución.
    expect(db.writes.map((w) => w.kind)).toEqual(["aliclik_duplicate_resolution"]);
  });

  it("si la puerta de devolución se niega, no se guarda la resolución y se dice por qué", async () => {
    doors.closure.mockImplementation(async () => ({ error: "Esta salida todavía figura en la empresa; no existe custodia externa que retornar." }));
    const hold = await loadAliclikDuplicateHold("new");
    const saved = await resolveAliclikDuplicate("new", {
      decision: "replacement", reason: REASON, fingerprint: hold.fingerprint!, outcomes: { box: "devuelto" },
    });
    expect(saved).toMatchObject({ error: expect.stringContaining("AUR5X218206466888") });
    expect(db.writes).toHaveLength(0);
    expect((await loadAliclikDuplicateHold("new")).allowed).toBe(false);
  });

  it("una salida Fénix no admite declarar que se entregó", async () => {
    db.tables.shipments![0]!.courier = "fenix";
    const hold = await loadAliclikDuplicateHold("new");
    expect(await resolveAliclikDuplicate("new", {
      decision: "replacement", reason: REASON, fingerprint: hold.fingerprint!, outcomes: { box: "entregado" },
    })).toHaveProperty("error");
    expect(db.writes).toHaveLength(0);
  });

  it("la excepción sigue siendo solo del responsable", async () => {
    const hold = await loadAliclikDuplicateHold("new");
    expect(await resolveAliclikDuplicate("new", { decision: "exception", reason: REASON, fingerprint: hold.fingerprint! })).toHaveProperty("error");
    expect(db.writes).toHaveLength(0);
  });

  it("si no se pueden leer las declaraciones, la compuerta se cierra", async () => {
    // El fallo en `order_events` ya cerraba la compuerta; ahora también la cierra
    // en la lectura nueva, que va antes que la de la resolución.
    db.fail = "order_events";
    await expect(loadAliclikDuplicateHold("new")).rejects.toThrow();
  });
});

describe("el pedido anterior queda en el lugar que corresponde", () => {
  const CREATED = "2026-07-10T10:00:00.000Z";
  const base = (over: Partial<ResolveMacroStageInput> = {}) =>
    resolveMacroStage({
      order: { created_at: CREATED, cancelled_at: null, financial_status: "pending", shipping_mode: "cod", region: "Cusco", province: "Cusco", district: "Cusco" },
      guides: [{ id: "box", courier: "aliclik", delivery_status: "transferido", attempts: 1, assigned_at: CREATED, dispatched_at: null, out_for_delivery_at: null, rescheduled_at: null, returned_at: null, pickup_state: null, preparation_state: null, custody_state: "courier" }],
      events: [],
      legacy: { general: "en_proceso", operational: "pendiente_de_reprogramacion", since: CREATED },
      paymentState: null,
      ...over,
    });
  const declared = { kind: "delivery_declared", occurred_at: "2026-10-10T15:00:00.000Z", shipment_id: "box" };

  it("una entrega declarada lo lleva a Por cerrar · Entrega declarada", () => {
    expect(base({ events: [declared] })).toMatchObject({ stage: "por_cerrar", substage: "entrega_declarada" });
    expect(MACRO_SUBSTAGES_BY_STAGE.por_cerrar).toContain("entrega_declarada");
  });

  it("se cierra cuando el pedido pasa a entregado: ahí manda la liquidación", () => {
    const r = base({ events: [declared], legacy: { general: "entregado", operational: "entregado", since: CREATED } });
    expect(r.reasons).not.toContain("entrega_declarada");
    expect(r.reasons).toContain("pendiente_liquidacion");
  });

  it("y cuando alguien fija el estado DESPUÉS de la declaración, aunque no sea entregado", () => {
    // La salida para una declaración que resultó falsa: sin esto, otro pedido
    // atascado sin botón.
    const after = { kind: "status_override", occurred_at: "2026-10-11T09:00:00.000Z" };
    const before = { kind: "status_override", occurred_at: "2026-10-09T09:00:00.000Z" };
    expect(base({ events: [declared, after] }).reasons).not.toContain("entrega_declarada");
    expect(base({ events: [before, declared] }).reasons).toContain("entrega_declarada");
  });

  it("una pérdida declarada abre la indemnización, y la resolución la cierra", () => {
    const loss = { kind: "courier_loss_declared", occurred_at: "2026-10-10T15:00:00.000Z", shipment_id: "box" };
    expect(base({ events: [loss] })).toMatchObject({ stage: "por_cerrar" });
    expect(base({ events: [loss] }).reasons).toContain("indemnizacion_pendiente");
    const resolved = { kind: "indemnity_resolved", occurred_at: "2026-10-12T15:00:00.000Z", shipment_id: "box" };
    expect(base({ events: [loss, resolved] }).reasons).not.toContain("indemnizacion_pendiente");
  });

  it("finanzas puede resolver una indemnización abierta por una pérdida declarada", () => {
    const src = readFileSync(resolvePath(process.cwd(), "app/dashboard/pedidos/actions.ts"), "utf8");
    const at = src.indexOf('action === "indemnity_resolve" &&');
    expect(src.slice(at, at + 600)).toContain('["indemnity_requested", "courier_loss_declared"]');
  });
});

describe("el MOM lo dice", () => {
  it("§8.3 describe el destino declarado y la entrega declarada", () => {
    const mom = readFileSync(resolvePath(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("**Reemplaza al anterior:** quien resuelve declara qué pasó con cada envío anterior");
    expect(mom).toContain("`delivery_declared`");
    expect(mom).toContain("`courier_loss_declared`");
    expect(mom).toContain("Entrega declarada · confirmar cobro");
  });
});
