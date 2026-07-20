import { describe, it, expect } from "vitest";
import {
  CART_SEQ_MAX_TOUCHES,
  cartAddressLabel,
  cartPriceLabel,
  cartProductLabel,
  cartSeqSkipReason,
  cartSeqTouchesFor,
  cartSeqWithinHours,
  cartTemplateParams,
  type CartSeqLead,
} from "@/lib/cart-sequence";

const CART_AT = "2026-07-10T15:00:00.000Z"; // 10am Lima
const CFG = { hours1: 3, hours2: 24 };

function lead(overrides: Partial<CartSeqLead> = {}): CartSeqLead {
  return {
    id: "l1",
    phone: "51999888777",
    name: "María",
    category: "open",
    has_order: false,
    draft_order_gid: "gid://shopify/DraftOrder/1",
    draft_order_status: "open",
    last_inbound_at: null,
    cart_seq_touches: 0,
    last_cart_seq_at: null,
    cart_seq_gid: null,
    cart_summary: "Sérum Tea Tree",
    ...overrides,
  };
}

const at = (iso: string) => Date.parse(iso);

describe("cartSeqTouchesFor (reinicio por carrito nuevo)", () => {
  it("cuenta los toques del carrito actual", () => {
    expect(cartSeqTouchesFor(lead({ cart_seq_touches: 1, cart_seq_gid: "gid://shopify/DraftOrder/1" }))).toBe(1);
  });
  it("un gid distinto (recompra / nuevo checkout) reinicia a 0", () => {
    expect(cartSeqTouchesFor(lead({ cart_seq_touches: 2, cart_seq_gid: "gid://shopify/DraftOrder/OLD" }))).toBe(0);
  });
  it("sin gid previo usa el contador tal cual", () => {
    expect(cartSeqTouchesFor(lead({ cart_seq_touches: 1, cart_seq_gid: null }))).toBe(1);
  });
});

describe("cartSeqSkipReason — timing anclado a la creación del carrito", () => {
  it("antes de las horas del toque 1 → aun_no; después → elegible", () => {
    expect(cartSeqSkipReason(lead(), CART_AT, at("2026-07-10T17:59:00.000Z"), CFG)).toBe("aun_no");
    expect(cartSeqSkipReason(lead(), CART_AT, at("2026-07-10T18:01:00.000Z"), CFG)).toBeNull();
  });
  it("toque 2: espera las horas_2 desde el carrito (no desde el toque 1)", () => {
    const l = lead({
      cart_seq_touches: 1,
      cart_seq_gid: "gid://shopify/DraftOrder/1",
      last_cart_seq_at: "2026-07-10T18:05:00.000Z",
    });
    expect(cartSeqSkipReason(l, CART_AT, at("2026-07-11T08:00:00.000Z"), CFG)).toBe("aun_no");
    expect(cartSeqSkipReason(l, CART_AT, at("2026-07-11T15:05:00.000Z"), CFG)).toBeNull();
  });
  it("espaciado mínimo: si ambos pasos vencieron a la vez, el toque 2 espera 1h del toque 1", () => {
    const l = lead({
      cart_seq_touches: 1,
      cart_seq_gid: "gid://shopify/DraftOrder/1",
      last_cart_seq_at: "2026-07-11T15:10:00.000Z", // recién enviado el toque 1
    });
    expect(cartSeqSkipReason(l, CART_AT, at("2026-07-11T15:20:00.000Z"), CFG)).toBe("espera_toque2");
    expect(cartSeqSkipReason(l, CART_AT, at("2026-07-11T16:20:00.000Z"), CFG)).toBeNull();
  });
  it("tope de toques", () => {
    const l = lead({ cart_seq_touches: CART_SEQ_MAX_TOUCHES, cart_seq_gid: "gid://shopify/DraftOrder/1" });
    expect(cartSeqSkipReason(l, CART_AT, at("2026-07-13T15:00:00.000Z"), CFG)).toBe("tope");
  });
  it("carrito nuevo reinicia la secuencia aunque el contador viejo esté al tope", () => {
    const l = lead({ cart_seq_touches: 2, cart_seq_gid: "gid://shopify/DraftOrder/OLD" });
    expect(cartSeqSkipReason(l, CART_AT, at("2026-07-10T18:30:00.000Z"), CFG)).toBeNull();
  });
  it("sin fecha del carrito no hay ancla → sin_fecha_carrito", () => {
    expect(cartSeqSkipReason(lead(), null, at("2026-07-10T18:30:00.000Z"), CFG)).toBe("sin_fecha_carrito");
  });
});

describe("cartSeqSkipReason — paradas acordadas", () => {
  const NOW = at("2026-07-10T18:30:00.000Z"); // pasado el toque 1

  it("ya tiene pedido / ganado / perdido", () => {
    expect(cartSeqSkipReason(lead({ has_order: true }), CART_AT, NOW, CFG)).toBe("con_pedido");
    expect(cartSeqSkipReason(lead({ category: "won" }), CART_AT, NOW, CFG)).toBe("ganado");
    expect(cartSeqSkipReason(lead({ category: "lost" }), CART_AT, NOW, CFG)).toBe("perdido");
  });
  it("carrito completado o borrado", () => {
    expect(cartSeqSkipReason(lead({ draft_order_status: "completed" }), CART_AT, NOW, CFG)).toBe("carrito_cerrado");
    expect(cartSeqSkipReason(lead({ draft_order_gid: null }), CART_AT, NOW, CFG)).toBe("sin_carrito");
  });
  it("el cliente respondió DESPUÉS de dejar el carrito → lo lleva el bot/asesora", () => {
    expect(
      cartSeqSkipReason(lead({ last_inbound_at: "2026-07-10T16:00:00.000Z" }), CART_AT, NOW, CFG),
    ).toBe("respondio");
    // un inbound ANTERIOR al carrito (conversación vieja) no frena la secuencia
    expect(
      cartSeqSkipReason(lead({ last_inbound_at: "2026-07-09T10:00:00.000Z" }), CART_AT, NOW, CFG),
    ).toBeNull();
  });
  it("sin nombre no hay {{1}} → se omite", () => {
    expect(cartSeqSkipReason(lead({ name: null }), CART_AT, NOW, CFG)).toBe("sin_nombre");
  });
  it("la gestión de la asesora (status manual, open) NO frena la secuencia — corre en paralelo", () => {
    expect(cartSeqSkipReason(lead({ category: "open" }), CART_AT, NOW, CFG)).toBeNull();
    expect(cartSeqSkipReason(lead({ category: "hot" }), CART_AT, NOW, CFG)).toBeNull();
  });
});

describe("variables de plantilla (formato de la automatización existente)", () => {
  it("producto: títulos con cantidad desde los line_items del draft", () => {
    expect(
      cartProductLabel(
        [{ title: "Set de Pelador de Verduras + Abridor Premium", quantity: 1 }],
        null,
      ),
    ).toBe("Set de Pelador de Verduras + Abridor Premium x 1");
    expect(
      cartProductLabel(
        [
          { title: "Sérum Tea Tree (30ml)", quantity: 2 },
          { title: "Champú Keratina", quantity: 1 },
        ],
        null,
      ),
    ).toBe("Sérum Tea Tree x 2, Champú Keratina x 1");
  });
  it("producto: cae al cart_summary del lead y a null sin datos", () => {
    expect(cartProductLabel(null, "Mushroom Coffee")).toBe("Mushroom Coffee");
    expect(cartProductLabel([], "  ")).toBeNull();
  });
  it("precio: S/. para PEN, código para otras monedas, null sin monto", () => {
    expect(cartPriceLabel(99, "PEN")).toBe("S/.99.00");
    expect(cartPriceLabel(158.5, null)).toBe("S/.158.50");
    expect(cartPriceLabel(25, "USD")).toBe("USD 25.00");
    expect(cartPriceLabel(null, "PEN")).toBeNull();
    expect(cartPriceLabel(0, "PEN")).toBeNull();
  });
  it("dirección: dirección + distrito, referencia solo cuando existe", () => {
    expect(
      cartAddressLabel(
        { address1: "Condominio Orquideas Del Sol, B-5", district: "Cuzco", referencia: null },
        lead(),
      ),
    ).toBe("Condominio Orquideas Del Sol, B-5, Cuzco");
    expect(
      cartAddressLabel(
        { address1: "Av. Principal 123", district: "Chorrillos", referencia: "portón verde" },
        lead(),
      ),
    ).toBe("Av. Principal 123, Chorrillos (portón verde)");
    // fallback a las columnas del lead cuando el draft no trae dirección
    expect(
      cartAddressLabel({}, lead({ address1: "Jr. Lima 456", district: "Juliaca" })),
    ).toBe("Jr. Lima 456, Juliaca");
    expect(cartAddressLabel({}, lead({ address1: null, district: null }))).toBeNull();
  });
  it("cartTemplateParams arma [nombre, producto, precio, dirección] o null si falta algo", () => {
    const snap = {
      created_at: CART_AT,
      line_items: [{ title: "Set Pelador Premium", quantity: 1 }],
      total_amount: 99,
      currency: "PEN",
      address1: "Condominio Orquideas Del Sol, B-5",
      district: "Cuzco",
      referencia: null,
    };
    expect(cartTemplateParams(lead(), snap)).toEqual([
      "María",
      "Set Pelador Premium x 1",
      "S/.99.00",
      "Condominio Orquideas Del Sol, B-5, Cuzco",
    ]);
    // sin precio (ni en draft ni en lead) → null: no se envía ni consume toque
    expect(
      cartTemplateParams(lead({ cart_value: null }), { ...snap, total_amount: null }),
    ).toBeNull();
    // el precio cae al cart_value del lead si el draft no lo trae
    expect(
      cartTemplateParams(lead({ cart_value: 158 }), { ...snap, total_amount: null })?.[2],
    ).toBe("S/.158.00");
  });
});

describe("cartSeqWithinHours", () => {
  it("dentro y fuera de la ventana en hora Lima", () => {
    // 15:00 UTC = 10am Lima
    expect(cartSeqWithinHours("2026-07-10T15:00:00.000Z", "America/Lima", 8, 21)).toBe(true);
    // 07:00 UTC = 2am Lima
    expect(cartSeqWithinHours("2026-07-10T07:00:00.000Z", "America/Lima", 8, 21)).toBe(false);
    // borde superior exclusivo: 21:00 Lima ya no envía
    expect(cartSeqWithinHours("2026-07-11T02:00:00.000Z", "America/Lima", 8, 21)).toBe(false);
  });
  it("config sin sentido (end ≤ start) cae a los defaults 8–21", () => {
    expect(cartSeqWithinHours("2026-07-10T15:00:00.000Z", "America/Lima", 22, 8)).toBe(true);
    expect(cartSeqWithinHours("2026-07-10T07:00:00.000Z", "America/Lima", 22, 8)).toBe(false);
  });
});
