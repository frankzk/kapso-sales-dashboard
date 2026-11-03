import { describe, expect, it } from "vitest";
import {
  cartPhoneVariants,
  cartProductsLabel,
  cartsTone,
  cartsVerdict,
  mergeCustomerCarts,
  summarizeCarts,
  type ArchiveCartRow,
  type MirrorDraftRow,
} from "@/lib/customer-carts";

/**
 * Los carritos anteriores de una clienta (25-10-2026, MOM §11). El caso: Rafael
 * Peralta Salas (Kenku, 958 769 605) entró con el carrito #D105674 y en el
 * archivo de Shopify tenía tres borradores abandonados de antes.
 */

const archive = (over: Partial<ArchiveCartRow>): ArchiveCartRow => ({
  cart_key: "borrador:1",
  kind: "borrador",
  name: "#D1",
  status: "open",
  created_at: "2026-01-01T00:00:00Z",
  total: 149,
  order_name: null,
  line_items: [],
  ...over,
});

const mirror = (over: Partial<MirrorDraftRow>): MirrorDraftRow => ({
  shopify_draft_order_id: "1",
  draft_order_gid: "gid://shopify/DraftOrder/1",
  name: "#D1",
  status: "open",
  created_at: "2026-01-01T00:00:00Z",
  total_amount: "149.00",
  line_items: [],
  ...over,
});

describe("el celular en sus formas", () => {
  it("el espejo lo guarda normalizado; el archivo, como venía", () => {
    expect(cartPhoneVariants("+51 958 769 605")).toEqual(["51958769605", "958769605", "051958769605", "0051958769605"]);
    expect(cartPhoneVariants("958769605")).toContain("51958769605");
    expect(cartPhoneVariants(null)).toEqual([]);
    expect(cartPhoneVariants("123")).toEqual([]);
  });
});

describe("mergeCustomerCarts", () => {
  it("el caso de Rafael: tres abandonados en el archivo, y sin el carrito del propio lead", () => {
    const carts = mergeCustomerCarts(
      [mirror({ shopify_draft_order_id: "1355892687143", draft_order_gid: "gid://shopify/DraftOrder/1355892687143", name: "#D105674", created_at: "2026-10-25T21:48:00Z" })],
      [
        archive({ cart_key: "borrador:1294137098535", name: "#D70631", created_at: "2026-06-01T00:00:00Z" }),
        archive({ cart_key: "borrador:1294267449639", name: "#D70731", created_at: "2026-06-02T00:00:00Z" }),
        archive({ cart_key: "borrador:1295033794855", name: "#D71208", created_at: "2026-06-05T00:00:00Z" }),
      ],
      "gid://shopify/DraftOrder/1355892687143",
    );
    expect(carts.map((c) => c.name)).toEqual(["#D71208", "#D70731", "#D70631"]);
    expect(summarizeCarts(carts)).toEqual({ total: 3, completed: 0, abandoned: 3 });
    expect(cartsVerdict(summarizeCarts(carts))).toBe("Ninguno terminó en pedido.");
    expect(cartsTone(summarizeCarts(carts))).toBe("warn");
  });

  it("un borrador que está en el espejo y en el archivo cuenta una vez, y manda el espejo", () => {
    const carts = mergeCustomerCarts(
      [mirror({ shopify_draft_order_id: "77", status: "completed", order_name: "#KP143817" })],
      [archive({ cart_key: "borrador:77", status: "open" })],
    );
    expect(carts).toHaveLength(1);
    expect(carts[0]).toMatchObject({ completed: true, orderName: "#KP143817" });
  });

  it("los checkouts abandonados de la web también cuentan, aparte de los borradores", () => {
    const carts = mergeCustomerCarts([], [
      archive({ cart_key: "carrito:9", kind: "carrito", name: null, status: "abandonado" }),
      archive({ cart_key: "borrador:9", status: "completed", order_name: "#AUR170000" }),
    ]);
    expect(carts.map((c) => c.key).sort()).toEqual(["borrador:9", "carrito:9"]);
    expect(summarizeCarts(carts)).toEqual({ total: 2, completed: 1, abandoned: 1 });
  });

  it("los productos en una línea: título del espejo, nombre del archivo, con cantidad", () => {
    expect(cartProductsLabel([{ title: "Nails Repairing", quantity: 1 }])).toBe("Nails Repairing");
    expect(cartProductsLabel([{ name: "8 en 1 Ultra", quantity: 3 }, { name: "Mushroom Coffee", quantity: 1 }])).toBe("8 en 1 Ultra ×3, Mushroom Coffee");
    expect(cartProductsLabel(null)).toBeNull();
  });
});

describe("el veredicto, en hechos", () => {
  it("cuántos terminaron en pedido", () => {
    expect(cartsVerdict({ total: 12, completed: 3, abandoned: 9 })).toBe("3 de 12 terminaron en pedido.");
    expect(cartsVerdict({ total: 2, completed: 2, abandoned: 0 })).toBe("Todos terminaron en pedido.");
    expect(cartsVerdict({ total: 1, completed: 0, abandoned: 1 })).toBe("No terminó en pedido.");
    expect(cartsVerdict({ total: 0, completed: 0, abandoned: 0 })).toBeNull();
    expect(cartsTone({ total: 12, completed: 3, abandoned: 9 })).toBe("neutral");
    expect(cartsTone({ total: 2, completed: 2, abandoned: 0 })).toBe("ok");
  });
});
