// La firma humana manda sobre la guía Tanders.
//
// EL CASO (24-09-2026). De 124 cobros que una persona validó en «Validar
// pagos», 49 se quedaron con la guía en `en_ruta` y el pedido «En curso · En
// tránsito», aunque Tanders los daba por entregados y alguien había firmado que
// el dinero llegó. La guía solo pasaba a `entregado` con el veredicto del
// MODELO, y esos 49 eran justo los que el modelo había rechazado o no había
// podido leer. La persona los aprobaba, se emitía el cierre de liquidación… y
// el pedido no podía cerrar porque, para el Master, nunca se había entregado.
//
// Lo que se fija acá es la regla pura. La usan las acciones de «Validar pagos»
// y el relleno 0191, así que una sola prueba cubre las dos.

import { describe, expect, it } from "vitest";
import { guidePatchForHumanRuling } from "@/lib/tanders/collection-payment";

const guia = (over: Partial<Parameters<typeof guidePatchForHumanRuling>[0]> = {}) => ({
  delivery_status: "en_ruta",
  reported_status: "DELIVERED",
  payment_check_state: "rechazado",
  ...over,
});

describe("guidePatchForHumanRuling — validar", () => {
  it("una persona valida lo que el modelo rechazó: la guía se entrega", () => {
    // Es exactamente uno de los 49.
    expect(guidePatchForHumanRuling(guia(), "validado")).toEqual({
      payment_check_state: "revisado",
      delivery_status: "entregado",
      status_category: "delivered",
    });
  });

  it("también cuando el modelo no pudo leerla", () => {
    const patch = guidePatchForHumanRuling(guia({ payment_check_state: "pendiente" }), "validado");
    expect(patch.payment_check_state).toBe("revisado");
    expect(patch.delivery_status).toBe("entregado");
  });

  it("si modelo y persona estaban de acuerdo, se queda en `validado`", () => {
    // `revisado` es «una persona corrigió al lector». Marcar como revisado lo
    // que el lector ya había dado por bueno borraría justo la cifra que
    // interesa al auditar.
    const patch = guidePatchForHumanRuling(
      guia({ payment_check_state: "validado", delivery_status: "entregado" }),
      "validado",
    );
    expect(patch).toEqual({ payment_check_state: "validado" });
  });

  it("nunca afirma una entrega que Tanders no acredita", () => {
    // Validar el dinero no es ver el paquete llegar. Si el courier no la da
    // por entregada, el cobro queda revisado pero la guía no se mueve.
    const patch = guidePatchForHumanRuling(guia({ reported_status: "PICKED" }), "validado");
    expect(patch).toEqual({ payment_check_state: "revisado" });
  });

  it("tolera el crudo en minúsculas o con espacios", () => {
    const patch = guidePatchForHumanRuling(guia({ reported_status: " delivered " }), "validado");
    expect(patch.delivery_status).toBe("entregado");
  });
});

describe("guidePatchForHumanRuling — retirar", () => {
  it("retirar la firma de un cobro deshace la entrega", () => {
    // `entregado` significa «entregado Y cobrado» (§9.4). Si el cobro deja de
    // estar probado, deja de ser cierto; `en_ruta` es lo que el courier sí
    // acredita.
    expect(
      guidePatchForHumanRuling(
        guia({ delivery_status: "entregado", payment_check_state: "revisado" }),
        "retirado",
      ),
    ).toEqual({
      payment_check_state: "rechazado",
      delivery_status: "en_ruta",
      status_category: "in_route",
    });
  });

  it("si la guía no estaba entregada, solo marca el cobro", () => {
    expect(guidePatchForHumanRuling(guia(), "retirado")).toEqual({
      payment_check_state: "rechazado",
    });
  });
});
