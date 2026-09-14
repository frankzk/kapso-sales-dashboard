import { describe, expect, it } from "vitest";
import {
  canAdvanceGeneral,
  currentGuide,
  daysInStatus,
  defaultOperationalFor,
  operationalStatusesFor,
  resolveOrderState,
  type GuideSnapshot,
  type OrderEventSnapshot,
  type OrderSnapshot,
} from "@/lib/order-status";

const NOW = "2026-07-20T12:00:00.000Z";

function order(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    created_at: "2026-07-01T10:00:00.000Z",
    cancelled_at: null,
    financial_status: "pending",
    shipping_mode: "cod",
    ...overrides,
  };
}

function guide(id: string, overrides: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id,
    courier: "aliclik",
    guide_code: `AUR5X${id}`,
    delivery_status: "pendiente",
    attempts: 0,
    assigned_at: "2026-07-02T10:00:00.000Z",
    dispatched_at: null,
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    created_at: "2026-07-02T10:00:00.000Z",
    updated_at: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

function resolve(
  guides: GuideSnapshot[],
  o: OrderSnapshot = order(),
  events: OrderEventSnapshot[] = [],
  override = null,
) {
  return resolveOrderState({ order: o, guides, events, override, now: NOW });
}

describe("resolveOrderState — pedido sin gestión", () => {
  it("un pedido recién creado, sin confirmar, queda pendiente", () => {
    const s = resolve([]);
    expect(s.general).toBe("pendiente");
    expect(s.operational).toBe("sin_confirmar");
    expect(s.since).toBe("2026-07-01T10:00:00.000Z");
    expect(s.courierCount).toBe(0);
  });

  it("confirmado y sin courier queda pendiente de asignación", () => {
    const s = resolve([], order(), [
      { kind: "confirmed", occurred_at: "2026-07-02T09:00:00.000Z", courier: null, new_status: null, new_operational: null },
    ]);
    expect(s.general).toBe("pendiente");
    expect(s.operational).toBe("sin_asignar_courier");
  });

  it("registrar la guía confirma, aunque la fila de guía no exista todavía", () => {
    // La divergencia que motivó unificar la definición: este archivo miraba
    // solo `confirmed` y el pago de Shopify, así que dejaba en «sin confirmar»
    // pedidos que el MOM ya había mandado a Preparación.
    const s = resolve([], order(), [
      { kind: "guide_registered", occurred_at: "2026-07-02T09:00:00.000Z", courier: null, new_status: null, new_operational: null },
    ]);
    expect(s.operational).toBe("sin_asignar_courier");
  });

  it("Lima sin señal sigue sin confirmar: la exención es del MOM, no del estado legado", () => {
    // `hasConfirmationSignal` no sabe de Lima a propósito. Si lo supiera, estos
    // pedidos —que nadie llamó— se darían por confirmados aquí.
    const s = resolve([], order({ shipping_mode: "cod" }), []);
    expect(s.operational).toBe("sin_confirmar");
  });

  it("un pedido de agencia confirmado queda pendiente de envío", () => {
    const s = resolve([], order({ shipping_mode: "agency", financial_status: "paid" }));
    expect(s.operational).toBe("pendiente_de_envio");
  });

  it("con guía pero sin despacho, el pedido nunca salió a reparto", () => {
    // El estado general ya es "en proceso" (hay gestión), pero el matiz importa
    // en el sub-estado cuando la guía se anula sin haber salido.
    const s = resolve([guide("1", { delivery_status: "anulado", closed_at: "2026-07-03T10:00:00.000Z" })]);
    expect(s.general).toBe("anulado");
  });
});

describe("resolveOrderState — en proceso", () => {
  it("guía asignada sin despacho → asignado a courier", () => {
    const s = resolve([guide("1")]);
    expect(s.general).toBe("en_proceso");
    expect(s.operational).toBe("asignado_a_courier");
    expect(s.currentCourier).toBe("aliclik");
    expect(s.guideCode).toBe("AUR5X1");
  });

  it("guía en ruta con salida a reparto → en reparto", () => {
    const s = resolve([
      guide("1", { delivery_status: "en_ruta", out_for_delivery_at: "2026-07-05T13:00:00.000Z" }),
    ]);
    expect(s.operational).toBe("en_reparto");
  });

  it("con intentos previos queda pendiente de reprogramación", () => {
    const s = resolve([guide("1", { attempts: 2 })]);
    expect(s.operational).toBe("pendiente_de_reprogramacion");
    expect(s.attemptCount).toBe(2);
  });

  it("suma los intentos de todas las guías", () => {
    const s = resolve([
      guide("1", { attempts: 2, delivery_status: "transferido" }),
      guide("2", { courier: "fenix", attempts: 1 }),
    ]);
    expect(s.attemptCount).toBe(3);
    expect(s.courierCount).toBe(2);
  });
});

describe("resolveOrderState — entregado prevalece (§3.3, §4)", () => {
  it("un solo reporte de entrega cierra el pedido", () => {
    const s = resolve([guide("1", { delivery_status: "entregado", closed_at: "2026-07-06T15:00:00.000Z" })]);
    expect(s.general).toBe("entregado");
    expect(s.deliveredAt).toBe("2026-07-06T15:00:00.000Z");
    expect(s.deliveredCourier).toBe("aliclik");
  });

  it("si un courier reporta no entregado y otro entregado, gana entregado", () => {
    const s = resolve([
      guide("1", { courier: "aliclik", delivery_status: "anulado", closed_at: "2026-07-05T10:00:00.000Z" }),
      guide("2", { courier: "fenix", delivery_status: "entregado", closed_at: "2026-07-07T10:00:00.000Z" }),
    ]);
    expect(s.general).toBe("entregado");
    // La entrega se atribuye a quien realmente entregó, no a la guía madre.
    expect(s.deliveredCourier).toBe("fenix");
  });

  it("la entrega se atribuye al PRIMER courier que la reportó", () => {
    const s = resolve([
      guide("2", { courier: "fenix", delivery_status: "entregado", closed_at: "2026-07-08T10:00:00.000Z" }),
      guide("1", { courier: "aliclik", delivery_status: "entregado", closed_at: "2026-07-06T10:00:00.000Z" }),
    ]);
    expect(s.deliveredCourier).toBe("aliclik");
    expect(s.deliveredAt).toBe("2026-07-06T10:00:00.000Z");
  });

  it("una anulación posterior en Shopify NO retrocede un pedido entregado", () => {
    const s = resolve(
      [guide("1", { delivery_status: "entregado", closed_at: "2026-07-06T15:00:00.000Z" })],
      order({ cancelled_at: "2026-07-09T10:00:00.000Z" }),
    );
    expect(s.general).toBe("entregado");
  });

  it("un retorno reportado después de la entrega tampoco la retrocede", () => {
    const s = resolve([
      guide("1", {
        delivery_status: "entregado",
        dispatched_at: "2026-07-04T10:00:00.000Z",
        closed_at: "2026-07-06T15:00:00.000Z",
      }),
      guide("2", {
        courier: "shalom",
        delivery_status: "pendiente",
        dispatched_at: "2026-07-04T10:00:00.000Z",
        returned_at: "2026-07-10T10:00:00.000Z",
      }),
    ]);
    expect(s.general).toBe("entregado");
  });

  it("una entrega por agencia queda como recogida", () => {
    const s = resolve([
      guide("1", { courier: "shalom", delivery_status: "entregado", closed_at: "2026-07-06T15:00:00.000Z" }),
    ]);
    expect(s.general).toBe("entregado");
    expect(s.operational).toBe("recogido");
  });
});

describe("resolveOrderState — devuelto exige evidencia (§3.5)", () => {
  it("con despacho, guía y retorno confirmado el pedido queda devuelto", () => {
    const s = resolve([
      guide("1", {
        courier: "shalom",
        dispatched_at: "2026-07-03T10:00:00.000Z",
        returned_at: "2026-07-12T10:00:00.000Z",
      }),
    ]);
    expect(s.general).toBe("devuelto");
    expect(s.operational).toBe("devuelto_al_origen");
    expect(s.returnedAt).toBe("2026-07-12T10:00:00.000Z");
  });

  it("sin despacho previo NO se marca devuelto: queda en proceso de retorno", () => {
    const s = resolve([guide("1", { returned_at: "2026-07-12T10:00:00.000Z", dispatched_at: null })]);
    expect(s.general).toBe("en_proceso");
    expect(s.operational).toBe("en_proceso_de_retorno");
  });

  it("sin guía tampoco se marca devuelto", () => {
    const s = resolve([
      guide("1", {
        guide_code: null,
        dispatched_at: "2026-07-03T10:00:00.000Z",
        returned_at: "2026-07-12T10:00:00.000Z",
      }),
    ]);
    expect(s.general).toBe("en_proceso");
    expect(s.operational).toBe("en_proceso_de_retorno");
  });
});

describe("resolveOrderState — anulado (§3.4)", () => {
  it("la cancelación en Shopify anula el pedido", () => {
    const s = resolve([guide("1")], order({ cancelled_at: "2026-07-08T10:00:00.000Z" }));
    expect(s.general).toBe("anulado");
    expect(s.source).toBe("shopify");
    expect(s.since).toBe("2026-07-08T10:00:00.000Z");
  });

  it("todas las guías anuladas anulan el pedido aunque Shopify aún no lo refleje", () => {
    const s = resolve([
      guide("1", { delivery_status: "anulado", closed_at: "2026-07-05T10:00:00.000Z" }),
      guide("2", { courier: "fenix", delivery_status: "anulado", closed_at: "2026-07-06T10:00:00.000Z" }),
    ]);
    expect(s.general).toBe("anulado");
    expect(s.since).toBe("2026-07-06T10:00:00.000Z");
  });

  it("una guía activa junto a otra anulada mantiene el pedido en proceso", () => {
    const s = resolve([
      guide("1", { delivery_status: "anulado", closed_at: "2026-07-05T10:00:00.000Z" }),
      guide("2", { courier: "fenix", delivery_status: "en_ruta" }),
    ]);
    expect(s.general).toBe("en_proceso");
  });
});

/**
 * Corregir el courier de un pedido no es darlo por perdido (§4 del MOM).
 *
 * Pasó con #KP127639: la única salida se creó «por definir», hubo que anularla
 * para poder emitir la guía de Tanders, y al anularla el pedido quedó ANULADO —
 * lo que además bloqueaba la guía nueva, que era el motivo de la corrección.
 *
 * LA CORRECCIÓN SE PRUEBA, NO SE DEDUCE. La primera versión la infería de la
 * FORMA de la salida (ruta manual + nunca despachada + nunca transferida) y en
 * producción eso capturaba 368 pedidos, de los que solo 2 se habían anulado por
 * el botón: la mesa de cierre exige que no queden salidas activas, así que
 * finalizar un pedido deja exactamente esa misma huella. Habría reabierto 336
 * expedientes cerrados. Por eso la condición es el evento que escribe la acción.
 */
const anulada = (id: string, over: Partial<GuideSnapshot> = {}): GuideSnapshot =>
  guide(id, {
    courier: "por_definir",
    delivery_status: "anulado",
    custody_transferred_at: null,
    dispatched_at: null,
    closed_at: "2026-07-05T10:00:00.000Z",
    ...over,
  });

/** El evento que deja el botón «Anular salida», nombrando su salida. */
const eventoCorreccion = (shipmentId: string): OrderEventSnapshot => ({
  kind: "route_output_cancelled",
  shipment_id: shipmentId,
  occurred_at: "2026-07-05T10:00:00.000Z",
  courier: null,
  new_status: null,
  new_operational: null,
});

describe("resolveOrderState — anular una salida es corregir, no rendirse", () => {
  it("con el evento del botón, la salida anulada NO anula el pedido", () => {
    // El caso exacto de #KP127639.
    const s = resolve([anulada("1")], order(), [eventoCorreccion("1")]);
    expect(s.general).toBe("pendiente");
  });

  it("y el pedido queda listo para recibir la guía nueva", () => {
    // Lo que de verdad importa: `pendiente` es lo que deja pasar el guardián de
    // Tanders/Aliclik/Shalom, que rechaza entregado, devuelto y anulado.
    const s = resolve([anulada("1")], order(), [eventoCorreccion("1")]);
    expect(["entregado", "devuelto", "anulado"]).not.toContain(s.general);
  });

  it("SIN el evento, la misma salida sigue anulando el pedido", () => {
    // La guarda que evitó el desastre: 366 pedidos en produccion tienen esta
    // forma sin haber pasado por el boton, y 336 ya estaban finalizados.
    const s = resolve([anulada("1")]);
    expect(s.general).toBe("anulado");
  });

  it("el evento de OTRA salida no vale para esta", () => {
    // Un pedido con dos salidas donde solo una se corrigió: la otra decide.
    const s = resolve([anulada("1"), anulada("2")], order(), [eventoCorreccion("1")]);
    expect(s.general).toBe("anulado");
  });

  it("una guía de courier anulada SÍ sigue anulando: ahí la operación se rindió", () => {
    const s = resolve([guide("1", { delivery_status: "anulado", closed_at: "2026-07-05T10:00:00.000Z" })]);
    expect(s.general).toBe("anulado");
  });

  it("una salida que YA salió con el motorizado anula aunque tenga el evento", () => {
    // Si la caja se fue, anularla no es corregir un registro: hay un hecho
    // físico detrás, y tratarlo como error escondería un paquete en la calle.
    const ev = [eventoCorreccion("1")];
    expect(resolve([anulada("1", { custody_transferred_at: "2026-07-04T09:00:00.000Z" })], order(), ev).general).toBe("anulado");
    expect(resolve([anulada("1", { dispatched_at: "2026-07-04T09:00:00.000Z" })], order(), ev).general).toBe("anulado");
  });

  it("la corrección no arrastra a las demás: una guía viva manda", () => {
    const s = resolve(
      [anulada("1"), guide("2", { courier: "tanders", delivery_status: "en_ruta" })],
      order(),
      [eventoCorreccion("1")],
    );
    expect(s.general).toBe("en_proceso");
  });

  it("una guía de courier anulada junto a una corrección sigue anulando", () => {
    // La corrección sale del reparto; lo que queda decide. Y la fecha sale de la
    // guía REAL, no de la corrección.
    const s = resolve(
      [anulada("1"), guide("2", { courier: "aliclik", delivery_status: "anulado", closed_at: "2026-07-06T10:00:00.000Z" })],
      order(),
      [eventoCorreccion("1")],
    );
    expect(s.general).toBe("anulado");
    expect(s.since).toBe("2026-07-06T10:00:00.000Z");
  });
});

describe("resolveOrderState — flujo de agencia (§10)", () => {
  it("disponible para recojo se refleja tal cual", () => {
    const s = resolve([
      guide("1", {
        courier: "shalom",
        pickup_state: "disponible_para_recojo",
        dispatched_at: "2026-07-10T10:00:00.000Z",
        agency_expires_at: "2026-07-30T10:00:00.000Z",
      }),
    ]);
    expect(s.general).toBe("en_proceso");
    expect(s.operational).toBe("disponible_para_recojo");
  });

  it("pasada la fecha de vencimiento pasa a próximo a vencer", () => {
    const s = resolve([
      guide("1", {
        courier: "shalom",
        pickup_state: "disponible_para_recojo",
        dispatched_at: "2026-07-10T10:00:00.000Z",
        agency_expires_at: "2026-07-19T10:00:00.000Z",
      }),
    ]);
    expect(s.operational).toBe("proximo_a_vencer");
  });
});

describe("resolveOrderState — override manual (§4, §11)", () => {
  it("el override gana sobre cualquier reporte", () => {
    const s = resolveOrderState({
      order: order(),
      guides: [guide("1", { delivery_status: "entregado", closed_at: "2026-07-06T15:00:00.000Z" })],
      events: [],
      override: {
        general_status: "devuelto",
        operational_status: "devuelto_al_origen",
        occurred_at: "2026-07-15T10:00:00.000Z",
      },
      now: NOW,
    });
    expect(s.general).toBe("devuelto");
    expect(s.source).toBe("manual");
    expect(s.since).toBe("2026-07-15T10:00:00.000Z");
    // El rollup se sigue calculando: la trazabilidad no se pierde al forzar.
    expect(s.deliveredCourier).toBe("aliclik");
  });

  it("un override sin estado operativo usa el por defecto del general", () => {
    const s = resolveOrderState({
      order: order(),
      guides: [],
      events: [],
      override: { general_status: "anulado", operational_status: null, occurred_at: NOW },
      now: NOW,
    });
    expect(s.operational).toBe("anulado");
  });
});

describe("resolveOrderState — anular en Shopify DESPUÉS del cambio manual", () => {
  // #KP126722. El 12/08 se marcó «Pendiente · no responde»; después se anuló el
  // pedido en Shopify —productos eliminados, total 0— y el Master lo siguió
  // enseñando como Pendiente · Provincia COD: dentro de la cola operativa,
  // llamable y despachable, por S/ 99 que ya no existían.
  //
  // El candado se escribió para que un courier o un cron no pisen el criterio de
  // una persona. Anular en Shopify TAMBIÉN lo hace una persona, así que entre dos
  // decisiones humanas manda la más reciente, no la que llegó primero.

  const ANTES = "2026-07-12T15:59:00.000Z";
  const DESPUES = "2026-07-15T09:00:00.000Z";
  const pendiente = {
    general_status: "pendiente" as const,
    operational_status: null,
    occurred_at: ANTES,
  };

  it("la anulación posterior gana al cambio manual", () => {
    const s = resolveOrderState({
      order: order({ cancelled_at: DESPUES }),
      guides: [],
      events: [],
      override: pendiente,
      now: NOW,
    });
    expect(s.general).toBe("anulado");
    expect(s.source).toBe("shopify");
    expect(s.since).toBe(DESPUES);
  });

  it("y el candado se suelta: ya no gobierna nadie a mano", () => {
    // Dejarlo puesto pondría la etiqueta de «cambio manual» sobre un estado que
    // decidió Shopify, y mandaría a buscar un override que no manda nada.
    const s = resolveOrderState({
      order: order({ cancelled_at: DESPUES }),
      guides: [],
      events: [],
      override: pendiente,
      now: NOW,
    });
    expect(s.overrideApplied).toBe(false);
  });

  it("un cambio manual POSTERIOR a la anulación sigue mandando", () => {
    // Es el caso legítimo: lo anularon en Shopify por error y alguien lo
    // reactiva a mano. Invertir la prioridad sin mirar fechas lo rompería.
    const s = resolveOrderState({
      order: order({ cancelled_at: ANTES }),
      guides: [],
      events: [],
      override: { general_status: "en_proceso", operational_status: null, occurred_at: DESPUES },
      now: NOW,
    });
    expect(s.general).toBe("en_proceso");
    expect(s.source).toBe("manual");
    expect(s.overrideApplied).toBe(true);
  });

  it("sin anulación, el cambio manual manda como siempre", () => {
    const s = resolveOrderState({
      order: order(),
      guides: [],
      events: [],
      override: pendiente,
      now: NOW,
    });
    expect(s.general).toBe("pendiente");
    expect(s.overrideApplied).toBe(true);
  });

  it("la anulación no gana un privilegio nuevo: entregado le sigue ganando", () => {
    // Al ceder el override, el pedido baja por la cadena NORMAL. «Entregado es
    // pegajoso» va por delante de la anulación para cualquier otro pedido, y
    // tiene que seguir yendo también acá: el paquete se entregó de verdad, y
    // anular después es un asiento contable, no un des-entregar.
    const s = resolveOrderState({
      order: order({ cancelled_at: DESPUES }),
      guides: [guide("1", { delivery_status: "entregado", closed_at: "2026-07-06T15:00:00.000Z" })],
      events: [],
      override: pendiente,
      now: NOW,
    });
    expect(s.general).toBe("entregado");
    expect(s.overrideApplied).toBe(false);
  });

  it("empate exacto: manda el cambio manual", () => {
    // Solo cede ante una anulación ESTRICTAMENTE posterior. Con el mismo sello
    // de tiempo no hay forma de saber cuál fue después, y la regla vigente
    // —gana el override— es la que no sorprende a nadie.
    const s = resolveOrderState({
      order: order({ cancelled_at: ANTES }),
      guides: [],
      events: [],
      override: pendiente,
      now: NOW,
    });
    expect(s.general).toBe("pendiente");
    expect(s.overrideApplied).toBe(true);
  });
});

describe("helpers", () => {
  it("currentGuide prefiere una guía activa sobre una congelada", () => {
    const frozen = guide("1", { delivery_status: "transferido", updated_at: "2026-07-09T10:00:00.000Z" });
    const active = guide("2", { courier: "fenix", delivery_status: "en_ruta", updated_at: "2026-07-08T10:00:00.000Z" });
    expect(currentGuide([frozen, active])?.id).toBe("2");
  });

  it("currentGuide devuelve la más reciente cuando no queda ninguna activa", () => {
    const a = guide("1", { delivery_status: "anulado", closed_at: "2026-07-05T10:00:00.000Z" });
    const b = guide("2", { delivery_status: "anulado", closed_at: "2026-07-07T10:00:00.000Z" });
    expect(currentGuide([a, b])?.id).toBe("2");
  });

  it("canAdvanceGeneral no permite retroceder", () => {
    expect(canAdvanceGeneral("pendiente", "en_proceso")).toBe(true);
    expect(canAdvanceGeneral("en_proceso", "entregado")).toBe(true);
    expect(canAdvanceGeneral("entregado", "en_proceso")).toBe(false);
    expect(canAdvanceGeneral("entregado", "entregado")).toBe(true);
    expect(canAdvanceGeneral(null, "pendiente")).toBe(true);
  });

  it("daysInStatus cuenta días completos", () => {
    expect(daysInStatus("2026-07-18T12:00:00.000Z", NOW)).toBe(2);
    expect(daysInStatus(null, NOW)).toBeNull();
  });

  it("operationalStatusesFor solo devuelve los del estado general pedido", () => {
    const codes = operationalStatusesFor("entregado").map((s) => s.code);
    expect(codes).toEqual(["entregado", "recogido"]);
  });

  it("defaultOperationalFor cubre los cinco estados generales", () => {
    expect(defaultOperationalFor("pendiente")).toBe("sin_confirmar");
    expect(defaultOperationalFor("en_proceso")).toBe("en_seguimiento");
    expect(defaultOperationalFor("entregado")).toBe("entregado");
    expect(defaultOperationalFor("anulado")).toBe("anulado");
    expect(defaultOperationalFor("devuelto")).toBe("devuelto_al_origen");
  });
});

describe("resolveOrderState — registrar la guía DESPUÉS del cambio manual", () => {
  // Los ocho pedidos de Agencia que nos dieron la lata. Se marcaron a mano
  // «disponible para recojo» y días después se les registró la guía Shalom. El
  // candado congelaba el estado legado en `en_proceso`, y como
  // `recogido_sin_pago_completo` exige `legacy.general === "entregado"`,
  // figuraban como «En curso · recibido por courier» estando recogidos.
  //
  // Medido: 11 pedidos, S/2.054, de los que S/1.062 estaban recogidos y SIN
  // COBRAR, escondidos detrás del candado desde el 4 de agosto.
  //
  // Es el mismo argumento que la anulación: registrar una guía lo hace una
  // PERSONA. Medido sobre 30 días, los 2.589 `guide_registered` y los 1.083
  // `guide_created` llevan actor; los 15.969 `courier_status` —el camino
  // automático, del que protege el candado— no lo llevan ni uno.

  const ANTES = "2026-08-20T12:21:00.000Z";
  const DESPUES = "2026-09-10T16:19:00.000Z";
  const disponible = {
    general_status: "en_proceso" as const,
    operational_status: "disponible_para_recojo",
    occurred_at: ANTES,
  };
  const registro = {
    kind: "guide_registered",
    occurred_at: DESPUES,
    courier: "shalom",
    new_status: null,
    new_operational: null,
  };

  it("la guía registrada después gana al cambio manual anterior", () => {
    const s = resolveOrderState({
      order: order(),
      guides: [
        guide("1", {
          courier: "shalom",
          delivery_status: "entregado",
          closed_at: DESPUES,
        }),
      ],
      events: [registro],
      override: disponible,
      now: NOW,
    });
    expect(s.general).toBe("entregado");
    // Agencia: entregado se llama «recogido», que es lo que destapa la alerta.
    expect(s.operational).toBe("recogido");
    expect(s.overrideApplied).toBe(false);
  });

  it("un cambio manual POSTERIOR al registro sigue mandando", () => {
    // El caso legítimo: se registró la guía y después una persona decidió otra
    // cosa. Invertir la prioridad sin mirar fechas lo rompería.
    const s = resolveOrderState({
      order: order(),
      guides: [guide("1", { courier: "shalom", delivery_status: "entregado", closed_at: ANTES })],
      events: [{ ...registro, occurred_at: ANTES }],
      override: { ...disponible, occurred_at: DESPUES },
      now: NOW,
    });
    expect(s.source).toBe("manual");
    expect(s.overrideApplied).toBe(true);
  });

  // LA LÍNEA QUE SEPARA las dos cosas: el candado existe justo para que el
  // reporte de un courier no pise a una persona. Si `courier_status` valiera,
  // el candado no serviría para nada.
  it("un reporte del courier NO suelta el candado", () => {
    const s = resolveOrderState({
      order: order(),
      guides: [guide("1", { courier: "shalom", delivery_status: "entregado", closed_at: DESPUES })],
      events: [
        { kind: "courier_status", occurred_at: DESPUES, courier: "shalom", new_status: null, new_operational: null },
      ],
      override: disponible,
      now: NOW,
    });
    expect(s.source).toBe("manual");
    expect(s.overrideApplied).toBe(true);
  });

  it("sin registro posterior, el cambio manual manda como siempre", () => {
    const s = resolveOrderState({
      order: order(),
      guides: [],
      events: [],
      override: disponible,
      now: NOW,
    });
    expect(s.general).toBe("en_proceso");
    expect(s.overrideApplied).toBe(true);
  });
});
