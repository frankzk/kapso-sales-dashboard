import { describe, expect, it } from "vitest";
import {
  shopifyDraftOrderAdminUrl,
  shopifyOrderAdminUrl,
} from "@/lib/shopify-urls";

describe("Shopify Admin URLs", () => {
  it("construye el enlace exacto de un pedido con dominio myshopify", () => {
    expect(
      shopifyOrderAdminUrl("aurela-peru.myshopify.com", "7323712454876"),
    ).toBe("https://admin.shopify.com/store/aurela-peru/orders/7323712454876");
  });

  it("acepta un GID y un dominio con protocolo", () => {
    expect(
      shopifyOrderAdminUrl(
        "https://kenkuperu.myshopify.com/admin",
        "gid://shopify/Order/987654321",
      ),
    ).toBe("https://admin.shopify.com/store/kenkuperu/orders/987654321");
  });

  it("no crea enlaces para pedidos sintéticos o dominios inválidos", () => {
    expect(shopifyOrderAdminUrl("aurela-peru.myshopify.com", "manual-123")).toBeNull();
    expect(shopifyOrderAdminUrl("dominio no válido", "123")).toBeNull();
  });

  it("mantiene el enlace de borradores", () => {
    expect(
      shopifyDraftOrderAdminUrl("aurela-peru.myshopify.com", 123),
    ).toBe("https://admin.shopify.com/store/aurela-peru/draft_orders/123");
  });
});
