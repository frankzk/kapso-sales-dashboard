// La antigüedad del pedido en el cajón de Envíos (owner, 20-11-2026).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { orderAgeDays, orderAgeText } from "@/lib/order-age";

describe("orderAgeDays", () => {
  const now = new Date("2026-11-20T17:00:00Z"); // 12:00 Lima
  it("cuenta días de Lima, no de UTC", () => {
    expect(orderAgeDays("2026-11-20T06:00:00Z", now)).toBe(0); // 01:00 Lima del 20
    expect(orderAgeDays("2026-11-20T04:00:00Z", now)).toBe(1); // 23:00 Lima del 19
    expect(orderAgeDays("2026-11-13T15:12:00Z", now)).toBe(7);
  });
  it("sin fecha, nada", () => {
    expect(orderAgeDays(null, now)).toBeNull();
    expect(orderAgeDays("no-es-fecha", now)).toBeNull();
  });
  it("hoy, ayer, hace N días", () => {
    expect([0, 1, 7].map(orderAgeText)).toEqual(["hoy", "ayer", "hace 7 días"]);
  });
  it("el cajón de Envíos lo muestra sobre los productos", () => {
    const ui = readFileSync("components/shipments.tsx", "utf8");
    expect(ui).toContain("<OrderCreatedLine createdAt={detail.order.created_at} />");
    expect(readFileSync("lib/shipments-access.ts", "utf8")).toContain('"name,shopify_order_id,line_items,raw,platform,created_at"');
  });
});

describe("Envíos exige el vínculo a Swayp (owner, 20-11-2026)", () => {
  it("un producto sin vínculo cuenta como «sin stock»", () => {
    const access = readFileSync("lib/shipments-access.ts", "utf8");
    expect(access).toContain('sb.from("swayp_sku_map")');
    expect(access).toContain("productosSinVinculo(products, linkByOrg.get(orgId)).length > 0");
    expect(access).toContain('fenix_reason: unlinked ? "sin_stock" : current.reason');
  });
});
