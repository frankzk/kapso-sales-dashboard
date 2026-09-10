import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENCY_ATTESTED_MATCH,
  AGENCY_COURIER_OPTIONS,
  AGENCY_DISPATCHED_STATUSES,
  attestedShipmentNote,
  attestedShipmentState,
  isAgencyCourierChoice,
  needsAttestedAgencyShipment,
} from "@/lib/agency-attested-shipment";

const agencia = (operational: string, shipmentCount = 0) =>
  needsAttestedAgencyShipment({ coverage: "agencia", operational, shipmentCount });

describe("cuándo hay que preguntar por dónde salió", () => {
  // Los pedidos de agencia cuyo estado viene del rastreo de Shalom tienen salida
  // el 100% de las veces (107 de 107). Los marcados a mano fallan el 18,5% (42 de
  // 227), y esos 42 desaparecen de todo indicador de envío.
  it("un pedido de agencia que ya llegó y no tiene salida", () => {
    expect(agencia("recogido")).toBe(true);
    expect(agencia("entregado")).toBe(true);
    expect(agencia("disponible_para_recojo")).toBe(true);
    expect(agencia("en_transito")).toBe(true);
    expect(agencia("proximo_a_vencer")).toBe(true);
  });

  it("con una salida ya registrada no se pregunta nada", () => {
    expect(agencia("recogido", 1)).toBe(false);
    expect(agencia("entregado", 3)).toBe(false);
  });

  // La caja preparada que todavía no ha salido. Meterlo en la lista obligaría a
  // inventar una salida antes de que exista, que es el error contrario.
  it("«pendiente de envío» no ha salido: no se pregunta", () => {
    expect(agencia("pendiente_de_envio")).toBe(false);
  });

  it("un estado que no dice nada del envío tampoco pregunta", () => {
    expect(agencia("sin_confirmar")).toBe(false);
    expect(agencia("sin_asignar_courier")).toBe(false);
    expect(agencia("anulado")).toBe(false);
    expect(agencia("")).toBe(false);
    expect(agencia(null as never)).toBe(false);
  });

  // SOLO AGENCIA, y es una decisión con cifras detrás: es donde está medido el
  // agujero y donde la guía sostiene el aviso de vencimiento. Lima sale por la
  // mesa de despacho, que ya crea la salida sola.
  it("Lima y Provincia no se tocan", () => {
    for (const coverage of ["lima", "provincia_cod", null, undefined, ""]) {
      expect(
        needsAttestedAgencyShipment({ coverage, operational: "entregado", shipmentCount: 0 }),
      ).toBe(false);
    }
  });
});

describe("la salida nace en el estado del pedido", () => {
  // Si naciera «pendiente», el recálculo la leería y tiraría el estado del pedido
  // HACIA ATRÁS: el marcado se desharía solo, que es peor que no registrar nada.
  it("recogido y entregado nacen entregados", () => {
    for (const estado of ["recogido", "entregado"]) {
      expect(attestedShipmentState(estado)).toEqual({
        delivery_status: "entregado",
        status_category: "delivered",
        pickup_state: "recogido",
      });
    }
  });

  it("una caja esperando en la sucursal nace pendiente, no entregada", () => {
    expect(attestedShipmentState("disponible_para_recojo")).toEqual({
      delivery_status: "pendiente",
      status_category: "pending",
      pickup_state: "disponible_para_recojo",
    });
    expect(attestedShipmentState("proximo_a_vencer").pickup_state).toBe("proximo_a_vencer");
  });

  it("el retorno y la devolución no se pintan como entrega", () => {
    expect(attestedShipmentState("retorno_iniciado").delivery_status).toBe("en_ruta");
    expect(attestedShipmentState("devuelto_al_origen").delivery_status).toBe("devuelto");
    expect(attestedShipmentState("devuelto_al_origen").status_category).toBe("closed");
  });

  it("ningún estado de la lista nace en un limbo sin categoría", () => {
    for (const estado of AGENCY_DISPATCHED_STATUSES) {
      const state = attestedShipmentState(estado);
      expect(state.delivery_status).toBeTruthy();
      expect(state.status_category).toBeTruthy();
      expect(state.pickup_state).toBeTruthy();
    }
  });
});

describe("el courier elegido", () => {
  it("solo Shalom u Olva", () => {
    expect(isAgencyCourierChoice("shalom")).toBe(true);
    expect(isAgencyCourierChoice("olva")).toBe(true);
    expect(isAgencyCourierChoice("aliclik")).toBe(false);
    expect(isAgencyCourierChoice("por_definir")).toBe(false);
    expect(isAgencyCourierChoice("")).toBe(false);
    expect(isAgencyCourierChoice(null)).toBe(false);
    expect(isAgencyCourierChoice(undefined)).toBe(false);
  });

  // Olva tiene que estar en la lista: es el que falta. Kapta lleva 866 salidas de
  // Shalom y CERO de Olva en 40 días, con el flujo de salida manual admitiéndolo
  // desde antes. Si el desplegable solo ofreciera Shalom, la persona elegiría el
  // courier equivocado con tal de poder guardar.
  it("Olva está entre las opciones", () => {
    expect(AGENCY_COURIER_OPTIONS.map((o) => o.value)).toContain("olva");
    expect(AGENCY_COURIER_OPTIONS.map((o) => o.value)).toContain("shalom");
  });
});

// La nota tiene que decir que la fecha es la del registro y no la del envío: la
// cohorte de los indicadores de despacho se arma con esa fecha, así que un pedido
// salido en julio y atestiguado hoy cuenta como despacho de hoy.
describe("la nota deja constancia de lo que se está afirmando", () => {
  it("nombra el courier y advierte de la fecha", () => {
    const nota = attestedShipmentNote("olva", "recogido");
    expect(nota).toContain("Olva");
    expect(nota).toContain("recogido");
    expect(nota).toContain("fecha de despacho es la de este registro");
  });
});

// El experimento puede estar bien pensado y no aplicarse: si la pantalla no
// pregunta o el servidor no exige, el agujero sigue abierto. Estas guardas leen
// el fuente para probar que la regla LLEGA a los dos lados.
describe("la regla se aplica en la pantalla y en el servidor", () => {
  const actions = readFileSync(
    new URL("../app/dashboard/pedidos/actions.ts", import.meta.url),
    "utf8",
  );
  const ui = readFileSync(new URL("../components/orders-master.tsx", import.meta.url), "utf8");

  it("el servidor rechaza el marcado sin courier", () => {
    expect(actions).toContain("needsAttestedAgencyShipment({");
    expect(actions).toContain("needsCourier && !isAgencyCourierChoice(input.agencyCourier)");
    expect(actions).toContain("needsAgencyCourier: true");
  });

  // Sin esto, un fallo de lectura de `shipments` daría `shipmentCount = 0` y
  // pediría courier a pedidos que sí tienen salida — o al revés, según cómo se
  // escribiera. Se corta antes.
  it("un fallo al contar las salidas aborta en vez de adivinar", () => {
    const bloque = actions.slice(
      actions.indexOf("const { count: shipmentCount"),
      actions.indexOf("const needsCourier"),
    );
    expect(bloque).toContain("if (countError)");
    expect(bloque).toContain("return {");
  });

  // La salida se escribe DESPUÉS del evento de estado: si fallara, el marcado ya
  // quedó y el pedido sigue como estaba respecto de la salida — el agujero de
  // siempre, no uno nuevo.
  it("la salida se registra después de escribir el estado", () => {
    expect(actions.indexOf('kind: "status_override"')).toBeLessThan(
      actions.indexOf("attestAgencyShipment(admin, ctx"),
    );
  });

  // `match_method` propio: quien audite tiene que distinguir la salida que trajo
  // el courier de la que afirmó una persona. Es la misma doctrina que el MOM ya
  // fija para las guías creadas en el portal de Aliclik.
  it("la salida se marca como atestiguada, no como una salida normal", () => {
    expect(actions).toContain("match_method: AGENCY_ATTESTED_MATCH");
    expect(AGENCY_ATTESTED_MATCH).toBe("agency_operator_attested");
    expect(AGENCY_ATTESTED_MATCH).not.toBe("manual");
  });

  // Sin código de guía: la tiene el mostrador de la agencia. Uno inventado se
  // cotejaría contra el reporte del courier y no casaría nunca.
  it("no se inventa un código de guía", () => {
    const bloque = actions.slice(actions.indexOf("async function attestAgencyShipment"));
    expect(bloque).toContain("guide_code: null");
  });

  it("la pantalla pregunta con la MISMA función pura, sin recopiarla", () => {
    expect(ui).toContain("needsAttestedAgencyShipment({");
    expect(ui).toContain("AGENCY_COURIER_OPTIONS.map");
    // Y no deja guardar sin elegir.
    expect(ui).toContain("(needsAgencyCourier && !agencyCourier)");
  });

  it("la pantalla le pasa al servidor lo que eligió", () => {
    expect(ui).toContain("setOrderStatus(orderId, { general, operational, reason, agencyCourier })");
    expect(ui).toContain("outputCount={detail.routePlan.outputCount}");
  });
});
