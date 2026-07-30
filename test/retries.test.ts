import { describe, expect, it } from "vitest";
import {
  assessRisk,
  retryDecision,
  sortByAttention,
  type RetryHistory,
} from "@/lib/retries";

function hist(over: Partial<RetryHistory> = {}): RetryHistory {
  return {
    order_id: over.order_id ?? "o1",
    attempts: over.attempts ?? 0,
    lastReason: over.lastReason !== undefined ? over.lastReason : null,
    customerFailed: over.customerFailed ?? 0,
    customerDelivered: over.customerDelivered ?? 0,
  };
}

describe("retryDecision", () => {
  it("los motivos de reintento no bloquean", () => {
    for (const r of ["no_contesta", "no_estaba", "reprogramado", "sin_dinero", "otro", null]) {
      expect(retryDecision(r).retryable).toBe(true);
    }
  });

  it("una dirección errada NO se reintenta tal cual", () => {
    // Volver al mismo sitio equivocado cuesta otro flete y falla igual.
    const d = retryDecision("direccion_errada");
    expect(d.retryable).toBe(false);
    expect(d.blockedReason).toContain("dirección");
  });

  it("un rechazo no es un reintento, es una venta perdida", () => {
    expect(retryDecision("rechazado").retryable).toBe(false);
  });
});

describe("assessRisk", () => {
  it("un primer fallo no enciende alarmas", () => {
    const r = assessRisk(hist({ attempts: 1, lastReason: "no_contesta" }));
    expect(r.level).toBe("ok");
    expect(r.retryable).toBe(true);
  });

  it("dos intentos ponen el pedido en vigilancia, tres en riesgo alto", () => {
    expect(assessRisk(hist({ attempts: 2 })).level).toBe("vigilar");
    expect(assessRisk(hist({ attempts: 3 })).level).toBe("alto");
  });

  it("un cliente que nunca recibió es riesgo alto aunque sea su primer intento hoy", () => {
    // Tres pedidos y cero entregas no es mala suerte: es un patrón.
    const r = assessRisk(hist({ attempts: 0, customerFailed: 3, customerDelivered: 0 }));
    expect(r.level).toBe("alto");
    expect(r.reasons.some((x) => x.includes("ninguno llegó"))).toBe(true);
  });

  it("un cliente que SÍ recibe no sube a riesgo por su historial", () => {
    // Sabemos que la dirección existe y que abre la puerta: este pedido puede
    // ser mala suerte, y bloquearlo costaría una venta buena.
    const r = assessRisk(hist({ attempts: 1, customerFailed: 3, customerDelivered: 4 }));
    expect(r.level).toBe("ok");
    expect(r.reasons.some((x) => x.includes("sí recibe"))).toBe(true);
  });

  it("el segundo pedido de un cliente que nunca recibió se vigila", () => {
    const r = assessRisk(hist({ customerFailed: 1, customerDelivered: 0 }));
    expect(r.level).toBe("vigilar");
  });

  it("un motivo bloqueante manda sobre todo lo demás", () => {
    const r = assessRisk(hist({ attempts: 0, lastReason: "direccion_errada" }));
    expect(r.level).toBe("alto");
    expect(r.retryable).toBe(false);
  });

  it("siempre explica por qué está marcado", () => {
    const r = assessRisk(hist({ attempts: 3, customerFailed: 2, customerDelivered: 0 }));
    expect(r.reasons.length).toBeGreaterThan(1);
    expect(r.reasons.every((x) => x.length > 0)).toBe(true);
  });
});

describe("sortByAttention", () => {
  it("pone delante lo que exige una decisión", () => {
    const items = [
      { id: "sano", attempts: 0, risk: assessRisk(hist()) },
      { id: "alto", attempts: 3, risk: assessRisk(hist({ attempts: 3 })) },
      { id: "bloqueado", attempts: 1, risk: assessRisk(hist({ lastReason: "direccion_errada" })) },
      { id: "vigilar", attempts: 2, risk: assessRisk(hist({ attempts: 2 })) },
    ];
    expect(sortByAttention(items).map((i) => i.id)).toEqual([
      "bloqueado",
      "alto",
      "vigilar",
      "sano",
    ]);
  });

  it("dentro del mismo grupo, primero lo que más intentos lleva", () => {
    const items = [
      { id: "uno", attempts: 3, risk: assessRisk(hist({ attempts: 3 })) },
      { id: "dos", attempts: 5, risk: assessRisk(hist({ attempts: 5 })) },
    ];
    expect(sortByAttention(items).map((i) => i.id)).toEqual(["dos", "uno"]);
  });

  it("no muta el arreglo de entrada", () => {
    const items = [
      { id: "a", attempts: 0, risk: assessRisk(hist()) },
      { id: "b", attempts: 9, risk: assessRisk(hist({ attempts: 9 })) },
    ];
    sortByAttention(items);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
