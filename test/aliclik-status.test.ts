import { describe, it, expect } from "vitest";
import {
  aliclikStatusLabel,
  aliclikTerminoSinEntregar,
  mapAliclikStatus,
  reconcileAliclikCustodyState,
  reconcileAliclikPreparationState,
} from "@/lib/aliclik-status";
import { reconcileDeliveryStatus } from "@/lib/shipments";

describe("mapAliclikStatus — entrega", () => {
  it("DELIVERED cierra la guía como entregada", () => {
    const m = mapAliclikStatus({ status: "DELIVERED", dispatchStatus: "PICKED", callStatus: "CONFIRMED" });
    expect(m.deliveryStatus).toBe("entregado");
    expect(m.operational).toBe("entregado");
    expect(m.terminal).toBe(true);
  });

  it("en agencia, DELIVERED significa que la clienta lo recogió", () => {
    const m = mapAliclikStatus({ status: "DELIVERED", isAgency: true });
    expect(m.operational).toBe("recogido");
  });

  it("la entrega gana sobre el despacho", () => {
    // El paquete puede seguir marcado IN_TRANSIT y estar ya entregado.
    const m = mapAliclikStatus({ status: "DELIVERED", dispatchStatus: "IN_TRANSIT" });
    expect(m.deliveryStatus).toBe("entregado");
  });
});

describe("mapAliclikStatus — devolución y anulación", () => {
  it("RETURNED marca devolución y sella returned_at", () => {
    const m = mapAliclikStatus({ dispatchStatus: "RETURNED", status: "PENDING_DELIVERY" });
    expect(m.deliveryStatus).toBe("anulado");
    expect(m.operational).toBe("devuelto_al_origen");
    expect(m.returned).toBe(true);
    expect(m.terminal).toBe(true);
  });

  // ── DEJADO EN ALMACÉN: la misma etiqueta para dos momentos opuestos ───────
  // Aliclik la usa tanto para el paquete que aún no ha salido como para el que
  // ya volvió. Se leía siempre como lo primero (`nunca_salio_a_reparto`), así
  // que una guía despachada, intentada y devuelta se quedaba en `pendiente` y
  // nunca sellaba `returned_at` — y la cola de recuperación (MOM §11.1) se
  // quedaba vacía con las cajas físicamente en el almacén.

  it.each(["CANCEL", "ANNULLED", "REFUSED", "NOT_RESPOND", "RESCHEDULED"])(
    "LEFT_IN_WAREHOUSE con intento fallido (%s) ES devolución",
    (status) => {
      const m = mapAliclikStatus({ dispatchStatus: "LEFT_IN_WAREHOUSE", status });
      expect(m.returned).toBe(true);
      expect(m.deliveryStatus).toBe("anulado");
      expect(m.operational).toBe("devuelto_al_origen");
      // La custodia vuelve a ser nuestra: el paquete está en el almacén.
      expect(m.custodyState).toBe("devuelto");
    },
  );

  it("LEFT_IN_WAREHOUSE sin intento NO es devolución: nunca salió", () => {
    // Es el sentido original de la etiqueta, y el que hay que preservar: pedirle
    // un adelanto de S/30 a una clienta cuyo paquete jamás salió sería el peor
    // desenlace posible de esta regla.
    const m = mapAliclikStatus({ dispatchStatus: "LEFT_IN_WAREHOUSE", status: "PENDING_DELIVERY" });
    expect(m.returned).toBe(false);
    expect(m.deliveryStatus).toBe("pendiente");
    expect(m.operational).toBe("nunca_salio_a_reparto");
  });

  it("LEFT_IN_WAREHOUSE sin status tampoco se asume devuelto", () => {
    expect(mapAliclikStatus({ dispatchStatus: "LEFT_IN_WAREHOUSE" }).returned).toBe(false);
  });

  it("TO_RETURN sigue sin ser devolución: el paquete aún viaja de vuelta", () => {
    // Mientras se mueve, la guía sigue viva y el equipo puede interceptarla.
    const m = mapAliclikStatus({ dispatchStatus: "TO_RETURN", status: "CANCEL" });
    expect(m.returned).toBe(false);
  });

  it("CANCEL y ANNULLED anulan", () => {
    for (const status of ["CANCEL", "ANNULLED"]) {
      expect(mapAliclikStatus({ status }).deliveryStatus).toBe("anulado");
    }
  });

  it.each(["ANNULLED", "FAKE", "DUPLICATE", "OUT_OF_STOCK", "NO_COVERAGE", "TESTING"])(
    "callStatus=%s cierra el pedido aunque el despacho diga TO_PREPARE",
    (callStatus) => {
      const m = mapAliclikStatus({ callStatus, dispatchStatus: "TO_PREPARE" });
      expect(m.deliveryStatus).toBe("anulado");
      expect(m.terminal).toBe(true);
    },
  );
});

describe("mapAliclikStatus — en curso", () => {
  it("RESCHEDULED es una reprogramación, no un cierre", () => {
    const m = mapAliclikStatus({ status: "RESCHEDULED" });
    expect(m.deliveryStatus).toBe("en_ruta");
    expect(m.operational).toBe("reprogramado");
    expect(m.terminal).toBe(false);
  });

  it("REFUSED y NOT_RESPOND son intentos de entrega", () => {
    for (const status of ["REFUSED", "NOT_RESPOND"]) {
      const m = mapAliclikStatus({ status });
      expect(m.deliveryStatus).toBe("en_ruta");
      expect(m.operational).toBe("intento_de_entrega");
    }
  });

  it.each([
    ["TO_PREPARE", "pendiente", "confirmado_sin_preparar"],
    ["PREPARED", "pendiente", "preparado_sin_despachar"],
    ["LEFT_IN_WAREHOUSE", "pendiente", "nunca_salio_a_reparto"],
    ["PICKED", "en_ruta", "despachado"],
    ["IN_TRANSIT", "en_ruta", "en_ruta"],
    ["REMAINING_IN_TRANSIT", "en_ruta", "en_ruta"],
    ["STORE_CENTRAL", "en_ruta", "en_traslado"],
    ["TO_RETURN", "en_ruta", "en_proceso_de_retorno"],
  ])("dispatchStatus=%s → %s / %s", (dispatch, delivery, operational) => {
    const m = mapAliclikStatus({ status: "PENDING_DELIVERY", dispatchStatus: dispatch });
    expect(m.deliveryStatus).toBe(delivery);
    expect(m.operational).toBe(operational);
  });

  it("IN_AGENCY habilita el recojo cuando el pedido es por agencia", () => {
    const agency = mapAliclikStatus({ dispatchStatus: "IN_AGENCY", isAgency: true });
    expect(agency.pickupState).toBe("disponible_para_recojo");
    // Sin modalidad agencia no se inventa un sub-estado de recojo.
    expect(mapAliclikStatus({ dispatchStatus: "IN_AGENCY" }).pickupState).toBeNull();
  });

  it("PENDING_DELIVERY sin despacho reconocible no inventa sub-estado", () => {
    const m = mapAliclikStatus({ status: "PENDING_DELIVERY" });
    expect(m.deliveryStatus).toBe("pendiente");
    expect(m.operational).toBeNull();
  });

  it.each([
    ["TO_PREPARE", "rotulo_generado", "empresa"],
    ["PREPARED", "listo_despacho", "empresa"],
    ["PICKED", "listo_despacho", "courier"],
  ])("dispatchStatus=%s acredita preparación %s y custodia %s en el MOM", (dispatch, preparation, custody) => {
    const m = mapAliclikStatus({ status: "PENDING_DELIVERY", dispatchStatus: dispatch });
    expect(m.preparationState).toBe(preparation);
    expect(m.custodyState).toBe(custody);
  });

  it("IMPORTED no hace avanzar la guía", () => {
    const m = mapAliclikStatus({ callStatus: "IMPORTED" });
    expect(m.deliveryStatus).toBe("pendiente");
    expect(m.operational).toBe("sin_confirmar");
  });
});

describe("reconciliación MOM de Aliclik", () => {
  it("un PREPARED hace avanzar el rótulo a listo para despacho", () => {
    expect(reconcileAliclikPreparationState("rotulo_generado", "listo_despacho")).toBe(
      "listo_despacho",
    );
  });

  it("TO_PREPARE no hace retroceder un paquete ya escaneado", () => {
    expect(reconcileAliclikPreparationState("listo_despacho", "rotulo_generado")).toBe(
      "listo_despacho",
    );
  });

  it("PREPARED no devuelve a la empresa un paquete que ya recogió el courier", () => {
    expect(reconcileAliclikCustodyState("courier", "empresa")).toBe("courier");
  });

  it("PICKED transfiere la custodia al courier", () => {
    expect(reconcileAliclikCustodyState("empresa", "courier")).toBe("courier");
  });
});

describe("mapAliclikStatus — valores desconocidos", () => {
  it("no cambia el estado y reporta el valor", () => {
    const m = mapAliclikStatus({ status: "TELEPORTED" });
    expect(m.deliveryStatus).toBeNull();
    expect(m.operational).toBeNull();
    expect(m.unknown).toContain("status=TELEPORTED");
  });

  it("registra enums desconocidos en los tres campos", () => {
    const m = mapAliclikStatus({
      status: "X1",
      dispatchStatus: "X2",
      callStatus: "X3",
    });
    expect(m.unknown).toEqual(["callStatus=X3", "status=X1", "dispatchStatus=X2"]);
    expect(m.deliveryStatus).toBeNull();
  });

  it("un despacho desconocido no borra lo que sí dice la entrega", () => {
    const m = mapAliclikStatus({ status: "DELIVERED", dispatchStatus: "X" });
    expect(m.deliveryStatus).toBe("entregado");
    expect(m.unknown).toContain("dispatchStatus=X");
  });

  it("un payload vacío no decide nada", () => {
    expect(mapAliclikStatus({}).deliveryStatus).toBeNull();
  });
});

describe("integración con reconcileDeliveryStatus", () => {
  it("un entregado no se reabre con un estado anterior", () => {
    const incoming = mapAliclikStatus({ status: "PENDING_DELIVERY", dispatchStatus: "IN_TRANSIT" });
    expect(reconcileDeliveryStatus("entregado", incoming.deliveryStatus!)).toBe("entregado");
  });

  it("un estado más avanzado sí gana", () => {
    const incoming = mapAliclikStatus({ status: "DELIVERED" });
    expect(reconcileDeliveryStatus("en_ruta", incoming.deliveryStatus!)).toBe("entregado");
  });

  it("el trabajo del equipo no se pisa con un reporte más atrasado", () => {
    const incoming = mapAliclikStatus({ status: "PENDING_DELIVERY", dispatchStatus: "TO_PREPARE" });
    expect(reconcileDeliveryStatus("en_ruta", incoming.deliveryStatus!)).toBe("en_ruta");
  });
});

describe("aliclikStatusLabel", () => {
  it("junta lo que dice Aliclik, literal, para poder auditarlo", () => {
    expect(
      aliclikStatusLabel({ status: "DELIVERED", dispatchStatus: "PICKED", callStatus: "CONFIRMED" }),
    ).toBe("DELIVERED · PICKED · CONFIRMED");
    expect(aliclikStatusLabel({ status: "DELIVERED" })).toBe("DELIVERED");
  });
});

describe("IN_AGENCY: hub de Aliclik, no agencia Shalom", () => {
  // Lo confirmó el dueño mirando su panel: para Aliclik, IN_AGENCY es su HUB
  // LOCAL, donde el paquete espera para salir hacia la provincia y entrar en su
  // reparto. No tiene nada que ver con el recojo en Shalom.
  it("en contraentrega lo llama 'en traslado', no 'registrado en agencia'", () => {
    const r = mapAliclikStatus({
      callStatus: "CONFIRMED",
      status: "PENDING_DELIVERY",
      dispatchStatus: "IN_AGENCY",
      isAgency: false,
    });
    expect(r.operational).toBe("en_traslado");
    // Etiquetarlo como agencia haría que el equipo llamara a la clienta para
    // que fuera a recoger un pedido que va a llegarle a la puerta.
    expect(r.operational).not.toBe("registrado_en_agencia");
    expect(r.pickupState).toBeNull();
  });

  it("en un envío que SÍ va por agencia, la etiqueta sigue siendo la correcta", () => {
    const r = mapAliclikStatus({
      callStatus: "CONFIRMED",
      status: "PENDING_DELIVERY",
      dispatchStatus: "IN_AGENCY",
      isAgency: true,
    });
    expect(r.operational).toBe("registrado_en_agencia");
  });
});

/**
 * La guía terminó sin entregar → el PEDIDO vuelve a la cola.
 *
 * EL CASO REAL. El MOM §11 nombra «guía cancelada por courier y devolución»
 * como entradas elegibles a Reproprovincia, y la sección de Swayp añade que una
 * salida Swayp puede coexistir con la devolución Aliclik. Pero el mapeo cierra
 * esas guías —con razón: esa guía SÍ terminó— y la cola solo miraba guías
 * abiertas, así que justo las dos entradas que el documento nombra nunca
 * llegaban. Resultado: 844 guías cerradas así, sobre 842 pedidos, con stock ya
 * puesto en provincia y sin forma de emitir la Swayp que lo aprovechara.
 */
describe("aliclikTerminoSinEntregar", () => {
  it("una devolución vuelve a la cola: es lo que el MOM §11 nombra", () => {
    expect(aliclikTerminoSinEntregar({ status: "CANCEL", dispatchStatus: "RETURNED" })).toBe(true);
    expect(aliclikTerminoSinEntregar({ status: "NOT_RESPOND", dispatchStatus: "RETURNED" })).toBe(true);
    expect(aliclikTerminoSinEntregar({ status: "REFUSED", dispatchStatus: "RETURNED" })).toBe(true);
  });

  it("y también la que TODAVÍA va de vuelta, que es cuando más sirve llamar", () => {
    // 254 de la última semana estaban así: el paquete sigue cerca de la clienta
    // y una Swayp desde el stock local puede alcanzarlo antes de que viaje entero.
    expect(aliclikTerminoSinEntregar({ status: "CANCEL", dispatchStatus: "TO_RETURN" })).toBe(true);
    expect(aliclikTerminoSinEntregar({ status: "CANCEL", dispatchStatus: "REMAINING_IN_TRANSIT" })).toBe(true);
    expect(aliclikTerminoSinEntregar({ status: "CANCEL", dispatchStatus: "STORE_CENTRAL" })).toBe(true);
    expect(aliclikTerminoSinEntregar({ status: "CANCEL", dispatchStatus: "LEFT_IN_WAREHOUSE" })).toBe(true);
  });

  it("una entrega lograda NO vuelve", () => {
    expect(aliclikTerminoSinEntregar({ status: "DELIVERED", dispatchStatus: "PICKED" })).toBe(false);
    expect(aliclikTerminoSinEntregar({ status: "DELIVERED", dispatchStatus: "RETURNED" })).toBe(false);
  });

  it("sin resultado de entrega no se adivina", () => {
    // `PENDING_DELIVERY` es «todavía no se resolvió», no «falló». Son 22 guías
    // cerradas por otro motivo: meterlas sería inventar un fracaso que nadie dijo.
    expect(aliclikTerminoSinEntregar({ status: "PENDING_DELIVERY", dispatchStatus: "TO_PREPARE" })).toBe(false);
    expect(aliclikTerminoSinEntregar({ status: "PENDING_DELIVERY", dispatchStatus: "IN_AGENCY" })).toBe(false);
    expect(aliclikTerminoSinEntregar({ status: "", dispatchStatus: "" })).toBe(false);
    expect(aliclikTerminoSinEntregar({})).toBe(false);
  });

  it("un despacho que dice que nunca salió gana sobre el status", () => {
    // Si el status dice que un intento falló pero el despacho dice que el paquete
    // sigue sin prepararse, los dos datos se contradicen. No se adivina: se
    // descarta, que es el lado barato del error.
    expect(aliclikTerminoSinEntregar({ status: "CANCEL", dispatchStatus: "TO_PREPARE" })).toBe(false);
    expect(aliclikTerminoSinEntregar({ status: "REFUSED", dispatchStatus: "PREPARED" })).toBe(false);
  });

  it("no se cae por minúsculas ni espacios", () => {
    expect(aliclikTerminoSinEntregar({ status: " cancel ", dispatchStatus: " returned " })).toBe(true);
  });
});
