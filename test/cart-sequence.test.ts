import { describe, it, expect } from "vitest";
import {
  CART_SEQ_MAX_TOUCHES,
  cartSeqSkipReason,
  cartSeqTouchesFor,
  cartSeqWithinHours,
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
