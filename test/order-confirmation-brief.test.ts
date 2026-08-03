import { describe, expect, it } from "vitest";
import {
  confirmationRisk,
  duplicateCandidates,
  emptyOutcomeCounts,
  priorOutcome,
  summarizeOutcomes,
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
