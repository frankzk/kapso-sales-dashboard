import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_GATEWAYS,
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
 * LA REGLA (10-09-2026). Solo la pasarela CONFIRMADA del checkout, guardada,
 * se salta las constancias, haya o no comprobantes. «Manual», COD, una
 * pasarela sin confirmar o ningún dato: conducto regular. Nada se deduce.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const CHECKOUT = "Checkout Flow | Tarjeta, Transf., Cuotas débito";

describe("clasificar la pasarela", () => {
  it("la del checkout cobró: solo la CONFIRMADA, con nombre y apellido", () => {
    expect(classifyPaymentGateway([CHECKOUT])).toBe("checkout");
    expect(classifyPaymentGateway([CHECKOUT.toUpperCase()])).toBe("checkout");
    expect(classifyPaymentGateway(["Cash on Delivery (COD)", CHECKOUT])).toBe("checkout");
    expect(CHECKOUT_GATEWAYS).toEqual([CHECKOUT]);
  });

  it("una pasarela que nadie confirmó todavía NO se salta nada: desconocida", () => {
    // Si mañana entra Mercado Pago o Culqi, alguien la confirma y la añade a
    // CHECKOUT_GATEWAYS. Hasta entonces, conducto regular.
    expect(classifyPaymentGateway(["mercado_pago"])).toBeNull();
    expect(classifyPaymentGateway(["manual", "mercado_pago"])).toBeNull();
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

  it("sin pasarela guardada NO es pagado por web: nada de deducir", () => {
    // Antes «paid sin comprobantes» se daba por pagado por la pasarela. La
    // operación lo cortó: solo la pasarela confirmada y guardada.
    expect(isWebPrepaid({ ...PAGADO })).toBe(false);
    expect(isWebPrepaid({ ...PAGADO, paymentGateway: null })).toBe(false);
    expect(isWebPrepaid({ ...PAGADO, paymentState: "sin_pago" })).toBe(false);
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
    const sql = read("db/migrations/0153_payment_gateway.sql");
    expect(sql).toContain("alter table orders\n  add column if not exists payment_gateway text;");
    expect(sql).toContain("alter table order_master\n  add column if not exists payment_gateway text;");
    expect(sql).not.toMatch(/^update /m);
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**Solo la pasarela confirmada del checkout nace pagada**");
    expect(mom).toContain("**Nada se deduce.**");
  });
});

describe("los pedidos pagados que siguen vivos van a buscar su pasarela", () => {
  // Con la regla estricta, un pedido sincronizado antes de pedir el dato deja
  // de contar como pagado — también si lo cobró el checkout. En Lima saldría
  // con el total a cobrar: dos veces. Se les pregunta a Shopify por tandas.
  it("desde el cron de sync, por tandas y solo los vivos sin dato", () => {
    const src = read("lib/payment-gateway-backfill.ts");
    expect(src).toContain('.eq("financial_status", "paid")');
    expect(src).toContain('.in("macro_stage", ETAPAS_VIVAS)');
    expect(src).toContain('.is("payment_gateway", null)');
    expect(src).toContain('.is("raw->paymentGatewayNames", null)');
    expect(src).toContain("await upsertOrders(admin, [fresh]);");
    expect(src).toContain("await recomputeOrderMasterSafe(admin, updated);");
    expect(read("app/api/cron/sync/route.ts")).toContain("await backfillPaymentGateways(id, admin);");
  });

  it("y el Master reconcilia el histórico con el cambio de versión", () => {
    expect(read("lib/order-macro-stage.ts")).toContain('MOM_RESOLUTION_VERSION = "mom-v1.11"');
  });
});
