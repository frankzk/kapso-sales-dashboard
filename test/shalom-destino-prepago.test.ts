import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { offersShalomDestination } from "@/lib/order-payment-panel";

/**
 * «DNI y agencia Shalom» en un pedido PAGADO POR WEB (MOM §Pagos, 26-10-2026).
 *
 * #KP200104, WooCommerce, pagado en el checkout: la tarjeta de Cobro decía
 * «No hay que cobrar…» y nada más. El bloque del DNI y la agencia era el paso 1
 * de «Registrar un pago» y desaparecía con él, así que la única forma de
 * escribirlos era «Abrir Shalom», que los pide y crea la guía en el mismo acto.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("dónde se ofrece el bloque en un pedido pagado", () => {
  const base = {
    operation: "lima" as const,
    currentCourier: null,
    shippingMode: null,
    shalomCandidate: false,
  };

  it("Provincia COD con Shalom en el plan de rutas (#KP200104)", () => {
    expect(
      offersShalomDestination({ ...base, operation: "provincia_cod", shalomCandidate: true }),
    ).toBe(true);
  });

  it("Agencia, o una salida que ya es Shalom o agencia", () => {
    expect(offersShalomDestination({ ...base, operation: "agencia" })).toBe(true);
    expect(offersShalomDestination({ ...base, currentCourier: "shalom" })).toBe(true);
    expect(offersShalomDestination({ ...base, shippingMode: "agency" })).toBe(true);
  });

  it("en Lima sin Shalom posible sería ruido", () => {
    expect(offersShalomDestination(base)).toBe(false);
    expect(offersShalomDestination({ ...base, operation: "provincia_cod" })).toBe(false);
  });
});

describe("el bloque del pedido pagado es el mismo que el del cobro", () => {
  const panel = read("components/pickup-key-panel.tsx");
  const prepaid = panel.slice(
    panel.indexOf('if (mode === "prepaid") {'),
    panel.indexOf("const paymentLabel ="),
  );

  it("la rama «Pagado por web» dibuja «DNI y agencia Shalom»", () => {
    expect(prepaid).toContain("<ShalomDestinationZone");
    // Con la puerta del servidor (`saveShalomOrderDraft` pide `master.edit`), no
    // con la de registrar pagos: aquí no se registra ningún pago.
    expect(prepaid).toContain("panel.canEditShalomDraft");
    expect(read("app/dashboard/pedidos/payment-actions.ts")).toContain(
      'canEditShalomDraft: perms.can("master.edit")',
    );
  });

  it("y guarda en el mismo borrador, sin crear guía ni rótulo", () => {
    // Un solo hook para los dos sitios: el paso 1 de «Registrar un pago» y el
    // bloque del pedido pagado. Dos copias del validador acabarían distintas.
    const hook = panel.slice(
      panel.indexOf("function useShalomDestinationDraft("),
      panel.indexOf("type ShalomDestinationDraft"),
    );
    expect(hook).toContain("saveShalomOrderDraft(orderId");
    expect(hook).toContain("documentError(shalomDocType, shalomDoc)");
    expect(hook).not.toMatch(/createShalomGuide|registerPayment/);
    const voucherForm = panel.slice(panel.indexOf("function VoucherForm("));
    expect(voucherForm).toContain("useShalomDestinationDraft(orderId, storeId)");
    expect(voucherForm).toContain("<ShalomDestinationFields");
  });

  it("el drawer le dice al panel cuándo Shalom puede ser el destino", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("offersShalomDestination({");
    expect(drawer).toContain("shalomDestination={shalomDestination}");
  });

  it("«Abrir Shalom» trae puesto lo guardado", () => {
    const actions = read("app/dashboard/pedidos/shalom-actions.ts");
    expect(actions).toContain('.from("shalom_order_drafts")');
    expect(actions).toContain("prefilledDocument: prefilled?.document ?? null");
    expect(actions).toContain("prefilledTerminalId: prefilled?.destiny_terminal_id ?? null");
  });
});
