import { describe, expect, it } from "vitest";
import { expectedCollectAmount, isWebPrepaid, orderFullyPaid } from "@/lib/order-paid";
import { defaultCollectionAmount } from "@/lib/tanders/draft";
import { collectAmountMismatch } from "@/lib/aliclik-money";

/**
 * «Ya está pagado», con dos vías de cobro.
 *
 * QUÉ PASÓ. Empezaron a entrar pedidos pagados en el checkout (EasySell +
 * pasarela, `financial_status = 'paid'` — 870 en 60 días). Para todo el sistema
 * «pagado» significaba UNA cosa: comprobantes de Yape en `order_payments`. Un
 * pedido pagado con tarjeta no tiene ni una fila ahí, así que salía `sin_pago` y
 * la guía se creaba diciéndole al motorizado que cobrara el total.
 *
 * El comentario de `defaultCollectionAmount` ya lo advertía —«si se manda el
 * total, el repartidor le cobra al cliente algo que ya pagó»—; lo que le faltaba
 * era saber que el dinero puede entrar por otro sitio.
 */

const YAPE_COMPLETO = { paymentState: "pago_completo" };
const WEB = { financialStatus: "paid", totalRefunded: 0 };

describe("isWebPrepaid: ¿lo cobró la pasarela?", () => {
  it("solo `paid` cuenta", () => {
    expect(isWebPrepaid({ financialStatus: "paid" })).toBe(true);
    // Los otros dos estados que existen de verdad en esta operación.
    expect(isWebPrepaid({ financialStatus: "pending" })).toBe(false);
    expect(isWebPrepaid({ financialStatus: "voided" })).toBe(false);
  });

  it("un estado a medias NO cuenta como pagado", () => {
    // Hoy no aparece en la base, y si algún día aparece el lado seguro del error
    // es no darlo por cobrado: como mucho se cobra una vez de más en la puerta,
    // nunca dos veces al cliente.
    expect(isWebPrepaid({ financialStatus: "partially_paid" })).toBe(false);
    expect(isWebPrepaid({ financialStatus: "authorized" })).toBe(false);
  });

  it("tolera mayúsculas y espacios, que vienen de fuera", () => {
    expect(isWebPrepaid({ financialStatus: " PAID " })).toBe(true);
  });

  it("un reembolso deshace el prepago: el dinero volvió", () => {
    expect(isWebPrepaid({ financialStatus: "paid", totalRefunded: 0.01 })).toBe(false);
    expect(isWebPrepaid({ financialStatus: "paid", totalRefunded: 456.3 })).toBe(false);
  });

  it("sin datos no inventa un cobro", () => {
    expect(isWebPrepaid({})).toBe(false);
    expect(isWebPrepaid({ financialStatus: null })).toBe(false);
  });
});

describe("orderFullyPaid: las dos vías, sin sumarlas", () => {
  it("vale cualquiera de las dos", () => {
    expect(orderFullyPaid(WEB)).toBe(true);
    expect(orderFullyPaid(YAPE_COMPLETO)).toBe(true);
  });

  it("un adelanto validado NO es pago completo", () => {
    expect(orderFullyPaid({ paymentState: "adelanto_validado" })).toBe(false);
    expect(orderFullyPaid({ paymentState: "pago_total_cargado" })).toBe(false);
  });

  it("un pedido sin ninguna de las dos sigue por cobrar", () => {
    expect(orderFullyPaid({ financialStatus: "pending", paymentState: "sin_pago" })).toBe(false);
  });
});

describe("expectedCollectAmount: la única respuesta a «cuánto cobra el courier»", () => {
  it("un pedido pagado por web cobra CERO", () => {
    // ESTA es la regresión: antes salía el total entero.
    expect(expectedCollectAmount(WEB, 456.3)).toBe(0);
  });

  it("un pedido pagado por Yape sigue cobrando cero", () => {
    expect(expectedCollectAmount(YAPE_COMPLETO, 456.3)).toBe(0);
  });

  it("un pedido por cobrar cobra su total", () => {
    expect(expectedCollectAmount({ financialStatus: "pending" }, 456.3)).toBe(456.3);
  });

  it("un total ausente o absurdo no se convierte en un cobro raro", () => {
    for (const total of [null, undefined, 0, -10, Number.NaN]) {
      expect(expectedCollectAmount({ financialStatus: "pending" }, total), String(total)).toBe(0);
    }
  });

  it("redondea a céntimos", () => {
    expect(expectedCollectAmount({ financialStatus: "pending" }, 456.30049)).toBe(456.3);
  });
});

describe("la guía de Tanders sale con el monto correcto", () => {
  it("un pedido pagado por WEB ya no manda cobrar el total", () => {
    expect(
      defaultCollectionAmount({
        paymentState: "sin_pago",
        orderTotal: 456.3,
        financialStatus: "paid",
        totalRefunded: 0,
      }),
    ).toBe(0);
  });

  it("y el caso de siempre —Yape completo— sigue igual", () => {
    expect(defaultCollectionAmount({ paymentState: "pago_completo", orderTotal: 456.3 })).toBe(0);
  });

  it("un pedido por cobrar sigue cobrando", () => {
    expect(defaultCollectionAmount({ paymentState: "sin_pago", orderTotal: 456.3 })).toBe(456.3);
  });
});

describe("el detector deja de ser ciego al prepago", () => {
  it("un cobro sobre un pedido YA PAGADO se grita entero", () => {
    // Antes: reported 456.30 contra orderTotal 456.30 → «cuadra», silencio.
    // Es el caso más caro, porque el cliente ya puso el dinero una vez.
    const antes = collectAmountMismatch(456.3, 456.3);
    expect(antes).toBeNull();

    const ahora = collectAmountMismatch(456.3, 456.3, undefined, WEB);
    expect(ahora?.kind).toBe("cobra_de_mas");
    expect(ahora?.gap).toBe(456.3);
    expect(ahora?.message).toContain("YA ESTÁ PAGADO");
  });

  it("también cuando el pago fue por Yape", () => {
    expect(collectAmountMismatch(456.3, 456.3, undefined, YAPE_COMPLETO)?.kind).toBe("cobra_de_mas");
  });

  it("una guía en 0 sobre un pedido pagado NO avisa: es lo correcto", () => {
    expect(collectAmountMismatch(0, 456.3, undefined, WEB)).toBeNull();
  });

  it("sin el dato de pago se comporta exactamente como antes", () => {
    // Compatibilidad: los llamadores que no sepan del prepago no cambian de
    // comportamiento, y el fallo de los S/447 se sigue detectando igual.
    expect(collectAmountMismatch(447, 298)?.kind).toBe("cobra_de_mas");
    expect(collectAmountMismatch(298, 298)).toBeNull();
    expect(collectAmountMismatch(297, 298)).toBeNull();
  });

  it("el aviso dice qué hacer, no solo que algo no cuadra", () => {
    const m = collectAmountMismatch(456.3, 456.3, undefined, WEB);
    expect(m?.message).toContain("Anula el cobro con el courier");
    expect(m?.message).toContain("paga dos veces");
  });
});
