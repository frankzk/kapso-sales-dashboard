// «Lima trabados» (MOM §9.6, 08-11-2026): la regla pura, el reloj de días de
// reparto, lo que queda fuera, lo que la lectura de Repro Lima le da y la
// bandeja que la muestra.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LIMA_STUCK_RULES,
  calendarDaysBetween,
  fullDeliveryDaysBetween,
  limaStuck,
  limaStuckCounts,
  limaStuckItems,
  stuckFilter,
} from "@/lib/lima-stuck";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import { loadLimaPending } from "@/lib/repro-lima-pending-access";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/repro-lima",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {} }),
}));

// Domingo 08-11-2026, el día en que se midió.
const SUNDAY = "2026-11-08";
const MONDAY = "2026-11-09";

function order(extra: Partial<LimaPendingOrder> = {}): LimaPendingOrder {
  return {
    orderId: "o1", storeId: "a", storeName: "Kenku", orderName: "#KP1", customerName: "María", customerPhone: null,
    district: "Ate", orderTotal: 149, createdAt: "2026-11-05T15:00:00Z", macroSince: "2026-11-05T15:00:00Z",
    stage: "por_despachar", substage: "listo_para_asignar", courier: "por_definir", dispatchedAt: null, attempts: 0,
    hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, salesChannel: null, address: null, reference: null,
    courierPickup: null, gf: { box: null, requestDay: null, labeled: true, armed: true }, scheduledOn: null, ops: null,
    ...extra,
  };
}
const gfOps = (extra: Partial<NonNullable<LimaPendingOrder["ops"]>> = {}) => ({ liveCouriers: ["propio"], reportedStatus: null, courierDelivered: null, lastGfBox: null, ...extra });

describe("el reloj: días de reparto completos (lunes a sábado)", () => {
  it("cuenta los días enteros entre los dos, sin contar el domingo", () => {
    expect(fullDeliveryDaysBetween("2026-11-06", SUNDAY)).toBe(1); // viernes → domingo: el sábado
    expect(fullDeliveryDaysBetween("2026-11-07", SUNDAY)).toBe(0); // sábado → domingo
    expect(fullDeliveryDaysBetween("2026-11-07", MONDAY)).toBe(0); // sábado → lunes: el domingo no reparte
    expect(fullDeliveryDaysBetween("2026-11-07", "2026-11-10")).toBe(1); // sábado → martes: el lunes
    expect(fullDeliveryDaysBetween(SUNDAY, SUNDAY)).toBe(0);
    expect(fullDeliveryDaysBetween("2026-11-09", "2026-11-02")).toBe(0);
    expect(fullDeliveryDaysBetween("2026-10-26", SUNDAY)).toBe(11); // dos semanas: 12 días menos el domingo 01/11
    expect(calendarDaysBetween("2026-11-05", SUNDAY)).toBe(3);
  });
});

describe("Por despachar", () => {
  it("armado sin solicitud ni caja: trabado con un día de reparto entero, no antes", () => {
    expect(limaStuck(order({ macroSince: "2026-11-06T15:00:00Z" }), SUNDAY)).toMatchObject({ reason: "armado_sin_caja", owner: "operaciones", deliveryDays: 1, daysStuck: 2, since: "2026-11-06", courier: "Por definir" });
    // Armado el sábado: sale el lunes. El domingo y el lunes no está trabado.
    expect(limaStuck(order({ macroSince: "2026-11-07T15:00:00Z" }), SUNDAY)).toBeNull();
    expect(limaStuck(order({ macroSince: "2026-11-07T15:00:00Z" }), MONDAY)).toBeNull();
    expect(limaStuck(order({ macroSince: "2026-11-07T15:00:00Z" }), "2026-11-10")?.reason).toBe("armado_sin_caja");
  });
  it("con un día a futuro o en una caja vigente no está trabado; con un día que pasó, el reloj corre desde ese día", () => {
    expect(limaStuck(order({ programmedFor: "2026-11-09" }), SUNDAY)).toBeNull();
    expect(limaStuck(order({ gf: { box: { day: "2026-11-09", riderName: "Alexis", officeChecked: false, pickedUp: false }, requestDay: null, labeled: true, armed: true } }), SUNDAY)).toBeNull();
    expect(limaStuck(order({ ops: gfOps({ lastGfBox: { day: "2026-11-09", riderName: "Alexis" } }) }), SUNDAY)).toBeNull();
    expect(limaStuck(order({ gf: { box: null, requestDay: "2026-11-09", labeled: true, armed: true } }), SUNDAY)).toBeNull();
    const taken = limaStuck(order({ macroSince: "2026-10-30T15:00:00Z", gf: { box: null, requestDay: "2026-11-05", labeled: true, armed: true } }), SUNDAY);
    expect(taken).toMatchObject({ reason: "tomado_sin_caja", since: "2026-11-05", deliveryDays: 2, detail: "Solicitud para el jue 05/11." });
  });
  it("una caja de un día que pasó, Grupo GF que no puede llevarlo y la guía de otro courier sin recojo", () => {
    expect(limaStuck(order({ substage: "asignado_a_ruta", ops: gfOps({ lastGfBox: { day: "2026-11-05", riderName: "Yordani" } }) }), SUNDAY))
      .toMatchObject({ reason: "caja_vencida", detail: "Caja del jue 05/11 de Yordani." });
    expect(limaStuck(order({ gf: null, district: "Santa Rosa" }), SUNDAY)).toMatchObject({ reason: "sin_condiciones_gf", detail: "Distrito: Santa Rosa." });
    expect(limaStuck(order({ gf: null, courierPickup: { courier: "aliclik", date: "2026-11-06" }, macroSince: "2026-11-04T15:00:00Z" }), SUNDAY))
      .toMatchObject({ reason: "courier_no_recogio", since: "2026-11-06", courier: "Por definir" });
    expect(limaStuck(order({ gf: null, courierPickup: { courier: "aliclik", date: "2026-11-09" } }), SUNDAY)).toBeNull();
    expect(limaStuck(order({ gf: null, ops: { liveCouriers: ["fenix"], reportedStatus: null, courierDelivered: null, lastGfBox: null } }), SUNDAY))
      .toMatchObject({ reason: "courier_no_recogio", courier: "Swayp", detail: "Guía de Swayp sin recojo." });
  });
});

describe("En curso", () => {
  const curso = (extra: Partial<LimaPendingOrder> = {}) => order({ stage: "en_curso", substage: "en_reparto", courier: "propio", gf: null, ...extra });
  it("Grupo GF: dos días de reparto enteros sin reportar la parada (el 62 % reporta en 72 h)", () => {
    const ops = gfOps({ lastGfBox: { day: "2026-11-05", riderName: "Alexis" } });
    expect(limaStuck(curso({ macroSince: "2026-11-05T13:00:00Z", ops }), SUNDAY)).toMatchObject({ reason: "reparto_sin_resultado", deliveryDays: 2, courier: "Grupo GF", detail: "Alexis lo lleva desde el jue 05/11" });
    expect(limaStuck(curso({ macroSince: "2026-11-06T13:00:00Z", ops }), SUNDAY)).toBeNull();
    // La «por definir» en manos del motorizado también es de Grupo GF.
    expect(limaStuck(curso({ substage: "en_transito", courier: "por_definir", macroSince: "2026-10-01T13:00:00Z", ops: gfOps({ liveCouriers: ["por_definir"] }) }), SUNDAY))
      .toMatchObject({ reason: "reparto_sin_resultado", courier: "Grupo GF" });
  });
  it("courier externo: tres días sin resultado; Tanders, uno", () => {
    const aliclik = (since: string) => curso({ substage: "en_transito", courier: "aliclik", macroSince: since, ops: { liveCouriers: ["aliclik"], reportedStatus: "PENDING_DELIVERY · IN_AGENCY · CONFIRMED", courierDelivered: null, lastGfBox: null } });
    expect(limaStuck(aliclik("2026-11-03T13:00:00Z"), SUNDAY)).toMatchObject({ reason: "courier_sin_resultado", deliveryDays: 4, courier: "Aliclik", detail: "Último estado del courier: PENDING_DELIVERY · IN_AGENCY · CONFIRMED" });
    expect(limaStuck(aliclik("2026-11-04T13:00:00Z"), SUNDAY)?.deliveryDays).toBe(3);
    expect(limaStuck(aliclik("2026-11-05T13:00:00Z"), SUNDAY)).toBeNull();
    const tanders = curso({ substage: "en_transito", courier: "tanders", macroSince: "2026-11-06T13:00:00Z", ops: { liveCouriers: ["tanders"], reportedStatus: "PICKED", courierDelivered: null, lastGfBox: null } });
    expect(limaStuck(tanders, SUNDAY)).toMatchObject({ reason: "courier_sin_resultado", courier: "Tanders" });
  });
  it("el courier dice entregado y Kapta no cerró; una novedad con la clienta es de la asesora", () => {
    const delivered = curso({ substage: "en_transito", courier: "tanders", macroSince: "2026-10-12T13:00:00Z", ops: { liveCouriers: ["tanders"], reportedStatus: "DELIVERED", courierDelivered: { courier: "tanders" }, lastGfBox: null } });
    expect(limaStuck(delivered, SUNDAY)).toMatchObject({ reason: "entregado_sin_cierre", owner: "operaciones", detail: "Tanders lo reporta entregado." });
    const novelty = curso({ substage: "en_transito", courier: "aliclik", macroSince: "2026-11-05T13:00:00Z", ops: { liveCouriers: ["aliclik"], reportedStatus: "NOT_RESPOND · PICKED · CONFIRMED", courierDelivered: null, lastGfBox: null } });
    expect(limaStuck(novelty, SUNDAY)).toMatchObject({ reason: "novedad_con_clienta", owner: "asesora" });
    // «Reprogramado» no es una novedad de la clienta: el courier vuelve a intentarlo.
    const again = curso({ substage: "en_reparto", courier: "fenix", macroSince: "2026-11-02T13:00:00Z", ops: { liveCouriers: ["fenix"], reportedStatus: "Swayp · Reprogramado (6)", courierDelivered: null, lastGfBox: null } });
    expect(limaStuck(again, SUNDAY)?.reason).toBe("courier_sin_resultado");
  });
  it("el retorno sin llegar es de Almacén; Por reprogramar, Agencia y Swayp programada quedan fuera", () => {
    expect(limaStuck(curso({ substage: "en_retorno", courier: "fenix", macroSince: "2026-10-01T13:00:00Z" }), SUNDAY)).toMatchObject({ reason: "retorno_sin_recibir", owner: "almacen" });
    for (const substage of ["por_reprogramar_lima", "disponible_para_recojo", "pendiente_pago_diferencia", "salida_swayp_programada", "gestion_reproprovincia"]) {
      expect(limaStuck(curso({ substage, macroSince: "2026-09-01T13:00:00Z" }), SUNDAY)).toBeNull();
    }
  });
});

describe("Preparación", () => {
  const prep = (extra: Partial<LimaPendingOrder> = {}) => order({ stage: "preparacion", substage: "por_generar_rotulo", courier: null, ...extra });
  it("sin rótulo, rótulo sin armar e incidencia: un día de reparto entero", () => {
    expect(limaStuck(prep({ createdAt: "2026-11-06T15:00:00Z", macroSince: "2026-11-06T15:00:00Z" }), SUNDAY)).toMatchObject({ reason: "sin_rotulo", owner: "operaciones" });
    expect(limaStuck(prep({ createdAt: "2026-11-07T15:00:00Z", macroSince: "2026-11-07T15:00:00Z" }), SUNDAY)).toBeNull();
    expect(limaStuck(prep({ substage: "por_armar", courier: "propio" }), SUNDAY)).toMatchObject({ reason: "rotulo_sin_armar", owner: "almacen" });
    expect(limaStuck(prep({ substage: "incidencia_preparacion" }), SUNDAY)).toMatchObject({ reason: "incidencia_sin_resolver", owner: "almacen" });
    expect(limaStuck(prep({ substage: "en_caja_de_otro_pedido", macroSince: "2026-10-01T13:00:00Z" }), SUNDAY)).toBeNull();
  });
  it("«Programar envío» a futuro lo espera; el que no salió el día programado está trabado desde ese día", () => {
    expect(limaStuck(prep({ scheduledOn: "2026-11-10", macroSince: "2026-11-02T15:00:00Z" }), SUNDAY)).toBeNull();
    expect(limaStuck(prep({ scheduledOn: "2026-11-05", macroSince: "2026-11-02T15:00:00Z" }), SUNDAY)).toMatchObject({ reason: "sin_rotulo", since: "2026-11-05", detail: "Debía salir el jue 05/11." });
  });
  it("más de 30 días sin rótulo: la asesora confirma si la venta sigue", () => {
    expect(limaStuck(prep({ createdAt: "2026-06-26T15:00:00Z", macroSince: "2026-06-26T15:00:00Z" }), SUNDAY)).toMatchObject({ reason: "sin_rotulo_antiguo", owner: "asesora", detail: "Compra del vie 26/06." });
  });
});

describe("la lista y las cifras", () => {
  it("ordena por motivo (Por despachar primero) y por lo que más lleva; cuenta por motivo", () => {
    const rows = [
      order({ orderId: "a", stage: "preparacion", substage: "por_armar", macroSince: "2026-11-02T15:00:00Z" }),
      order({ orderId: "b", macroSince: "2026-11-05T15:00:00Z" }),
      order({ orderId: "c", macroSince: "2026-10-20T15:00:00Z" }),
      order({ orderId: "d", stage: "por_confirmar", substage: "sin_llamar", macroSince: "2026-10-20T15:00:00Z" }),
    ];
    const items = limaStuckItems(rows, SUNDAY);
    expect(items.map((i) => i.orderId)).toEqual(["c", "b", "a"]);
    const counts = limaStuckCounts(items);
    expect(counts.armado_sin_caja).toBe(2);
    expect(counts.rotulo_sin_armar).toBe(1);
    expect(Object.keys(counts)).toHaveLength(LIMA_STUCK_RULES.length);
  });
  it("cada regla tiene umbral, responsable y siguiente paso; solo de las tres etapas del flujo", () => {
    for (const rule of LIMA_STUCK_RULES) {
      expect(rule.threshold).toBeGreaterThanOrEqual(1);
      expect(rule.action.length).toBeGreaterThan(10);
      expect(["almacen", "operaciones", "asesora"]).toContain(rule.owner);
      expect(["preparacion", "por_despachar", "en_curso"]).toContain(rule.stage);
    }
    expect(stuckFilter("armado_sin_caja")).toBe("armado_sin_caja");
    expect(stuckFilter("todos")).toBe("todos");
    expect(stuckFilter("por_cerrar")).toBeNull();
    expect(stuckFilter(null)).toBeNull();
  });
});

type DBRow = Record<string, unknown>;
function database(tables: Record<string, DBRow[]>) {
  const from = vi.fn((table: string) => {
    const filters: Array<(r: DBRow) => boolean> = [];
    let range: [number, number] | null = null;
    const q = {
      select: () => q,
      in: (key: string, values: unknown[]) => { filters.push((r) => values.includes(r[key])); return q; },
      eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return q; },
      is: (key: string, value: unknown) => { filters.push((r) => (r[key] ?? null) === value); return q; },
      gte: (key: string, value: string) => { filters.push((r) => String(r[key] ?? "") >= value); return q; },
      neq: (key: string, value: unknown) => { filters.push((r) => r[key] !== value); return q; },
      not: (key: string, op: string, value: string) => {
        const banned = op === "in" ? value.replace(/[()]/g, "").split(",") : [value];
        filters.push((r) => !banned.includes(String(r[key])));
        return q;
      },
      order: () => q,
      range: (a: number, b: number) => { range = [a, b]; return q; },
      then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        const rows = (table === "stores" ? [{ id: "a", name: "Kenku", org_id: "org" }] : tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }).then(ok, ko);
      },
    };
    return q;
  });
  const rpc = vi.fn(async () => ({ data: [], error: null }));
  return { admin: { from, rpc } as unknown as Parameters<typeof loadLimaPending>[0], from };
}

describe("lo que la lectura de Repro Lima le da (sin consultas nuevas por fila)", () => {
  it("las salidas vivas, el último reporte, el «entregado» del courier, la última caja de Grupo GF y el envío programado", async () => {
    const master = (id: string, extra: DBRow) => ({ order_id: id, store_id: "a", order_name: `#${id}`, customer_name: "Ana", customer_phone: null, district: "Ate", order_total: "99", order_created_at: "2026-11-01T15:00:00Z", macro_since: "2026-11-02T15:00:00Z", coverage: "lima", current_courier: null, dispatched_at: null, attempt_count: 0, ...extra });
    const db = database({
      order_master: [
        master("o1", { macro_stage: "en_curso", macro_substage: "en_reparto", current_courier: "propio" }),
        master("o2", { macro_stage: "en_curso", macro_substage: "en_transito", current_courier: "tanders" }),
        master("o3", { macro_stage: "preparacion", macro_substage: "por_generar_rotulo", dispatch_scheduled_on: "2026-11-10" }),
        master("o4", { macro_stage: "por_confirmar", macro_substage: "sin_llamar" }),
      ],
      shipments: [
        { id: "s1", order_id: "o1", courier: "propio", delivery_status: "pendiente", created_at: "2026-11-02T10:00:00Z" },
        { id: "s2", order_id: "o2", courier: "tanders", delivery_status: "en_ruta", reported_status: "DELIVERED", created_at: "2026-10-20T10:00:00Z" },
        { id: "s2old", order_id: "o2", courier: "aliclik", delivery_status: "anulado", returned_at: "2026-10-19T10:00:00Z", created_at: "2026-10-10T10:00:00Z" },
        { id: "s4", order_id: "o4", courier: "aliclik", delivery_status: "pendiente", created_at: "2026-11-02T10:00:00Z" },
      ],
      dispatch_manifest_items: [{ id: "i1", shipment_id: "s1", manifest_id: "m1", office_checked_at: null, pickup_checked_at: "2026-11-02T13:00:00Z", removed_at: null }],
      dispatch_manifests: [{ id: "m1", route_date: "2026-11-02", driver_name: "Roy", courier: "propio", kind: "reparto", state: "in_custody" }],
    });
    const rows = await loadLimaPending(db.admin, { userId: "u", storeIds: new Set(["a"]) }, new Date("2026-11-08T15:00:00Z"));
    const by = Object.fromEntries(rows.map((r) => [r.orderId, r]));
    expect(by.o1!.ops).toEqual({ liveCouriers: ["propio"], reportedStatus: null, courierDelivered: null, lastGfBox: { day: "2026-11-02", riderName: "Roy" } });
    expect(by.o2!.ops).toEqual({ liveCouriers: ["tanders"], reportedStatus: "DELIVERED", courierDelivered: { courier: "tanders" }, lastGfBox: null });
    expect(by.o3).toMatchObject({ scheduledOn: "2026-11-10", ops: null });
    // Por confirmar no es de esta bandeja: no se leen sus salidas.
    expect(by.o4!.ops).toBeNull();
    expect(limaStuck(by.o1!, SUNDAY)).toMatchObject({ reason: "reparto_sin_resultado", detail: "Roy lo lleva desde el lun 02/11" });
    expect(limaStuck(by.o2!, SUNDAY)?.reason).toBe("entregado_sin_cierre");
    expect(limaStuck(by.o3!, SUNDAY)).toBeNull();
    // Las salidas se leen en lote por `order_id`, una vez.
    const shipmentReads = db.from.mock.calls.filter(([table]) => table === "shipments").length;
    expect(shipmentReads).toBeLessThanOrEqual(3);
  });
});

describe("la bandeja", () => {
  it("muestra las cifras por motivo y, con la lista abierta, pedido, cliente, courier, estado, días, motivo y siguiente paso", async () => {
    const { LimaStuckTray } = await import("@/components/lima-stuck-tray");
    const rows = [
      order({ orderId: "a", orderName: "#KP201072", macroSince: "2026-10-30T15:00:00Z" }),
      order({ orderId: "b", orderName: "#KP134572", customerName: "Rosa", stage: "en_curso", substage: "en_reparto", courier: "propio", gf: null, macroSince: "2026-09-16T15:00:00Z", ops: gfOps({ lastGfBox: { day: "2026-09-16", riderName: "Yhoni" } }) }),
    ];
    const closed = renderToStaticMarkup(createElement(LimaStuckTray, { rows, today: SUNDAY, selected: null, onSelect: () => {} }));
    expect(closed).toContain("Lima trabados");
    expect(closed).toContain("Armado sin caja de reparto");
    expect(closed).toContain("En reparto sin resultado del motorizado");
    expect(closed).toContain("Ver la lista");
    expect(closed).not.toContain("#KP201072");
    const open = renderToStaticMarkup(createElement(LimaStuckTray, { rows, today: SUNDAY, selected: "todos", onSelect: () => {} }));
    for (const text of ["#KP201072", "#KP134572", "Rosa", "Grupo GF", "Por despachar", "En curso", "9 días", "Yhoni lo lleva desde el mié 16/09", "Operaciones", "Ponerlo en la caja del próximo reparto"]) {
      expect(open).toContain(text);
    }
    expect(open).toContain("ficha=a");
    const one = renderToStaticMarkup(createElement(LimaStuckTray, { rows, today: SUNDAY, selected: "reparto_sin_resultado", onSelect: () => {} }));
    expect(one).toContain("#KP134572");
    expect(one).not.toContain("#KP201072");
  });
  it("vive en Repro Lima, fuera de «Reintentos Aliclik», con el motivo en la URL", () => {
    const board = readFileSync(resolve(process.cwd(), "components/repro-lima-board.tsx"), "utf8");
    expect(board).toContain("{!retriesOnly && <LimaStuckTray rows={scoped} today={today} selected={stuck} onSelect={chooseStuck} />}");
    expect(board).toContain('stuckFilter(searchParams.get("trabado"))');
  });
});

describe("el courier de la fila", () => {
  it("lleva el detalle del Master: el motorizado o el transporte de Aliclik", () => {
    const gf = order({ stage: "en_curso", substage: "en_reparto", courier: "propio", courierDetail: "Alexis", gf: null, macroSince: "2026-11-02T13:00:00Z", ops: gfOps() });
    expect(limaStuck(gf, SUNDAY)?.courier).toBe("Grupo GF · Alexis");
    const ali = order({ stage: "en_curso", substage: "en_transito", courier: "aliclik", courierDetail: "AUTOECOM", gf: null, macroSince: "2026-11-02T13:00:00Z", ops: { liveCouriers: ["aliclik"], reportedStatus: null, courierDelivered: null, lastGfBox: null } });
    expect(limaStuck(ali, SUNDAY)?.courier).toBe("Aliclik · AUTOECOM");
  });
});
