import { describe, expect, it } from "vitest";
import type { AliclikOrder } from "@/lib/aliclik";
import {
  isCompatibleManualPortalGuide,
  selectExistingAliclikOrder,
} from "@/lib/aliclik-existing-guide";

const order = (overrides: Partial<AliclikOrder>): AliclikOrder => ({
  orderNumber: "ALC0001",
  ...overrides,
});

describe("isCompatibleManualPortalGuide", () => {
  it("acepta la guía de portal cuyo sufijo identifica al pedido Shopify", () => {
    expect(isCompatibleManualPortalGuide("AUR5X174797", "#AUR174797")).toBe(true);
  });

  it("rechaza códigos ALC porque deben validarse por la API", () => {
    expect(isCompatibleManualPortalGuide("ALC00000174797", "#AUR174797")).toBe(false);
  });

  it("rechaza una guía de portal que pertenece a otro pedido", () => {
    expect(isCompatibleManualPortalGuide("AUR5X174798", "#AUR174797")).toBe(false);
  });
});

describe("selectExistingAliclikOrder", () => {
  it("resuelve el ALC subyacente por pedido Shopify y corroboración", () => {
    const result = selectExistingAliclikOrder(
      [
        order({
          orderNumber: "ALC-OTRO",
          note: "otro pedido",
          total: 198,
          customer: { phone: "51914523073" },
        }),
        order({
          orderNumber: "ALC-CORRECTO",
          note: "Pedido Aurela #AUR174797",
          total: 198,
          customer: { phone: "51914523073" },
          shipping: {
            departmentName: "Piura",
            provinceName: "Piura",
            districtName: "Piura",
          },
        }),
      ],
      {
        orderName: "#AUR174797",
        customerPhone: "51914523073",
        orderTotal: 198,
        region: "Piura",
        province: "Piura",
        district: "Piura",
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.order.orderNumber).toBe("ALC-CORRECTO");
  });

  it("no acepta teléfono y monto sin referencia Shopify", () => {
    const result = selectExistingAliclikOrder(
      [order({ note: "sin referencia", total: 198, customer: { phone: "51914523073" } })],
      { orderName: "#AUR174797", customerPhone: "51914523073", orderTotal: 198 },
    );
    expect(result.ok).toBe(false);
  });

  it("bloquea coincidencias fuertes ambiguas", () => {
    const target = {
      orderName: "#AUR174797",
      customerPhone: "51914523073",
      orderTotal: 198,
    };
    const result = selectExistingAliclikOrder(
      [
        order({
          orderNumber: "ALC-1",
          note: "AUR174797",
          total: 198,
          customer: { phone: "51914523073" },
        }),
        order({
          orderNumber: "ALC-2",
          note: "AUR174797 reprogramado",
          total: 198,
          customer: { phone: "51914523073" },
        }),
      ],
      target,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ambiguous");
  });

  it("reconoce el código impreso en un campo no documentado", () => {
    const remote = {
      ...order({
        orderNumber: "ALC-TECNICO-174797",
        total: 198,
        customer: { phone: "51914523073" },
        shipping: {
          departmentName: "Piura",
          provinceName: "Piura",
          districtName: "Piura",
        },
      }),
      externalGuideCode: "AUR5X174797",
    } as AliclikOrder;
    const result = selectExistingAliclikOrder([remote], {
      guideCode: "AUR5X174797",
      orderName: "#AUR174797",
      customerPhone: "51914523073",
      orderTotal: 198,
      region: "Piura",
      province: "Piura",
      district: "Piura",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.match.order.orderNumber).toBe("ALC-TECNICO-174797");
      expect(result.match.reasons).toContain("código de guía");
    }
  });

  it("reconoce la referencia Shopify en un campo no documentado", () => {
    const remote = {
      ...order({
        orderNumber: "ALC-TECNICO",
        total: 198,
        customer: { phone: "51914523073" },
      }),
      ecommerceReference: "AUR174797",
    } as AliclikOrder;
    const result = selectExistingAliclikOrder([remote], {
      guideCode: "AUR5X174797",
      orderName: "#AUR174797",
      customerPhone: "51914523073",
      orderTotal: 198,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.reasons).toContain("pedido Shopify");
  });
});
