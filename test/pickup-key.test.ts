import { describe, expect, it } from "vitest";
import {
  canRevealPickupKey,
  describeBlockers,
  keyState,
  paymentState,
  usesPickupKeyFlow,
  type PaymentSnapshot,
  type PickupKeyContext,
} from "@/lib/pickup-key";

const ORDER = "order-1";

function payment(kind: string, status = "validado", orderId = ORDER): PaymentSnapshot {
  return { kind, validation_status: status, order_id: orderId };
}

function ctx(over: Partial<PickupKeyContext> = {}): PickupKeyContext {
  return {
    orderId: ORDER,
    generalStatus: "en_proceso",
    pickupState: "disponible_para_recojo",
    payments: [payment("adelanto"), payment("diferencia")],
    hasKey: true,
    ...over,
  };
}

describe("canRevealPickupKey — las seis condiciones", () => {
  it("con los dos Yapes validados y el paquete disponible, se muestra", () => {
    const v = canRevealPickupKey(ctx());
    expect(v.allowed).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it("sin clave registrada no hay nada que mostrar", () => {
    expect(canRevealPickupKey(ctx({ hasKey: false })).blockers).toContain("sin_clave");
  });

  it("sin adelanto cargado", () => {
    const v = canRevealPickupKey(ctx({ payments: [payment("diferencia")] }));
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("adelanto_no_registrado");
  });

  it("adelanto cargado pero sin validar: una imagen no basta", () => {
    const v = canRevealPickupKey(ctx({ payments: [payment("adelanto", "pendiente_revision"), payment("diferencia")] }));
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("adelanto_no_validado");
  });

  it("sin diferencia cargada", () => {
    const v = canRevealPickupKey(ctx({ payments: [payment("adelanto")] }));
    expect(v.blockers).toContain("diferencia_no_registrada");
  });

  it("diferencia sin validar", () => {
    const v = canRevealPickupKey(ctx({ payments: [payment("adelanto"), payment("diferencia", "pendiente_revision")] }));
    expect(v.blockers).toContain("diferencia_no_validada");
  });

  it("un comprobante rechazado cuenta como no registrado", () => {
    const v = canRevealPickupKey(ctx({ payments: [payment("adelanto"), payment("diferencia", "rechazado")] }));
    expect(v.blockers).toContain("diferencia_no_registrada");
  });

  it("un pago asociado a otro pedido bloquea", () => {
    const v = canRevealPickupKey(ctx({ payments: [payment("adelanto", "validado", "otro"), payment("diferencia")] }));
    expect(v.blockers).toContain("pago_de_otro_pedido");
  });

  it("un pedido cerrado no entrega la clave", () => {
    for (const status of ["anulado", "entregado", "devuelto"]) {
      expect(canRevealPickupKey(ctx({ generalStatus: status })).blockers).toContain("pedido_cerrado");
    }
  });

  it("el paquete todavía en tránsito bloquea", () => {
    expect(canRevealPickupKey(ctx({ pickupState: "en_transito" })).blockers).toContain(
      "paquete_no_disponible",
    );
  });

  it("sin información de dónde está el paquete NO se bloquea por ello", () => {
    // "cuando esa información esté disponible": bloquear sin saber dejaría fuera
    // a todo courier que no reporte sub-estado.
    const v = canRevealPickupKey(ctx({ pickupState: null }));
    expect(v.allowed).toBe(true);
  });

  it("devuelve todos los motivos a la vez, no solo el primero", () => {
    const v = canRevealPickupKey(
      ctx({ hasKey: false, payments: [], generalStatus: "anulado", pickupState: "en_transito" }),
    );
    expect(v.blockers).toEqual([
      "sin_clave",
      "adelanto_no_registrado",
      "diferencia_no_registrada",
      "pedido_cerrado",
      "paquete_no_disponible",
    ]);
    expect(describeBlockers(v)).toContain("Falta cargar el Yape de adelanto.");
  });
});

describe("paymentState — indicador del Master", () => {
  it("recorre el ciclo de cobro", () => {
    expect(paymentState([])).toBe("sin_pago");
    expect(paymentState([payment("adelanto", "pendiente_revision")])).toBe("adelanto_cargado");
    expect(paymentState([payment("adelanto")])).toBe("adelanto_validado");
    expect(paymentState([payment("adelanto"), payment("diferencia", "pendiente_revision")])).toBe(
      "diferencia_cargada",
    );
    expect(paymentState([payment("adelanto"), payment("diferencia")])).toBe("pago_completo");
  });

  it("una posible duplicidad se anuncia por encima de todo", () => {
    expect(
      paymentState([payment("adelanto"), payment("diferencia", "posible_duplicado")]),
    ).toBe("posible_duplicado");
  });
});

describe("keyState", () => {
  it("distingue sin clave, bloqueada, disponible y enviada", () => {
    expect(keyState({ ...ctx({ hasKey: false }), shared: false })).toBe("sin_clave");
    expect(keyState({ ...ctx({ payments: [payment("adelanto")] }), shared: false })).toBe("clave_bloqueada");
    expect(keyState({ ...ctx(), shared: false })).toBe("clave_disponible");
    expect(keyState({ ...ctx(), shared: true })).toBe("clave_enviada");
  });
});

describe("usesPickupKeyFlow", () => {
  it("aplica a Shalom y a los envíos por agencia", () => {
    expect(usesPickupKeyFlow("shalom", "cod")).toBe(true);
    expect(usesPickupKeyFlow("aliclik", "agency")).toBe(true);
    expect(usesPickupKeyFlow("aliclik", "cod")).toBe(false);
    expect(usesPickupKeyFlow(null, null)).toBe(false);
  });

  // Un pedido sin courier y sin modalidad da `false`, y eso ESTÁ BIEN acá: la
  // función responde "¿este pedido ya va por agencia?", no "¿podría ir?".
  //
  // Lo que no puede es ser la única condición para enseñar el panel de pagos.
  // `current_courier` no vale 'shalom' hasta que la guía existe, y crear la guía
  // exige el adelanto: si el panel dependiera solo de esto, para registrar el
  // pago haría falta la guía y para la guía el pago. El drawer añade por eso la
  // condición de "todavía puede ir por Shalom" (sin guía y con permiso).
  it("un pedido sin decidir no cuenta como de agencia — el drawer lo compensa aparte", () => {
    expect(usesPickupKeyFlow(null, null)).toBe(false);
    expect(usesPickupKeyFlow(null, "cod")).toBe(false);
  });
});
