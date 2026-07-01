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

  describe("unconfirmed order_name (bare-number NOTA guess)", () => {
    it("trusts the candidate once its phone cross-validates", () => {
      const r = matchShipment(row({ NOTA: "114985 - referencia", CELULAR: "914699634" }), orders);
      expect(r).toMatchObject({ order_id: "o1", matched: true, method: "order_name_phone" });
    });

    it("disambiguates a duplicate phone using the candidate order number", () => {
      // o2 and o3 share the same phone; plain phone-only matching would go to
      // review, but the NOTA guess narrows it down to the one it names.
      const r = matchShipment(row({ NOTA: "300000 - dejar con el guardián", CELULAR: "999000111" }), orders);
      expect(r).toMatchObject({ order_id: "o3", store_id: "s2", matched: true, method: "order_name_phone" });
    });

    it("does not force a match when the guessed number's phone doesn't line up", () => {
      // "114314" isn't a real order in this candidate set — a coincidental
      // bare-number match must not be trusted; falls through to phone-only.
      const r = matchShipment(row({ NOTA: "114314 - referencia", CELULAR: "914699634" }), orders);
      expect(r).toMatchObject({ order_id: "o1", matched: true, method: "phone" });
    });

    it("goes to review when neither the candidate nor the phone resolve", () => {
      const r = matchShipment(row({ NOTA: "999999 - referencia", CELULAR: "988777666" }), orders);
      expect(r.matched).toBe(false);
      expect(r.status).toBe("review");
    });
  });

  describe("confirmed order_name (literal KP token) — regression", () => {
    it("still matches uniquely regardless of phone", () => {
      const r = matchShipment(row({ PEDIDO: "#KP114985", CELULAR: "000000000" }), orders);
      expect(r).toMatchObject({ order_id: "o1", matched: true, method: "order_name" });
    });

    it("still sends an ambiguous confirmed name straight to review", () => {
      const dup: OrderCandidate[] = [
        { id: "o1", store_id: "s1", name: "#KP114985", customer_phone: "51914699634" },
        { id: "o1b", store_id: "s1", name: "#KP114985", customer_phone: "51900000000" },
      ];
      const r = matchShipment(row({ PEDIDO: "#KP114985", CELULAR: "914699634" }), dup);
      expect(r.matched).toBe(false);
      expect(r.status).toBe("review");
    });
  });
});
