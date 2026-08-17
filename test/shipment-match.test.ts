import { describe, it, expect } from "vitest";
import { matchShipment, type OrderCandidate } from "@/lib/shipment-match";
import { parseAliclikRow } from "@/lib/aliclik-import";

// Los pedidos del fixture son "#KP…", así que la tienda que importa tiene el
// prefijo KP (0115). Sin pasarlo, un número pelado de la NOTA ya no se
// convierte en pedido y estas pruebas dejarían de ejercitar el cruce.
function row(over: Record<string, string>, orderPrefix: string | null = "KP") {
  return parseAliclikRow({ "Guia Aliclik": "AUR5X1", ...over }, { orderPrefix });
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

  describe("el código impreso nombra su pedido (familia de 6 dígitos)", () => {
    // El caso real de AUR5X122767 (17-07-2026) y sus 16 hermanas: la guía se
    // importó nueve días antes de que su pedido llegara desde Shopify, así que
    // el único pedido con ese teléfono era otro anterior del mismo cliente.
    const mismoCliente: OrderCandidate[] = [
      { id: "junio", store_id: "s1", name: "#KP120351", customer_phone: "51985169380" },
    ];

    it("no enlaza al otro pedido del cliente cuando el suyo aún no existe", () => {
      const r = matchShipment(
        row({ "Guia Aliclik": "AUR5X122767", CELULAR: "985169380" }),
        mismoCliente,
      );
      expect(r.matched).toBe(false);
      expect(r.status).toBe("review");
      expect(r.order_id).toBe(null);
    });

    it("enlaza al pedido que el código nombra cuando sí está", () => {
      const r = matchShipment(row({ "Guia Aliclik": "AUR5X122767", CELULAR: "985169380" }), [
        ...mismoCliente,
        { id: "julio", store_id: "s1", name: "#KP122767", customer_phone: "51985169380" },
      ]);
      expect(r).toMatchObject({ order_id: "julio", matched: true, method: "phone" });
    });

    it("el código también le gana a un nombre de pedido que diga otra cosa", () => {
      const r = matchShipment(
        row({ "Guia Aliclik": "AUR5X122767", PEDIDO: "#KP120351", CELULAR: "985169380" }),
        mismoCliente,
      );
      expect(r.matched).toBe(false);
    });

    it("no lee un pedido en las familias de 7 y 12 dígitos", () => {
      // Medido en producción: ninguna de esas 2.853 guías nombra a su pedido.
      // Si se leyeran como referencia, se vetarían enlaces buenos en masa.
      for (const code of ["AUR5X5086616", "AUR5X000340013716"]) {
        const r = matchShipment(row({ "Guia Aliclik": code, CELULAR: "914699634" }), orders);
        expect(r).toMatchObject({ order_id: "o1", matched: true, method: "phone" });
      }
    });
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

    it("sin prefijo de tienda el número pelado no cuenta, y manda el teléfono", () => {
      // 0115: una tienda sin `order_prefix` no adivina pedidos desde un número
      // suelto. El cruce por nombre desaparece y queda el teléfono solo — que
      // acá resuelve, pero por "phone", no por "order_name_phone".
      const r = matchShipment(row({ NOTA: "114985 - referencia", CELULAR: "914699634" }, null), orders);
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

    it("disambiguates an ambiguous confirmed name using the phone", () => {
      // two orders share the same order name (rare, but possible across stores)
      // — the row's phone matches exactly one of them, so it resolves instead
      // of forcing a manual review.
      const dup: OrderCandidate[] = [
        { id: "o1", store_id: "s1", name: "#KP114985", customer_phone: "51914699634" },
        { id: "o1b", store_id: "s1", name: "#KP114985", customer_phone: "51900000000" },
      ];
      const r = matchShipment(row({ PEDIDO: "#KP114985", CELULAR: "914699634" }), dup);
      expect(r).toMatchObject({ order_id: "o1", matched: true, method: "order_name_phone" });
    });

    it("still sends a genuinely ambiguous confirmed name to review (no phone to disambiguate)", () => {
      const dup: OrderCandidate[] = [
        { id: "o1", store_id: "s1", name: "#KP114985", customer_phone: "51914699634" },
        { id: "o1b", store_id: "s1", name: "#KP114985", customer_phone: "51900000000" },
      ];
      const r = matchShipment(row({ PEDIDO: "#KP114985" }), dup); // no phone on the row
      expect(r.matched).toBe(false);
      expect(r.status).toBe("review");
    });
  });

  describe("'#AUR######' (Aurela's real order.name) — same confidence as KP", () => {
    const aurOrders: OrderCandidate[] = [
      { id: "a1", store_id: "s1", name: "#AUR173123", customer_phone: "51987654321" },
    ];

    it("matches uniquely regardless of phone", () => {
      const r = matchShipment(row({ PEDIDO: "#AUR173123", CELULAR: "000000000" }), aurOrders);
      expect(r).toMatchObject({ order_id: "a1", matched: true, method: "order_name" });
    });

    it("extracts it from NOTA too", () => {
      const r = matchShipment(
        row({ NOTA: "#AUR173123 - /cliente confirma pedido", CELULAR: "987654321" }),
        aurOrders,
      );
      expect(r).toMatchObject({ order_id: "a1", matched: true, method: "order_name" });
    });
  });
});
