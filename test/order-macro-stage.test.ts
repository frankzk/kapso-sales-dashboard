import { describe, expect, it } from "vitest";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  ORDER_MACRO_STAGES,
  agencyPaymentReady,
  classifyOperation,
  resolveMacroStage,
  type MacroEventSnapshot,
  type MacroGuideSnapshot,
  type MacroOrderSnapshot,
  type ResolveMacroStageInput,
} from "@/lib/order-macro-stage";

const CREATED = "2026-07-01T10:00:00.000Z";

describe("catálogo navegable del MOM", () => {
  it("expone las seis macroetapas en el orden operativo acordado", () => {
    expect(ORDER_MACRO_STAGES.map((stage) => stage.code)).toEqual([
      "por_confirmar",
      "preparacion",
      "por_despachar",
      "en_curso",
      "por_cerrar",
      "finalizado",
    ]);
  });

  it("cada macroetapa tiene subetapas navegables sin duplicados", () => {
    const all = ORDER_MACRO_STAGES.flatMap(
      (stage) => MACRO_SUBSTAGES_BY_STAGE[stage.code],
    );
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length);
    for (const stage of ORDER_MACRO_STAGES) {
      expect(MACRO_SUBSTAGES_BY_STAGE[stage.code].length).toBeGreaterThan(0);
    }
  });
});

function order(over: Partial<MacroOrderSnapshot> = {}): MacroOrderSnapshot {
  return {
    created_at: CREATED,
    cancelled_at: null,
    financial_status: "pending",
    shipping_mode: "cod",
    region: "Junín",
    province: "Huancayo",
    district: "El Tambo",
    ...over,
  };
}

function guide(over: Partial<MacroGuideSnapshot> = {}): MacroGuideSnapshot {
  return {
    id: "shipment-1",
    courier: "aliclik",
    delivery_status: "pendiente",
    attempts: 0,
    assigned_at: "2026-07-02T10:00:00.000Z",
    dispatched_at: null,
    out_for_delivery_at: null,
    rescheduled_at: null,
    returned_at: null,
    pickup_state: null,
    preparation_state: null,
    custody_state: null,
    ...over,
  };
}

function event(kind: string, occurred_at = "2026-07-02T09:00:00.000Z"): MacroEventSnapshot {
  return { kind, occurred_at };
}

function resolve(over: Partial<ResolveMacroStageInput> = {}) {
  return resolveMacroStage({
    order: order(),
    guides: [],
    events: [],
    legacy: { general: "pendiente", operational: "sin_confirmar", since: CREATED },
    paymentState: null,
    ...over,
  });
}

describe("classifyOperation", () => {
  it("clasifica Lima y Callao como operación Lima", () => {
    expect(classifyOperation(order({ region: "Lima", province: "Lima" }))).toBe("lima");
    expect(classifyOperation(order({ region: "Callao", province: "Callao" }))).toBe("lima");
  });

  // #KP125633: Shopify guardó "Barranca" en el DISTRITO y la clienta eligió
  // "Lima (provincia)" en el desplegable de región. Con `coverage: "lima"` ya
  // materializado, la mesa de ruta ofrecía motorizado propio para un destino a
  // 200 km y no ofrecía Shalom, que era la única vía real.
  //
  // Esto gana sobre `coverage` a propósito: el campo materializado puede
  // conservar una clasificación vieja, y un pedido mal enrutado no puede esperar
  // al siguiente recálculo.
  it("las nueve provincias del departamento de Lima van por agencia, aunque coverage diga lima", () => {
    for (const district of ["Barranca", "Huaura", "Huaral", "Yauyos", "Canta", "Oyón", "Cajatambo", "Huarochirí", "Cañete"]) {
      expect(
        classifyOperation(
          order({ region: "Lima (provincia)", province: "Lima (provincia)", district, coverage: "lima" }),
        ),
      ).toBe("agencia");
    }
  });

  it("un distrito metropolitano de verdad sigue siendo Lima", () => {
    expect(
      classifyOperation(
        order({ region: "Lima (provincia)", province: "Lima (provincia)", district: "Barranco", coverage: "lima" }),
      ),
    ).toBe("lima");
  });

  it("trata una geografía no-Lima sin modalidad histórica como Provincia COD", () => {
    expect(classifyOperation(order({ region: "Cusco", province: "Cusco" }))).toBe("provincia_cod");
  });

  it("la modalidad o una guía de agencia ganan sobre la geografía", () => {
    expect(classifyOperation(order({ shipping_mode: "agency", region: "Lima" }))).toBe("agencia");
    expect(classifyOperation(order({ region: "Lima" }), [guide({ courier: "shalom" })])).toBe("agencia");
  });

  it("la cobertura canónica gana sobre una geografía histórica equivocada", () => {
    expect(
      classifyOperation(
        order({
          coverage: "agencia",
          region: "Lima (provincia)",
          province: "Cañete",
          district: "San Vicente de Cañete",
        }),
      ),
    ).toBe("agencia");
  });

  it("Cañete gana aunque una fila histórica todavía diga cobertura Lima", () => {
    expect(
      classifyOperation(
        order({
          coverage: "lima",
          region: "Lima (provincia)",
          province: "Cañete",
          district: "San Vicente de Cañete",
        }),
      ),
    ).toBe("agencia");
  });
});

describe("resolveMacroStage — Por confirmar y Preparación", () => {
  it("Provincia nueva entra Sin llamar", () => {
    const state = resolve();
    expect(state).toMatchObject({
      stage: "por_confirmar",
      substage: "sin_llamar",
      operation: "provincia_cod",
    });
  });

  it("un backfill anterior al corte queda histórico, no Sin llamar", () => {
    const state = resolve({
      order: order({
        created_at: "2026-05-31T20:00:00.000Z",
        confirmation_activation_date: "2026-06-01",
      }),
    });
    expect(state).toMatchObject({
      stage: "por_confirmar",
      substage: "historico_sin_gestion",
    });
  });

  it("un histórico contactado entra al flujo normal", () => {
    const state = resolve({
      order: order({
        created_at: "2026-05-20T20:00:00.000Z",
        confirmation_activation_date: "2026-06-01",
      }),
      events: [event("confirmation_contact")],
    });
    expect(state.substage).toBe("por_confirmar");
  });

  it("un contacto nunca vuelve a Sin llamar", () => {
    const state = resolve({ events: [event("confirmation_contact")] });
    expect(state.substage).toBe("por_confirmar");
  });

  it("respeta Volver a contactar y Último intento", () => {
    expect(resolve({ events: [event("confirmation_followup")] }).substage).toBe("volver_a_contactar");
    expect(resolve({ events: [event("confirmation_last_attempt")] }).substage).toBe("ultimo_intento");
  });

  it("un intento posterior sin compromiso devuelve el pedido a Por confirmar", () => {
    // El compromiso viejo ya no describe nada: se pactó llamar el martes, se
    // llamó y no contestó. Antes ganaba el orden de las líneas y el pedido se
    // quedaba en «Volver a contactar» con una fecha que ya pasó.
    const state = resolve({
      events: [
        event("confirmation_followup", "2026-07-20T15:00:00.000Z"),
        event("confirmation_contact", "2026-07-22T15:00:00.000Z"),
      ],
    });
    expect(state.substage).toBe("por_confirmar");
  });

  it("el compromiso pactado en el mismo intento gana el empate", () => {
    // Se graban con el MISMO instante: si el empate lo ganara el contacto, un
    // «volver a llamar el viernes» no llegaría nunca a su cola.
    const state = resolve({
      events: [
        event("confirmation_contact", "2026-07-20T15:00:00.000Z"),
        event("confirmation_followup", "2026-07-20T15:00:00.000Z"),
      ],
    });
    expect(state.substage).toBe("volver_a_contactar");
  });

  it("siete días DISTINTOS de gestión llevan a Último intento", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      event("confirmation_contact", `2026-07-${String(10 + i).padStart(2, "0")}T15:00:00.000Z`),
    );
    expect(resolve({ events: seven }).substage).toBe("ultimo_intento");
    expect(resolve({ events: seven.slice(0, 6) }).substage).toBe("por_confirmar");
  });

  it("insistir muchas veces el mismo día no gasta los siete días", () => {
    const sameDay = Array.from({ length: 9 }, (_, i) =>
      event("confirmation_contact", `2026-07-20T1${i % 10}:00:00.000Z`),
    );
    expect(resolve({ events: sameDay }).substage).toBe("por_confirmar");
  });

  it("Lima omite confirmación y entra Por generar rótulo", () => {
    const state = resolve({ order: order({ region: "Lima", province: "Lima" }) });
    expect(state).toMatchObject({
      stage: "preparacion",
      substage: "por_generar_rotulo",
      operation: "lima",
    });
  });

  it("Provincia confirmada entra Por generar rótulo", () => {
    const state = resolve({ events: [event("confirmed")] });
    expect(state).toMatchObject({ stage: "preparacion", substage: "por_generar_rotulo" });
  });

  it("una guía creada implica rótulo y deja el pedido Por armar", () => {
    const state = resolve({
      guides: [guide()],
      legacy: { general: "en_proceso", operational: "asignado_a_courier", since: CREATED },
    });
    expect(state).toMatchObject({ stage: "preparacion", substage: "por_armar" });
  });

  it("Agencia contactada sin pago validado permanece Por confirmar, con el pago como motivo", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      events: [event("confirmation_contact")],
      paymentState: "sin_pago",
    });
    expect(state).toMatchObject({
      stage: "por_confirmar",
      substage: "por_confirmar",
      reasons: ["pago_requerido_pendiente"],
    });
  });

  it("agendar el próximo contacto NO borra el pago pendiente", () => {
    // Era el defecto de tener las dos como subetapas: el pedido saltaba de
    // «Pago requerido pendiente» a «Volver a contactar» y el abono, que no había
    // cambiado en nada, desaparecía de la vista.
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      events: [event("confirmation_contact"), event("confirmation_followup")],
      paymentState: "sin_pago",
    });
    expect(state).toMatchObject({
      stage: "por_confirmar",
      substage: "volver_a_contactar",
      reasons: ["pago_requerido_pendiente"],
    });
  });

  it("el séptimo día también arrastra el motivo del abono", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      events: [event("confirmation_contact"), event("confirmation_last_attempt")],
      paymentState: "sin_pago",
    });
    expect(state).toMatchObject({ substage: "ultimo_intento", reasons: ["pago_requerido_pendiente"] });
  });

  it("un pedido de Agencia que nadie llamó todavía no reclama el abono", () => {
    // Sin un solo contacto no hay a quién pedirle el depósito: marcarlo llenaría
    // la bandeja de motivos que nadie puede resolver aún.
    const state = resolve({ order: order({ shipping_mode: "agency" }), paymentState: "sin_pago" });
    expect(state).toMatchObject({ substage: "sin_llamar", reasons: [] });
  });

  it("Provincia COD sin pago no inventa un motivo de abono", () => {
    const state = resolve({ events: [event("confirmation_contact")], paymentState: "sin_pago" });
    expect(state).toMatchObject({ substage: "por_confirmar", reasons: [] });
  });

  it("el abono solo bloquea a Agencia, y `adelanto_validado` ya alcanza", () => {
    // Lo usan el resolvedor Y la mesa de confirmación. Si divergieran, la mesa
    // diría «pasa a Preparación» sobre un pedido que se queda esperando plata.
    expect(agencyPaymentReady("provincia_cod", "sin_pago")).toBe(true);
    expect(agencyPaymentReady("agencia", "sin_pago")).toBe(false);
    expect(agencyPaymentReady("agencia", "adelanto_validado")).toBe(true);
    expect(agencyPaymentReady("agencia", "pago_completo")).toBe(true);
  });

  it("«Pago requerido pendiente» ya no es una subetapa navegable", () => {
    // Si volviera al catálogo, la interfaz ofrecería otra vez dos casilleros
    // para el mismo pedido y el conteo se partiría entre ambos.
    expect(MACRO_SUBSTAGES_BY_STAGE.por_confirmar).not.toContain("pago_requerido_pendiente");
  });

  it("Agencia con adelanto validado puede pasar a preparación", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      events: [event("confirmed")],
      paymentState: "adelanto_validado",
    });
    expect(state).toMatchObject({ stage: "preparacion", substage: "por_generar_rotulo" });
  });
});

describe("resolveMacroStage — despacho y curso", () => {
  it("paquete escaneado bajo custodia de empresa queda Listo para asignar", () => {
    const state = resolve({ guides: [guide({ preparation_state: "listo_despacho", custody_state: "empresa" })] });
    expect(state).toMatchObject({ stage: "por_despachar", substage: "listo_para_asignar" });
  });

  it("refleja el cotejo incompleto más reciente", () => {
    const state = resolve({
      guides: [guide({ preparation_state: "listo_despacho", custody_state: "empresa" })],
      events: [event("route_assigned"), event("manifest_mismatch", "2026-07-02T11:00:00.000Z")],
    });
    expect(state).toMatchObject({ stage: "por_despachar", substage: "cotejo_incompleto" });
  });

  it("custodia del courier mueve la salida a En curso", () => {
    const state = resolve({
      guides: [guide({
        preparation_state: "listo_despacho",
        custody_state: "courier",
        dispatched_at: "2026-07-03T10:00:00.000Z",
      })],
      legacy: { general: "en_proceso", operational: "despachado", since: CREATED },
    });
    expect(state).toMatchObject({ stage: "en_curso", substage: "en_transito" });
  });

  it("un intento fallido cae en la cola correcta según la operación", () => {
    const province = resolve({
      guides: [guide({ custody_state: "courier", attempts: 1 })],
      legacy: { general: "en_proceso", operational: "pendiente_de_reprogramacion", since: CREATED },
    });
    const lima = resolve({
      order: order({ region: "Lima", province: "Lima" }),
      guides: [guide({ custody_state: "courier", attempts: 1 })],
      legacy: { general: "en_proceso", operational: "pendiente_de_reprogramacion", since: CREATED },
    });
    expect(province.substage).toBe("gestion_reproprovincia");
    expect(lima.substage).toBe("por_reprogramar_lima");
  });

  it("Agencia disponible sin pago completo muestra la diferencia pendiente", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      guides: [guide({
        courier: "shalom",
        custody_state: "courier",
        pickup_state: "disponible_para_recojo",
      })],
      legacy: { general: "en_proceso", operational: "disponible_para_recojo", since: CREATED },
      paymentState: "adelanto_validado",
    });
    expect(state).toMatchObject({ stage: "en_curso", substage: "pendiente_pago_diferencia" });
  });
});

describe("resolveMacroStage — Por cerrar y Finalizado", () => {
  it("una entrega COD permanece pendiente de liquidación", () => {
    const state = resolve({
      guides: [guide({ delivery_status: "entregado", custody_state: "courier" })],
      legacy: { general: "entregado", operational: "entregado", since: "2026-07-05T10:00:00.000Z" },
    });
    expect(state).toMatchObject({ stage: "por_cerrar", substage: "pendiente_liquidacion" });
  });

  it("liquidación cerrada finaliza una entrega COD", () => {
    const state = resolve({
      guides: [guide({ delivery_status: "entregado", custody_state: "courier" })],
      events: [event("liquidation_closed", "2026-07-06T10:00:00.000Z")],
      legacy: { general: "entregado", operational: "entregado", since: "2026-07-05T10:00:00.000Z" },
    });
    expect(state).toMatchObject({ stage: "finalizado", substage: "entregado_cerrado" });
  });

  it("una salida entregada con otra activa queda Por cerrar", () => {
    const state = resolve({
      guides: [
        guide({ id: "s1", delivery_status: "entregado", custody_state: "courier" }),
        guide({ id: "s2", courier: "axel", delivery_status: "en_ruta", custody_state: "courier" }),
      ],
      legacy: { general: "entregado", operational: "entregado", since: CREATED },
    });
    expect(state.stage).toBe("por_cerrar");
    expect(state.reasons).toContain("salida_adicional_activa");
  });

  it("Agencia recogida y pagada completamente puede finalizar", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      guides: [guide({ courier: "shalom", delivery_status: "entregado", pickup_state: "recogido" })],
      legacy: { general: "entregado", operational: "recogido", since: CREATED },
      paymentState: "pago_completo",
    });
    expect(state).toMatchObject({ stage: "finalizado", substage: "recogido_cerrado" });
  });

  it("Agencia recogida sin pago completo genera alerta crítica de cierre", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      guides: [guide({ courier: "shalom", delivery_status: "entregado", pickup_state: "recogido" })],
      legacy: { general: "entregado", operational: "recogido", since: CREATED },
      paymentState: "adelanto_validado",
    });
    expect(state).toMatchObject({ stage: "por_cerrar", substage: "recogido_sin_pago_completo" });
  });

  it("Shopify anulado sin despacho finaliza", () => {
    const state = resolve({
      order: order({ cancelled_at: "2026-07-04T10:00:00.000Z" }),
      legacy: { general: "anulado", operational: "anulado", since: "2026-07-04T10:00:00.000Z" },
    });
    expect(state).toMatchObject({ stage: "finalizado", substage: "anulado_cerrado" });
  });

  it("Shopify anulado con paquete fuera exige devolución física", () => {
    const state = resolve({
      order: order({ cancelled_at: "2026-07-04T10:00:00.000Z" }),
      guides: [guide({ delivery_status: "en_ruta", custody_state: "courier" })],
      legacy: { general: "anulado", operational: "anulado", since: "2026-07-04T10:00:00.000Z" },
    });
    expect(state).toMatchObject({ stage: "por_cerrar", substage: "devolucion_fisica_pendiente" });
  });

  it("una devolución recibida espera inventario y luego finaliza", () => {
    const returnedAt = "2026-07-08T10:00:00.000Z";
    const before = resolve({
      guides: [guide({ delivery_status: "anulado", custody_state: "devuelto", returned_at: returnedAt })],
      legacy: { general: "devuelto", operational: "devuelto_al_origen", since: returnedAt },
    });
    const after = resolve({
      guides: [guide({ delivery_status: "anulado", custody_state: "devuelto", returned_at: returnedAt })],
      events: [{
        ...event("inventory_reconciled", "2026-07-08T11:00:00.000Z"),
        shipment_id: "shipment-1",
      }],
      legacy: { general: "devuelto", operational: "devuelto_al_origen", since: returnedAt },
    });
    expect(before).toMatchObject({ stage: "por_cerrar", substage: "devolucion_pendiente_inventario" });
    expect(after).toMatchObject({ stage: "finalizado", substage: "devuelto_cerrado" });
  });

  it("exige conciliar cada salida devuelta antes de finalizar", () => {
    const returnedAt = "2026-07-08T10:00:00.000Z";
    const guides = [
      guide({ id: "s1", delivery_status: "anulado", custody_state: "devuelto", returned_at: returnedAt }),
      guide({ id: "s2", courier: "axel", delivery_status: "anulado", custody_state: "devuelto", returned_at: returnedAt }),
    ];
    const oneClosed = resolve({
      guides,
      events: [{ ...event("inventory_reconciled", "2026-07-08T11:00:00.000Z"), shipment_id: "s1" }],
      legacy: { general: "devuelto", operational: "devuelto_al_origen", since: returnedAt },
    });
    const bothClosed = resolve({
      guides,
      events: [
        { ...event("inventory_reconciled", "2026-07-08T11:00:00.000Z"), shipment_id: "s1" },
        { ...event("merma_closed", "2026-07-08T12:00:00.000Z"), shipment_id: "s2" },
      ],
      legacy: { general: "devuelto", operational: "devuelto_al_origen", since: returnedAt },
    });
    expect(oneClosed).toMatchObject({ stage: "por_cerrar", substage: "devolucion_pendiente_inventario" });
    expect(bothClosed).toMatchObject({ stage: "finalizado", substage: "devuelto_cerrado" });
  });

  it("mantiene cada indemnización Aliclik abierta por su propia salida", () => {
    const guides = [
      guide({ id: "s1", delivery_status: "anulado", custody_state: "devuelto", returned_at: CREATED }),
      guide({ id: "s2", delivery_status: "anulado", custody_state: "devuelto", returned_at: CREATED }),
    ];
    const state = resolve({
      guides,
      events: [
        { ...event("inventory_reconciled", "2026-07-08T09:00:00.000Z"), shipment_id: "s1" },
        { ...event("inventory_reconciled", "2026-07-08T09:00:00.000Z"), shipment_id: "s2" },
        { ...event("indemnity_requested", "2026-07-08T10:00:00.000Z"), shipment_id: "s1" },
        { ...event("indemnity_requested", "2026-07-08T11:00:00.000Z"), shipment_id: "s2" },
        { ...event("indemnity_resolved", "2026-07-08T12:00:00.000Z"), shipment_id: "s2" },
      ],
      legacy: { general: "devuelto", operational: "devuelto_al_origen", since: CREATED },
    });
    expect(state.stage).toBe("por_cerrar");
    expect(state.reasons).toContain("indemnizacion_pendiente");
  });

  it("un retorno solicitado mantiene visible la devolución física pendiente", () => {
    const state = resolve({
      guides: [guide({ delivery_status: "anulado", custody_state: "retorno" })],
      events: [event("return_requested", "2026-07-08T10:00:00.000Z")],
      legacy: { general: "anulado", operational: "anulado", since: CREATED },
    });
    expect(state.stage).toBe("por_cerrar");
    expect(state.reasons).toContain("devolucion_fisica_pendiente");
  });

  it("una reapertura permanece Por cerrar hasta un nuevo cierre explícito", () => {
    const reopened = resolve({
      guides: [guide({ delivery_status: "entregado", custody_state: "courier" })],
      events: [
        event("liquidation_closed", "2026-07-08T10:00:00.000Z"),
        event("order_finalized", "2026-07-08T11:00:00.000Z"),
        event("order_reopened", "2026-07-08T12:00:00.000Z"),
      ],
      legacy: { general: "entregado", operational: "entregado", since: CREATED },
    });
    const closedAgain = resolve({
      guides: [guide({ delivery_status: "entregado", custody_state: "courier" })],
      events: [
        event("liquidation_closed", "2026-07-08T10:00:00.000Z"),
        event("order_reopened", "2026-07-08T12:00:00.000Z"),
        event("order_finalized", "2026-07-08T13:00:00.000Z"),
      ],
      legacy: { general: "entregado", operational: "entregado", since: CREATED },
    });
    expect(reopened).toMatchObject({ stage: "por_cerrar", substage: "validacion_cierre_pendiente" });
    expect(closedAgain).toMatchObject({ stage: "finalizado", substage: "entregado_cerrado" });
  });
});


describe("el sub-estado de agencia prueba custodia (v1.7)", () => {
  // #AUR174766: guía de Shalom emitida el 29/07, el paquete llegó a la agencia
  // de destino el 01/08 y la clave ya se entregó. El MOM lo tenía en
  // «Por confirmar · Sin llamar» — 5 días diciendo que había que llamar a una
  // clienta cuyo paquete ya la estaba esperando.
  //
  // La guía de Shalom en destino lleva `delivery_status: "pendiente"` A
  // PROPÓSITO: sigue viva hasta que el cliente la recoja, y así lo exige el
  // flujo de la clave. Pero `hasExternalCustody` solo miraba ese campo, y no lo
  // distinguía de una guía que aún no ha salido. Tampoco hay `dispatched_at` ni
  // `custody_state: "courier"`: la guía la crea la API y el rastreo solo escribe
  // estado y sub-estado.
  const enDestino = () =>
    guide({
      courier: "shalom",
      delivery_status: "pendiente",
      pickup_state: "disponible_para_recojo",
      custody_state: "empresa",
      dispatched_at: null,
      out_for_delivery_at: null,
    });

  it("un paquete en la agencia de destino está En curso, no Por confirmar", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      guides: [enDestino()],
      legacy: { general: "en_proceso", operational: "disponible_para_recojo", since: CREATED },
      paymentState: "adelanto_cargado",
    });
    expect(state.stage).toBe("en_curso");
    expect(state.stage).not.toBe("por_confirmar");
  });

  // El adelanto sin validar frena el paso a Preparación, y eso está bien: es la
  // puerta ANTES de despachar. Pero con el paquete ya en destino la puerta ya se
  // cruzó, y seguir pidiendo la llamada es contradecir la realidad física.
  it("el adelanto sin validar ya no lo devuelve a Por confirmar", () => {
    for (const paymentState of ["adelanto_cargado", "sin_pago", null]) {
      const state = resolve({
        order: order({ shipping_mode: "agency" }),
        guides: [enDestino()],
        legacy: { general: "en_proceso", operational: "disponible_para_recojo", since: CREATED },
        paymentState,
      });
      expect(state.stage).toBe("en_curso");
    }
  });

  it("todos los sub-estados posteriores a la salida cuentan como custodia", () => {
    for (const pickup_state of [
      "registrado_en_agencia",
      "en_transito",
      "disponible_para_recojo",
      "cliente_notificado",
      "pendiente_de_recojo",
      "proximo_a_vencer",
      "en_reparto",
    ]) {
      const state = resolve({
        order: order({ shipping_mode: "agency" }),
        guides: [guide({ courier: "shalom", delivery_status: "pendiente", pickup_state })],
        legacy: { general: "en_proceso", operational: pickup_state, since: CREATED },
        paymentState: "adelanto_cargado",
      });
      expect(state.stage).toBe("en_curso");
    }
  });

  // El único que NO prueba custodia: es el estado con el que nace una guía recién
  // emitida, antes de dejar el bulto en la agencia. Un pedido así todavía tiene
  // que pasar por el filtro del adelanto.
  it("«pendiente de envío» NO prueba custodia: la guía existe pero el bulto no salió", () => {
    const state = resolve({
      order: order({ shipping_mode: "agency" }),
      guides: [
        guide({ courier: "shalom", delivery_status: "pendiente", pickup_state: "pendiente_de_envio" }),
      ],
      paymentState: "adelanto_cargado",
    });
    expect(state.stage).not.toBe("en_curso");
  });
});
