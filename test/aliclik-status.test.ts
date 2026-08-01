import { describe, it, expect } from "vitest";
import {
  aliclikStatusLabel,
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
