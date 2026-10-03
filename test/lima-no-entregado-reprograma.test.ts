// En Lima, lo que un courier no entrega pasa a «Por reprogramar Lima» (v1.23,
// 30-09-2026). Solo la entrega lleva a cerrar y solo la anulación en Shopify
// termina la venta (owner).
//
// EL CASO. #AUR177276 salió con Tanders el 23-09 y volvió: su caja se escaneó
// en Devoluciones el 29-09. Tanders no dijo `RETURNED` sino `CANCELLED`, que la
// regla de la v1.19 dejaba fuera porque «no dice que saliera». La salida sí lo
// decía, así que el pedido —vivo en Shopify— cayó en «Por cerrar · Devolución
// pendiente de inventario» y el drawer pedía «Reabrir primero» para elegir
// otro courier.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TANDERS_RECOVERY_DAYS,
  guideAnnulledAfterDispatch,
  guideFailedAfterDispatch,
  recoveryWindow,
} from "@/lib/reproprovincia";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import { resolveMacroStage, type MacroGuideSnapshot, type MacroOrderSnapshot } from "@/lib/order-macro-stage";
import { failedOutputLabel, lastFailedOutput, outputsBlockingRetry } from "@/lib/gf-retry";
import { masterEffects, stopEffect } from "@/lib/routes";
import { lineEffect } from "@/lib/settlements";

const NOW = "2026-09-30T15:00:00.000Z";
const hace = (dias: number) => new Date(Date.parse(NOW) - dias * 86_400_000).toISOString();
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function salida(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: "g1",
    courier: "tanders",
    guide_code: "TANDER17901155761936688",
    delivery_status: "anulado",
    attempts: 0,
    assigned_at: hace(8),
    dispatched_at: hace(7),
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    reported_status: "CANCELLED",
    created_at: hace(8),
    updated_at: hace(0),
    ...over,
  };
}

/** #AUR177276 tal como estaba: Tanders `CANCELLED`, la caja escaneada de vuelta. */
const AUR177276 = { returned_at: hace(1), pickup_state: "devuelto" } as const;

function pedido(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return { created_at: hace(9), cancelled_at: null, financial_status: "pending", shipping_mode: "cod", ...over };
}

function macroGuia(g: GuideSnapshot): MacroGuideSnapshot {
  return {
    id: g.id,
    courier: g.courier,
    delivery_status: g.delivery_status,
    attempts: g.attempts,
    assigned_at: g.assigned_at,
    dispatched_at: g.dispatched_at,
    out_for_delivery_at: g.out_for_delivery_at,
    rescheduled_at: g.rescheduled_at,
    returned_at: g.returned_at,
    pickup_state: g.pickup_state,
    preparation_state: "listo_despacho",
    custody_state: g.returned_at ? "devuelto" : g.dispatched_at ? "courier" : "empresa",
    reported_status: g.reported_status,
    closed_at: g.closed_at,
    updated_at: g.updated_at,
  };
}

const lima = (over: Partial<MacroOrderSnapshot> = {}): MacroOrderSnapshot => ({
  created_at: hace(9),
  confirmation_activation_date: "2026-06-01",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  coverage: "lima",
  region: "Lima",
  province: "Lima",
  district: "Villa El Salvador",
  ...over,
});

/** De punta a punta: el legado sale del MISMO `resolveOrderState`. */
function resolverTodo(guides: GuideSnapshot[], o = pedido(), events: { kind: string; occurred_at: string; shipment_id?: string }[] = []) {
  // El inventario conciliado es un evento de la salida: no cambia el estado del pedido.
  const legacy = resolveOrderState({ order: o, guides, events: [], override: null, now: NOW, recoveryWindowDays: 30 });
  const macro = resolveMacroStage({
    order: lima({ cancelled_at: o.cancelled_at }),
    guides: guides.map(macroGuia),
    events,
    legacy: { general: legacy.general, operational: legacy.operational, since: legacy.since },
    paymentState: "sin_pago",
    recoveryWindowDays: 30,
    now: NOW,
  });
  return { legacy, macro };
}

describe("una guía anulada DESPUÉS de salir es un intento fallido, con cualquier courier de Lima", () => {
  it("Tanders `CANCELLED` que salió; el que no salió sigue siendo una corrección", () => {
    expect(guideAnnulledAfterDispatch(salida())).toBe(true);
    expect(guideAnnulledAfterDispatch(salida({ dispatched_at: null }))).toBe(false);
    // Sin `dispatched_at` pero con la caja ya de vuelta: salió.
    expect(guideAnnulledAfterDispatch(salida({ dispatched_at: null, returned_at: hace(1) }))).toBe(true);
  });

  it("Swayp Cancelada, Axel, Urpi y Grupo GF anulados con la caja fuera, también", () => {
    for (const courier of ["fenix", "swayp", "axel", "urpi", "propio"]) {
      expect(guideFailedAfterDispatch(salida({ courier, reported_status: null })), courier).toBe(true);
    }
  });

  it("no con la guía viva ni entregada: eso no es «anulada»", () => {
    expect(guideAnnulledAfterDispatch(salida({ delivery_status: "en_ruta", reported_status: "PICKED" }))).toBe(false);
    expect(guideAnnulledAfterDispatch(salida({ delivery_status: "entregado", reported_status: "DELIVERED" }))).toBe(false);
  });

  it("Aliclik conserva su propia regla (la etiqueta) y las agencias no reparten", () => {
    // Una Aliclik anulada sin etiqueta de intento fallido es la tienda anulando.
    expect(guideFailedAfterDispatch(salida({ courier: "aliclik", reported_status: "ANULADO POR TIENDA" }))).toBe(false);
    for (const courier of ["shalom", "olva"]) {
      expect(guideFailedAfterDispatch(salida({ courier, reported_status: null })), courier).toBe(false);
    }
  });

  it("la ventana se ancla en la salida y Tanders conserva sus 65 días", () => {
    const w = recoveryWindow([salida(AUR177276)], [], NOW, 30);
    expect(w?.closedAt).toBe(hace(7));
    expect(w?.deadline).toBe(new Date(Date.parse(hace(7)) + TANDERS_RECOVERY_DAYS * 86_400_000).toISOString());
    const axel = recoveryWindow([salida({ courier: "axel", reported_status: null })], [], NOW, 30);
    expect(axel?.deadline).toBe(new Date(Date.parse(hace(7)) + 30 * 86_400_000).toISOString());
  });
});

describe("#AUR177276 en el Master", () => {
  it("vivo en Shopify: En curso · Por reprogramar Lima, con el inventario como razón", () => {
    const { legacy, macro } = resolverTodo([salida(AUR177276)]);
    expect(legacy.general).toBe("en_proceso");
    expect(legacy.operational).toBe("pendiente_nuevo_courier");
    expect(macro).toMatchObject({ stage: "en_curso", substage: "por_reprogramar_lima", since: hace(7) });
    expect(macro.reasons).toContain("devolucion_pendiente_inventario");
  });

  it("antes de que vuelva la caja, igual: no hay que esperarla", () => {
    const { macro } = resolverTodo([salida()]);
    expect(macro).toMatchObject({ stage: "en_curso", substage: "por_reprogramar_lima" });
    expect(macro.reasons).not.toContain("devolucion_pendiente_inventario");
  });

  it("Grupo GF lo puede tomar desde la lista, con la chapa de quién no entregó", () => {
    const outputs = [{ ...salida(AUR177276), custody_state: "devuelto", output_number: 1 }];
    expect(outputsBlockingRetry(outputs)).toEqual([]);
    const failed = lastFailedOutput(outputs);
    expect(failed && failedOutputLabel(failed)).toBe("Tanders no entregó · volvió");
  });

  it("anulado en Shopify: Por cerrar hasta conciliar la caja, y luego Finalizado", () => {
    const cancelled = pedido({ cancelled_at: hace(1) });
    const before = resolverTodo([salida(AUR177276)], cancelled);
    expect(before.macro).toMatchObject({ stage: "por_cerrar", substage: "devolucion_pendiente_inventario" });
    const after = resolverTodo([salida(AUR177276)], cancelled, [{ kind: "inventory_reconciled", occurred_at: hace(0), shipment_id: "g1" }]);
    expect(after.macro.stage).toBe("finalizado");
  });

  it("anulado en Shopify con la ventana ya vencida: tampoco se queda en «Recuperación vencida»", () => {
    // La anulación la decidió una persona: no hubo nada que recuperar. Antes la
    // razón no se apagaba nunca, ni con el inventario conciliado.
    const viejo = salida({ assigned_at: hace(90), dispatched_at: hace(80), returned_at: hace(70) });
    const cancelled = pedido({ created_at: hace(91), cancelled_at: hace(70) });
    const { macro } = resolverTodo([viejo], cancelled, [{ kind: "inventory_reconciled", occurred_at: hace(60), shipment_id: "g1" }]);
    expect(macro.reasons).not.toContain("recuperacion_vencida");
    expect(macro.stage).toBe("finalizado");
  });

  it("Tanders `CANCELLED` que nunca salió sigue cerrándose solo", () => {
    const { legacy, macro } = resolverTodo([salida({ dispatched_at: null })]);
    expect(legacy.general).toBe("anulado");
    expect(macro).toMatchObject({ stage: "finalizado", substage: "anulado_cerrado" });
  });
});

describe("«Rechazó el pedido» ya no anula el pedido desde ninguna puerta", () => {
  it("ni el cierre de la ruta de Grupo GF", () => {
    expect(stopEffect({ status: "no_entregado", outcome_reason: "rechazado" })).toBeNull();
    expect(masterEffects([{ order_id: "o1", status: "no_entregado", outcome_reason: "rechazado" }])).toEqual([]);
  });

  it("ni la liquidación de Axel o Urpi", () => {
    expect(lineEffect({ declared_status: "RECHAZADO", match_status: "ok", order_id: "o1" })).toBeNull();
  });

  it("y «Recibir en oficina» lo devuelve a «por asignar» como los demás motivos (0206)", () => {
    const sql = read("db/migrations/0206_gf_return_rejected_reprograms.sql");
    expect(sql).toContain("create or replace function public.gf_return_to_office");
    expect(sql).not.toMatch(/outcome_reason = 'rechazado'/);
    expect(sql).toContain("set custody_state = 'empresa'");
  });
});

describe("el MOM lo dice", () => {
  it("con la regla y el caso", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### En Lima, lo que no se entrega se reprograma (v1.23, 30-09-2026)");
    expect(mom).toContain("#AUR177276");
  });
});

describe("la caja escaneada en el almacén gana al estado atrasado del courier (03-10-2026)", () => {
  // #AUR176862: Tanders seguía diciendo `PICKED` cuatro días después de que la
  // caja se escaneara en Devoluciones. El pedido, vivo en Shopify, quedaba en
  // «Por cerrar · Devolución pendiente de inventario».
  const AUR176862 = {
    delivery_status: "en_ruta",
    reported_status: "PICKED",
    returned_at: hace(1),
    pickup_state: "devuelto",
  } as const;

  it("Tanders o Swayp vivos con la caja ya recibida cuentan como intento fallido", () => {
    expect(guideFailedAfterDispatch(salida(AUR176862))).toBe(true);
    expect(guideFailedAfterDispatch(salida({ ...AUR176862, courier: "fenix", reported_status: null }))).toBe(true);
    // Sin la caja recibida, un PICKED es una guía viva: la lleva Tanders.
    expect(guideFailedAfterDispatch(salida({ ...AUR176862, returned_at: null }))).toBe(false);
  });

  it("Grupo GF y el motorizado propio no: su «Recibir en oficina» los devuelve a «por asignar»", () => {
    for (const courier of ["propio", "grupo_gf", "axel", "urpi"]) {
      expect(guideFailedAfterDispatch(salida({ ...AUR176862, courier, reported_status: null })), courier).toBe(false);
    }
  });

  it("el pedido vivo en Shopify va a «Por reprogramar Lima», anclado en la salida", () => {
    const { macro } = resolverTodo([salida(AUR176862)]);
    expect(macro).toMatchObject({ stage: "en_curso", substage: "por_reprogramar_lima", since: hace(7) });
    expect(macro.reasons).toContain("devolucion_pendiente_inventario");
  });

  it("anulado en Shopify, espera la caja en Por cerrar como siempre", () => {
    const { macro } = resolverTodo([salida(AUR176862)], pedido({ cancelled_at: hace(2), financial_status: "voided" }));
    expect(macro.stage).toBe("por_cerrar");
  });
});
