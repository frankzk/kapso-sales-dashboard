import { describe, expect, it } from "vitest";
import {
  confirmationRisk,
  countLaterOrders,
  dispatchState,
  duplicateCandidates,
  emptyOutcomeCounts,
  priorCourier,
  priorOutcome,
  priorTiming,
  sameProducts,
  summarizeOutcomes,
  summarizeProducts,
  type PriorOrderSnapshot,
} from "@/lib/order-confirmation-brief";

// Esta ficha decide si se le pide plata por adelantado a un cliente. Contar de
// más le exige un depósito a alguien que compra bien; contar de menos manda un
// paquete que ya sabemos que va a volver.

function order(over: Partial<PriorOrderSnapshot> = {}): PriorOrderSnapshot {
  return {
    order_id: "o1",
    order_name: "#KP1",
    order_created_at: "2026-07-01T10:00:00.000Z",
    general_status: "pendiente",
    macro_stage: "por_confirmar",
    order_total: 89,
    ...over,
  };
}

describe("priorOutcome", () => {
  it("el estado consolidado manda sobre la macroetapa", () => {
    expect(priorOutcome(order({ general_status: "entregado", macro_stage: "por_cerrar" }))).toBe(
      "entregado",
    );
    expect(priorOutcome(order({ general_status: "anulado" }))).toBe("anulado");
    expect(priorOutcome(order({ general_status: "devuelto" }))).toBe("devuelto");
  });

  it("distingue lo abierto sin confirmar de lo abierto en camino", () => {
    // El Excel los separa —«Sin Confirmación/Pago» frente a «En Reparto»— porque
    // significan cosas opuestas: uno es trabajo pendiente, el otro flete gastado.
    expect(priorOutcome(order({ general_status: "pendiente", macro_stage: "por_confirmar" }))).toBe(
      "sin_confirmar",
    );
    expect(priorOutcome(order({ general_status: "en_proceso", macro_stage: "en_curso" }))).toBe(
      "en_curso",
    );
  });
});

describe("summarizeOutcomes", () => {
  it("cuenta cada desenlace por separado", () => {
    const counts = summarizeOutcomes([
      order({ general_status: "entregado" }),
      order({ general_status: "entregado" }),
      order({ general_status: "anulado" }),
      order({ general_status: "devuelto" }),
      order({ general_status: "pendiente", macro_stage: "por_confirmar" }),
    ]);
    expect(counts).toEqual({
      entregado: 2,
      en_curso: 0,
      anulado: 1,
      devuelto: 1,
      sin_confirmar: 1,
    });
  });

  it("sin pedidos anteriores no inventa nada", () => {
    expect(summarizeOutcomes([])).toEqual(emptyOutcomeCounts());
  });
});

describe("confirmationRisk — la tabla del MOM §8", () => {
  const counts = (over: Partial<ReturnType<typeof emptyOutcomeCounts>>) => ({
    ...emptyOutcomeCounts(),
    ...over,
  });

  it("sin antecedentes no exige nada", () => {
    expect(confirmationRisk(counts({ entregado: 3 })).requirement).toBe("ninguno");
  });

  it("1 antecedente sugiere adelanto, 2 lo exige, 3 o más pide pago completo", () => {
    expect(confirmationRisk(counts({ anulado: 1 })).requirement).toBe("sugerir_adelanto");
    expect(confirmationRisk(counts({ anulado: 2 })).requirement).toBe("exigir_adelanto");
    expect(confirmationRisk(counts({ anulado: 3 })).requirement).toBe("pago_completo");
    expect(confirmationRisk(counts({ anulado: 9 })).requirement).toBe("pago_completo");
  });

  it("anulados y devueltos suman al mismo contador", () => {
    // §8 habla de «antecedentes de rechazo/devolución», no de dos listas.
    expect(confirmationRisk(counts({ anulado: 1, devuelto: 1 })).antecedents).toBe(2);
    expect(confirmationRisk(counts({ anulado: 1, devuelto: 1 })).requirement).toBe(
      "exigir_adelanto",
    );
  });

  it("lo que sigue abierto NO cuenta como antecedente", () => {
    // Un pedido sin confirmar todavía no es un rechazo: contarlo le exigiría un
    // depósito a un cliente que aún no ha dicho que no.
    const risk = confirmationRisk(counts({ sin_confirmar: 4, en_curso: 2 }));
    expect(risk.antecedents).toBe(0);
    expect(risk.requirement).toBe("ninguno");
  });

  it("haber recibido antes NO ablanda la regla, pero sí se dice", () => {
    // La excepción COD del §8 exige justificación, actor y fecha: es una decisión
    // humana registrada, no un descuento que la herramienta se invente. Los
    // entregados se muestran porque son el argumento de quien la tome.
    const risk = confirmationRisk(counts({ entregado: 5, anulado: 3 }));
    expect(risk.requirement).toBe("pago_completo");
    expect(risk.reasons.join(" ")).toContain("sí recibe: 5 entregados");
  });

  it("los motivos nombran lo que se contó", () => {
    const risk = confirmationRisk(counts({ anulado: 2, devuelto: 1 }));
    expect(risk.reasons.join(" ")).toContain("2 pedidos anulados");
    expect(risk.reasons.join(" ")).toContain("1 devuelto");
  });
});

describe("duplicateCandidates", () => {
  it("solo lo que sigue abierto puede ser este pedido otra vez", () => {
    const dupes = duplicateCandidates([
      order({ order_id: "abierto", general_status: "pendiente", macro_stage: "por_confirmar" }),
      order({ order_id: "en_camino", general_status: "en_proceso", macro_stage: "en_curso" }),
      order({ order_id: "entregado", general_status: "entregado" }),
      order({ order_id: "anulado", general_status: "anulado" }),
    ]);
    expect(dupes.map((row) => row.order_id)).toEqual(["abierto", "en_camino"]);
  });

  it("un cliente que ya recibió y vuelve a comprar no es un duplicado", () => {
    // Es un cliente recurrente. Marcarlo llenaría de avisos falsos justo a los
    // mejores clientes, y el aviso dejaría de mirarse.
    expect(duplicateCandidates([order({ general_status: "entregado" })])).toEqual([]);
  });
});

describe("dispatchState — ¿llegó a costar flete?", () => {
  // De los 3.013 anulados de la base, 2.734 se anularon SIN despacharse y 276
  // ya iban en la calle. La ficha los contaba igual, y son casos opuestos: al
  // primero le sobra con confirmar mejor, al segundo hay que exigirle plata.
  it("sin guía nadie recogió nada", () => {
    expect(dispatchState(order({ general_status: "anulado", guide_code: null }))).toBe(
      "nunca_despachado",
    );
    expect(dispatchState(order({ general_status: "anulado", guide_code: "  " }))).toBe(
      "nunca_despachado",
    );
  });

  it("con guía salió el paquete aunque después se anulara", () => {
    expect(dispatchState(order({ general_status: "anulado", guide_code: "21-9931" }))).toBe(
      "despachado",
    );
  });

  it("lo entregado se nombra por su desenlace, no por la guía", () => {
    expect(dispatchState(order({ general_status: "entregado", guide_code: "21-9931" }))).toBe(
      "entregado",
    );
  });
});

describe("priorCourier", () => {
  it("manda el que cerró la historia, no el que la empezó", () => {
    // Un pedido que pasó de Aliclik a agencia tiene los tres campos llenos.
    expect(
      priorCourier(
        order({ delivered_courier: "Aliclik", current_courier: "Shalom", last_courier: "Olva" }),
      ),
    ).toBe("Aliclik");
    expect(priorCourier(order({ current_courier: "Shalom", last_courier: "Olva" }))).toBe("Shalom");
    expect(priorCourier(order({ last_courier: "Olva" }))).toBe("Olva");
    expect(priorCourier(order({}))).toBeNull();
  });
});

describe("priorTiming — no todos los del historial son anteriores", () => {
  const reference = "2026-06-28T10:00:00.000Z";

  it("un re-pedido posterior no es un antecedente previo", () => {
    // Caso real: un pedido del 28/06 que nadie confirmó, y el mismo cliente
    // pidiendo otras tres veces en julio y agosto. Leído como «3 pedidos
    // anteriores anulados» parece mal historial; leído en orden real es un
    // pedido estancado que el cliente ya volvió a intentar tres veces.
    expect(priorTiming(order({ order_created_at: "2026-08-03T10:00:00.000Z" }), reference)).toBe(
      "posterior",
    );
    expect(priorTiming(order({ order_created_at: "2026-05-01T10:00:00.000Z" }), reference)).toBe(
      "anterior",
    );
  });

  it("sin fecha no afirma que sea posterior", () => {
    expect(priorTiming(order({ order_created_at: null }), reference)).toBe("anterior");
    expect(priorTiming(order({ order_created_at: "2026-08-03T10:00:00.000Z" }), null)).toBe(
      "anterior",
    );
  });

  it("cuenta cuántos son posteriores", () => {
    const priors = [
      order({ order_id: "a", order_created_at: "2026-08-03T10:00:00.000Z" }),
      order({ order_id: "b", order_created_at: "2026-07-20T10:00:00.000Z" }),
      order({ order_id: "c", order_created_at: "2026-05-01T10:00:00.000Z" }),
    ];
    expect(countLaterOrders(priors, reference)).toBe(2);
  });
});

describe("summarizeProducts", () => {
  it("resume las líneas en una sola", () => {
    expect(summarizeProducts([{ quantity: 3, name: "Nattokinase" }])).toBe("Nattokinase ×3");
    expect(
      summarizeProducts([
        { quantity: 3, name: "Nattokinase" },
        { quantity: 1, name: "Omega" },
      ]),
    ).toBe("Nattokinase ×3 · Omega");
  });

  it("recorta lo que no cabe sin mentir sobre el total", () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ quantity: 1, name: `P${n}` }));
    expect(summarizeProducts(many, 3)).toBe("P1 · P2 · P3 +2");
  });

  it("sin líneas no inventa texto", () => {
    expect(summarizeProducts([])).toBeNull();
  });
});

describe("sameProducts", () => {
  it("detecta el mismo pedido repetido", () => {
    // Los cuatro pedidos del caso real son «Nattokinase ×3» al mismo distrito:
    // no es un historial de compras variado, es el mismo pedido una y otra vez.
    expect(sameProducts("Nattokinase ×3", "nattokinase ×3")).toBe(true);
    expect(sameProducts("Nattokinase ×3", "Nattokinase ×1")).toBe(false);
  });

  it("dos pedidos sin producto conocido no «coinciden»", () => {
    expect(sameProducts(null, null)).toBe(false);
    expect(sameProducts("", "")).toBe(false);
  });
});

describe("confirmationRisk — cuánto de lo anulado costó flete", () => {
  it("dice que ninguno salió cuando ninguno salió", () => {
    const priors = [
      order({ order_id: "a", general_status: "anulado", guide_code: null }),
      order({ order_id: "b", general_status: "anulado", guide_code: null }),
    ];
    const risk = confirmationRisk(summarizeOutcomes(priors), priors);
    expect(risk.antecedents).toBe(2);
    expect(risk.reasons.join(" ")).toContain("ninguno llegó a despacharse");
  });

  it("distingue los que sí se despacharon", () => {
    const priors = [
      order({ order_id: "a", general_status: "anulado", guide_code: "21-1" }),
      order({ order_id: "b", general_status: "anulado", guide_code: null }),
    ];
    expect(confirmationRisk(summarizeOutcomes(priors), priors).reasons.join(" ")).toContain(
      "1 ya despachado",
    );
  });

  it("el detalle NO cambia el número de antecedentes", () => {
    // La tabla del §8 cuenta anulados y devueltos, sin importar si salieron. El
    // desglose se muestra para que la excepción humana esté informada; ablandar
    // la regla sola sería inventarse una excepción que el MOM da a una persona.
    const priors = [
      order({ order_id: "a", general_status: "anulado", guide_code: null }),
      order({ order_id: "b", general_status: "anulado", guide_code: null }),
      order({ order_id: "c", general_status: "anulado", guide_code: null }),
    ];
    const risk = confirmationRisk(summarizeOutcomes(priors), priors);
    expect(risk.antecedents).toBe(3);
    expect(risk.requirement).toBe("pago_completo");
  });
});
