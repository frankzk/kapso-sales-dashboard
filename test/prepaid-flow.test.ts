import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canRevealPickupKey, paymentState } from "@/lib/pickup-key";
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

describe("la guarda: con comprobantes mandan las reglas de Yape", () => {
  // POR QUÉ. En la operación real casi todo pedido cobrado por Yape acaba
  // también marcado `paid` en Shopify. Sin esta condición, un pedido con el
  // adelanto cargado y la diferencia pendiente contaría como «pagado por web» y
  // abriría la compuerta de la clave — la pérdida de dinero que esa compuerta
  // existe para evitar. `paid` SIN comprobantes es lo único que solo puede venir
  // de la pasarela.
  const conComprobante = [
    { kind: "adelanto", validation_status: "validado", order_id: "o1", amount: 30 },
  ];

  it("un pedido con adelanto y diferencia pendiente NO pasa por prepago", () => {
    const v = canRevealPickupKey(ctx({ payments: conComprobante, paymentFacts: PREPAID }));
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("diferencia_no_registrada");
  });

  it("y el panel tampoco lo da por cobrado por web", () => {
    expect(
      orderPaymentPanelPresentation({
        operation: "agencia",
        currentCourier: "shalom",
        shippingMode: "agency",
        macroSubstage: "pendiente_pago_diferencia",
        paymentState: "adelanto_validado",
        hasAgencyCandidate: true,
        paymentFacts: { ...PREPAID, paymentState: "adelanto_validado" },
      }).mode,
    ).toBe("required");
  });

  it("sin comprobantes sí es prepago: es lo único que solo puede venir de la pasarela", () => {
    expect(canRevealPickupKey(ctx({ payments: [], paymentFacts: PREPAID })).allowed).toBe(true);
  });

  it("un comprobante RECHAZADO no cuenta como comprobante vivo", () => {
    // Un Yape rechazado no es dinero: si además el pedido está pagado por web,
    // bloquear por esa fila sería negarle la clave a quien sí pagó.
    const rechazado = [
      { kind: "adelanto", validation_status: "rechazado", order_id: "o1", amount: 30 },
    ];
    expect(canRevealPickupKey(ctx({ payments: rechazado, paymentFacts: PREPAID })).allowed).toBe(true);
  });
});

describe("la clave se libera cuando el monto cubre el total, sin importar la forma", () => {
  // #KP128018: adelanto de S/ 200.00 validado sobre un pedido de S/ 198.00. El
  // panel decía «S/ 200.00 validados de S/ 198.00 · Saldo por cargar: S/ 0.00»
  // con la barra llena, y arriba «Completar el pago antes de liberar la clave».
  // La compuerta miraba si EXISTÍA una fila `diferencia`, no si alcanzaba la
  // plata. El cliente pagó todo de una y la asesora lo registró como «Adelanto»,
  // que es lo natural cuando es el primer pago.
  const pago = (over: Record<string, unknown> = {}) => ({
    kind: "adelanto",
    validation_status: "validado",
    order_id: "o1",
    amount: 200,
    ...over,
  });

  it("un adelanto que cubre el total libera la clave", () => {
    const v = canRevealPickupKey(ctx({ payments: [pago()], orderTotal: 198 }));
    expect(v.allowed).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it("y el estado deja de anunciar una diferencia que no existe", () => {
    // De este estado cuelgan la subetapa `pendiente_pago_diferencia` y el monto
    // que se le manda al courier: no es solo la etiqueta del panel.
    expect(paymentState([pago()], 198)).toBe("pago_completo");
  });

  it("el listón NO baja: a medio pagar sigue bloqueado", () => {
    const v = canRevealPickupKey(ctx({ payments: [pago({ amount: 100 })], orderTotal: 198 }));
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("diferencia_no_registrada");
    expect(paymentState([pago({ amount: 100 })], 198)).toBe("adelanto_validado");
  });

  it("justo el total alcanza; un céntimo menos no", () => {
    expect(canRevealPickupKey(ctx({ payments: [pago({ amount: 198 })], orderTotal: 198 })).allowed).toBe(true);
    expect(canRevealPickupKey(ctx({ payments: [pago({ amount: 197.99 })], orderTotal: 198 })).allowed).toBe(false);
  });

  it("varios comprobantes suman, aunque ninguno cubra por sí solo", () => {
    const v = canRevealPickupKey(
      ctx({
        payments: [pago({ amount: 100 }), pago({ kind: "diferencia", amount: 98 })],
        orderTotal: 198,
      }),
    );
    expect(v.allowed).toBe(true);
  });

  it("un comprobante RECHAZADO no suma: no es dinero", () => {
    const v = canRevealPickupKey(
      ctx({
        payments: [pago({ amount: 100 }), pago({ amount: 98, validation_status: "rechazado" })],
        orderTotal: 198,
      }),
    );
    expect(v.allowed).toBe(false);
  });

  it("un posible duplicado sigue bloqueando aunque cubra", () => {
    // Un duplicado no es dinero nuevo: contarlo sería exactamente lo que la
    // deduplicación persigue.
    const v = canRevealPickupKey(
      ctx({ payments: [pago({ validation_status: "posible_duplicado" })], orderTotal: 198 }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockers).toContain("pago_observado");
  });

  it("sin total del pedido no se puede afirmar que cubra", () => {
    const v = canRevealPickupKey(ctx({ payments: [pago()], orderTotal: null }));
    expect(v.allowed).toBe(false);
  });

  it("un monto sin informar no cubre nada", () => {
    const v = canRevealPickupKey(ctx({ payments: [pago({ amount: null })], orderTotal: 198 }));
    expect(v.allowed).toBe(false);
  });

  it("un comprobante sin monto suma cero: no infla ni invalida", () => {
    // `inCents` mapea el nulo a cero, así que una fila sin monto solo puede
    // dejar la cuenta corta — nunca darla por cubierta. Es el lado correcto del
    // error, y por eso no hace falta descartarla aparte.
    const cubre = canRevealPickupKey(
      ctx({ payments: [pago({ amount: 200 }), pago({ kind: "diferencia", amount: null })], orderTotal: 198 }),
    );
    expect(cubre.allowed).toBe(true);

    const noCubre = canRevealPickupKey(
      ctx({ payments: [pago({ amount: 100 }), pago({ kind: "diferencia", amount: null })], orderTotal: 198 }),
    );
    expect(noCubre.allowed).toBe(false);
    expect(noCubre.blockers).toContain("monto_insuficiente");
  });
});

describe("el recálculo y el drawer deciden lo MISMO", () => {
  // #KP126188 lo destapó: `financial_status = 'paid'` ya escrito en el Master,
  // cero comprobantes, y aun así `key_state = 'clave_bloqueada'` y
  // `macro_substage = 'pendiente_pago_diferencia'`. El drawer sí lo dejaba
  // pasar. Dos cálculos de la misma pregunta con entradas distintas: el del
  // recálculo no recibía los datos de pago.
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const source = () => read("lib/order-master.ts");

  it("el recálculo le pasa los datos de pago a la compuerta de la clave", () => {
    const s = source();
    const i = s.indexOf("keyState({");
    expect(i).toBeGreaterThan(0);
    const call = s.slice(i, s.indexOf("})", i));
    expect(call).toContain("paymentFacts");
  });

  it("y el prepago web cuenta como estado de cobro", () => {
    // De `payment_state` cuelgan la macroetapa y el monto que va al courier. Sin
    // esto, un pedido cobrado en el checkout quedaba `sin_pago` y la macroetapa
    // lo dejaba en «pendiente de pago de diferencia» para siempre.
    const s = source();
    expect(s).toMatch(/isWebPrepaid\(paymentFacts\) \? "pago_completo" : voucherState/);
  });

  it("la traducción NO vive dentro de `paymentState`", () => {
    // Esa función es pura sobre comprobantes y la usan sitios que no conocen a
    // Shopify. Meterle `financial_status` la ataría a una fuente que no es suya.
    const s = read("lib/pickup-key.ts");
    const i = s.indexOf("export function paymentState(");
    const body = s.slice(i, s.indexOf("\n}", i));
    expect(body).not.toContain("financial");
    expect(body).not.toContain("isWebPrepaid");
  });
});
