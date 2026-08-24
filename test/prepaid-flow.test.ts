import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canRevealPickupKey } from "@/lib/pickup-key";
import { orderPaymentPanelPresentation } from "@/lib/order-payment-panel";

/**
 * Un pedido pagado en el checkout, de punta a punta.
 *
 * La pieza cara de este bloque NO es cosmética. `canRevealPickupKey` exige un
 * adelanto y una diferencia en `order_payments`, y un pedido pagado con tarjeta
 * no tiene NI UNA fila ahí: «falta el adelanto» era cierto para siempre. El
 * cliente pagaba, el paquete llegaba a la agencia de Shalom, y no había forma de
 * darle la clave para recogerlo.
 */

const PREPAID = { financialStatus: "paid", totalRefunded: 0 };

const ctx = (over: Record<string, unknown> = {}) => ({
  orderId: "o1",
  generalStatus: "en_proceso",
  pickupState: "disponible_para_recojo",
  payments: [],
  orderTotal: 456.3,
  hasKey: true,
  ...over,
});

describe("la clave de recojo de un pedido pagado por web", () => {
  it("se entrega: no se le piden comprobantes a quien ya pagó", () => {
    // ESTA es la regresión. Sin `paymentFacts` el veredicto trae
    // `adelanto_no_registrado` y `diferencia_no_registrada`, y no hay manera
    // humana de resolverlos: no existe un Yape que cargar.
    const sinDatos = canRevealPickupKey(ctx());
    expect(sinDatos.allowed).toBe(false);
    expect(sinDatos.blockers).toContain("adelanto_no_registrado");

    const conDatos = canRevealPickupKey(ctx({ paymentFacts: PREPAID }));
    expect(conDatos.allowed).toBe(true);
    expect(conDatos.blockers).toEqual([]);
  });

  it("pero sigue exigiendo lo que NO habla de dinero", () => {
    // Saltarse el cobro no es saltarse el resto: sin clave registrada no hay
    // nada que enseñar, un pedido cerrado no se recoge, y un paquete que aún no
    // llegó a la agencia tampoco.
    expect(canRevealPickupKey(ctx({ paymentFacts: PREPAID, hasKey: false })).blockers).toEqual([
      "sin_clave",
    ]);
    expect(
      canRevealPickupKey(ctx({ paymentFacts: PREPAID, generalStatus: "anulado" })).blockers,
    ).toContain("pedido_cerrado");
    expect(
      canRevealPickupKey(ctx({ paymentFacts: PREPAID, pickupState: "en_transito" })).blockers,
    ).toContain("paquete_no_disponible");
  });

  it("un reembolso vuelve a bloquear la clave", () => {
    // El dinero volvió: el pedido está otra vez por cobrar, y la clave es la
    // llave del paquete.
    const v = canRevealPickupKey(
      ctx({ paymentFacts: { financialStatus: "paid", totalRefunded: 456.3 } }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("adelanto_no_registrado");
  });

  it("un pedido por cobrar sigue exigiendo sus comprobantes", () => {
    const v = canRevealPickupKey(ctx({ paymentFacts: { financialStatus: "pending" } }));
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("adelanto_no_registrado");
  });
});

describe("el panel del drawer", () => {
  const base = {
    operation: "agencia" as const,
    currentCourier: "shalom",
    shippingMode: "agency",
    macroSubstage: "sin_llamar",
    paymentState: "sin_pago",
    hasAgencyCandidate: true,
  };

  it("colapsa a constancia cuando el pedido ya se pagó", () => {
    // Antes decía «Saldo por cargar: S/ 456.30» y pedía el comprobante — o sea
    // le mentía al asesor sobre dinero que ya había entrado.
    expect(orderPaymentPanelPresentation({ ...base, paymentFacts: PREPAID })).toEqual({
      show: true,
      mode: "prepaid",
    });
  });

  it("el prepago manda sobre CUALQUIER requisito de cobro", () => {
    // Agencia, abono exigido por riesgo, diferencia pendiente… todos hablan de
    // cobrar, y acá ya está cobrado. Si alguno ganara, volvería a pedir el Yape.
    for (const over of [
      { riskRequirement: "exigir_adelanto" as const },
      { riskRequirement: "pago_completo" as const },
      { macroReasons: ["pago_requerido_pendiente"] },
      { macroSubstage: "pendiente_pago_diferencia" },
    ]) {
      const p = orderPaymentPanelPresentation({ ...base, ...over, paymentFacts: PREPAID });
      expect(p.mode, JSON.stringify(over)).toBe("prepaid");
    }
  });

  it("sin prepago, la jerarquía de siempre no cambia", () => {
    expect(orderPaymentPanelPresentation(base)).toEqual({ show: true, mode: "required" });
    expect(
      orderPaymentPanelPresentation({ ...base, paymentFacts: { financialStatus: "pending" } }),
    ).toEqual({ show: true, mode: "required" });
  });
});

describe("el rótulo no imprime «S/ 0» sobre un pedido cobrado", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("dice PAGADO, que no admite otra lectura", () => {
    // Cero es un importe, y un importe de cero a un metro se lee como un error
    // del sistema. Un rótulo ambiguo sobre dinero se resuelve cobrando — que es
    // cobrar dos veces.
    const source = read("lib/labels/rotulo-pdf.ts");
    expect(source).toContain("PAGADO - NO COBRAR");
    expect(source).toMatch(/opts\.paid \? null : formatCollectAmount/);
  });

  it("y la ruta de rótulos decide con la regla compartida", () => {
    // Con `orderFullyPaid`, no con `financial_status` a mano: si el rótulo usara
    // su propia definición, un pedido cobrado por Yape seguiría imprimiendo el
    // total — el mismo doble cobro por la otra puerta.
    const source = read("app/api/pedidos/rotulos/route.ts");
    expect(source).toContain("orderFullyPaid(");
    expect(source).toContain("payment_state");
    expect(source).toContain("financial_status");
  });
});

describe("el dato viaja hasta donde se decide", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("el recálculo escribe cómo se cobró en el Master", () => {
    // Tres consumidores lo necesitan y los tres leen `order_master`. Repetir la
    // consulta a `orders` en cada uno terminaría con tres verdades distintas, y
    // acá discrepar significa cobrar dos veces.
    const source = read("lib/order-master.ts");
    // Acotado a la FILA que se escribe, no al fichero: `financial_status` ya se
    // le pasaba a `resolveOrderState` y a `resolveMacroStage`, así que buscarlo
    // suelto pasaba en verde aunque la escritura al Master no existiera. Lo
    // descubrió una mutación que borró justo esa línea y no rompió nada.
    const i = source.indexOf("macro_since: macro.since,");
    expect(i).toBeGreaterThan(0);
    const fila = source.slice(i, source.indexOf("status_since: state.since,", i));
    expect(fila).toContain("financial_status: order.financial_status");
    expect(fila).toContain("total_refunded: order.total_refunded");
    expect(source).toContain("total_amount,total_refunded,raw");
  });

  it("el drawer lo pide en sus columnas", () => {
    const source = read("lib/orders-master-access.ts");
    const block = source.slice(source.indexOf("MASTER_DETAIL_EXTRA_COLUMNS"));
    expect(block.slice(0, 600)).toContain('"financial_status"');
    expect(block.slice(0, 600)).toContain('"total_refunded"');
  });

  it("la compuerta de la clave lo recibe", () => {
    const source = read("app/dashboard/pedidos/payment-actions.ts");
    // Las DOS llamadas: revelar la clave y el panel. Que una lo pase y la otra
    // no dejaría la pantalla diciendo que se puede y el servidor negándolo.
    expect((source.match(/paymentFacts: \{/g) ?? []).length).toBe(2);
  });
});
