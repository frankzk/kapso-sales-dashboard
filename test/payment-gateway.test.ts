import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_GATEWAY_LABEL,
  classifyPaymentGateway,
  gatewayNamesOf,
  paymentGatewayOf,
} from "@/lib/payment-gateway";
import { isWebPrepaid, orderFullyPaid } from "@/lib/order-paid";

/**
 * Solo la pasarela del checkout nace pagada.
 *
 * EL CASO. #KP132708 (Agencia, S/ 268,20) nació pagado: EasySell mandó al
 * checkout con el descuento PREPAID y Shopify cobró ahí. Alguien subió la
 * captura del pedido como comprobante de S/ 447, y la regla indirecta —«pagado
 * en Shopify y sin comprobantes» = pagado por web— se apagó: el pedido quedó en
 * confirmación pidiendo un adelanto ya cobrado.
 *
 * LA REGLA (10-09-2026). El checkout se salta las constancias, haya o no
 * comprobantes. «Manual» y COD siguen el conducto regular. Sin el dato, manda
 * la regla de antes: no se adivina.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const CHECKOUT = "Checkout Flow | Tarjeta, Transf., Cuotas débito";

describe("clasificar la pasarela", () => {
  it("la del checkout cobró", () => {
    expect(classifyPaymentGateway([CHECKOUT])).toBe("checkout");
    // Si mañana entra Mercado Pago o Culqi, también: lo que se enumera es lo
    // que NO cobra, que son dos nombres y no cambian.
    expect(classifyPaymentGateway(["mercado_pago"])).toBe("checkout");
    expect(classifyPaymentGateway(["Cash on Delivery (COD)", CHECKOUT])).toBe("checkout");
  });

  it("«manual» es alguien marcándolo a mano, aunque venga junto a COD", () => {
    expect(classifyPaymentGateway(["manual"])).toBe("manual");
    expect(classifyPaymentGateway(["Cash on Delivery (COD)", "manual"])).toBe("manual");
    expect(classifyPaymentGateway([" MANUAL "])).toBe("manual");
  });

  it("solo contraentrega es cod", () => {
    expect(classifyPaymentGateway(["Cash on Delivery (COD)"])).toBe("cod");
  });

  it("sin dato no se adivina: null", () => {
    expect(classifyPaymentGateway(null)).toBeNull();
    expect(classifyPaymentGateway(undefined)).toBeNull();
    expect(classifyPaymentGateway([])).toBeNull();
    expect(classifyPaymentGateway(["", "  "])).toBeNull();
  });

  it("lee el nombre GraphQL y el del webhook REST, y nada más", () => {
    expect(gatewayNamesOf({ paymentGatewayNames: [CHECKOUT] })).toEqual([CHECKOUT]);
    expect(gatewayNamesOf({ payment_gateway_names: ["manual"] })).toEqual(["manual"]);
    expect(gatewayNamesOf({ displayFinancialStatus: "PAID" })).toBeNull();
    expect(gatewayNamesOf(null)).toBeNull();
    expect(paymentGatewayOf({ payment_gateway_names: ["Cash on Delivery (COD)", "manual"] })).toBe("manual");
  });

  it("tiene texto para el panel", () => {
    expect(PAYMENT_GATEWAY_LABEL.checkout).toContain("checkout");
    expect(PAYMENT_GATEWAY_LABEL.manual).toContain("a mano");
  });
});

describe("la regla de cobro cuando se sabe la pasarela", () => {
  const PAGADO = { financialStatus: "paid", totalRefunded: 0 };

  it("checkout: pagado, aunque haya comprobantes cargados (#KP132708)", () => {
    expect(isWebPrepaid({ ...PAGADO, paymentGateway: "checkout", paymentState: "adelanto_cargado" })).toBe(true);
    expect(orderFullyPaid({ ...PAGADO, paymentGateway: "checkout", paymentState: "adelanto_cargado" })).toBe(true);
  });

  it("manual o cod: NO es pago por web, ni siquiera sin comprobantes", () => {
    expect(isWebPrepaid({ ...PAGADO, paymentGateway: "manual" })).toBe(false);
    expect(isWebPrepaid({ ...PAGADO, paymentGateway: "cod", paymentState: "sin_pago" })).toBe(false);
    // Con la constancia validada y completa, sí: por la vía de Yape.
    expect(orderFullyPaid({ ...PAGADO, paymentGateway: "manual", paymentState: "pago_completo" })).toBe(true);
  });

  it("checkout con reembolso vuelve a estar por cobrar", () => {
    expect(isWebPrepaid({ financialStatus: "paid", totalRefunded: 10, paymentGateway: "checkout" })).toBe(false);
  });

  it("checkout sin `paid` no cuenta: la pasarela pudo autorizar y no capturar", () => {
    expect(isWebPrepaid({ financialStatus: "pending", paymentGateway: "checkout" })).toBe(false);
  });

  it("sin pasarela conocida, la regla indirecta de siempre sigue igual", () => {
    expect(isWebPrepaid({ ...PAGADO })).toBe(true);
    expect(isWebPrepaid({ ...PAGADO, paymentGateway: null })).toBe(true);
    expect(isWebPrepaid({ ...PAGADO, paymentState: "adelanto_cargado" })).toBe(false);
  });
});

describe("el dato viaja de Shopify al Master y a quien decide", () => {
  it("la sincronización le pide la pasarela a Shopify, en las dos consultas", () => {
    const src = read("lib/shopify.ts");
    expect((src.match(/paymentGatewayNames\n/g) ?? []).length).toBe(2);
    expect((src.match(/payment_gateway: paymentGatewayOf\((node|payload)\),/g) ?? []).length).toBe(2);
  });

  it("el Master lo lee, lo copia y decide con él", () => {
    const src = read("lib/order-master.ts");
    expect(src).toContain("financial_status,payment_gateway,shipping_mode");
    expect(src).toContain("const paymentGateway = order.payment_gateway ?? paymentGatewayOf(order.raw);");
    expect(src).toContain("payment_gateway: paymentGateway,");
  });

  it("todos los que arman los hechos de pago pasan la pasarela", () => {
    for (const f of [
      "app/dashboard/pedidos/payment-actions.ts",
      "app/dashboard/pedidos/aliclik-actions.ts",
      "components/orders-master.tsx",
      "lib/collect-alert.ts",
      "app/api/pedidos/rotulos/route.ts",
    ]) {
      const src = read(f);
      expect(src, f).toMatch(/paymentGateway: /);
    }
    expect(read("lib/orders-master-access.ts")).toContain('"payment_gateway",');
  });

  it("la migración existe y no rellena a la fuerza", () => {
    const sql = read("db/migrations/0152_payment_gateway.sql");
    expect(sql).toContain("alter table orders\n  add column if not exists payment_gateway text;");
    expect(sql).toContain("alter table order_master\n  add column if not exists payment_gateway text;");
    expect(sql).not.toMatch(/^update /m);
  });

  it("y el MOM lo dice", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**Solo la pasarela del checkout nace pagada**");
  });
});
