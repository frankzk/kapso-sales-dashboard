import { describe, it, expect } from "vitest";
import { matchShipment, type OrderCandidate } from "@/lib/shipment-match";
import { parseAliclikRow } from "@/lib/aliclik-import";

function row(over: Record<string, string>) {
  return parseAliclikRow({ "Guia Aliclik": "AUR5X1", ...over });
}

const orders: OrderCandidate[] = [
  { id: "o1", store_id: "s1", name: "#KP114985", customer_phone: "51914699634" },
  { id: "o2", store_id: "s1", name: "#KP200000", customer_phone: "51999000111" },
  { id: "o3", store_id: "s2", name: "#KP300000", customer_phone: "51999000111" }, // dup phone
];

describe("matchShipment", () => {
  it("matches by order name and resolves the store", () => {
    const r = matchShipment(row({ PEDIDO: "#KP114985" }), orders);
    expect(r).toMatchObject({ order_id: "o1", store_id: "s1", matched: true, method: "order_name" });
  });

  it("falls back to phone when name is absent", () => {
    const r = matchShipment(row({ CELULAR: "914699634" }), orders);
    expect(r).toMatchObject({ order_id: "o1", matched: true, method: "phone" });
  });

  it("sends ambiguous phone matches to review", () => {
    const r = matchShipment(row({ CELULAR: "999000111" }), orders);
    expect(r.matched).toBe(false);
    expect(r.status).toBe("review");
  });

  it("sends unmatched rows (Kenku/no order) to review", () => {
    const r = matchShipment(row({ PEDIDO: "#KEN999", CELULAR: "988777666" }), orders);
    expect(r.matched).toBe(false);
    expect(r.status).toBe("review");
    expect(r.order_id).toBe(null);
  });

  it("only matches within the provided (accessible) candidates", () => {
    const r = matchShipment(row({ PEDIDO: "#KP114985" }), []);
    expect(r.matched).toBe(false);
  });
});
