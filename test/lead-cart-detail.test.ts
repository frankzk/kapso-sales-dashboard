import { describe, expect, it } from "vitest";
import { cartCreatedAtLabel, leadCartDetailOf } from "@/lib/lead-cart-detail";

describe("el carrito original en la ficha del lead", () => {
  it("conserva el título completo, las cantidades y las variantes elegidas", () => {
    expect(leadCartDetailOf({
      created_at: "2026-10-27T13:02:00Z",
      line_items: [
        { title: "Black Seed Oil (60 cápsulas)", variant_title: "Pack de 3", quantity: 2 },
        { title: "Pulsera", variant_title: "Default Title", quantity: 1 },
      ],
    })).toEqual({
      createdAt: "2026-10-27T13:02:00Z",
      lines: [
        { title: "Black Seed Oil (60 cápsulas)", variant: "Pack de 3", quantity: 2 },
        { title: "Pulsera", variant: null, quantity: 1 },
      ],
    });
  });

  it("no inventa una fecha cuando el carrito no la tiene", () => {
    expect(leadCartDetailOf(null)).toBeNull();
    expect(leadCartDetailOf({ created_at: "ayer" })).toEqual({ createdAt: null, lines: [] });
    expect(leadCartDetailOf({ line_items: null })?.createdAt).toBeNull();
  });

  it("omite líneas sin nombre y tolera cantidades incompletas", () => {
    expect(leadCartDetailOf({ line_items: [null, {}, { title: " " },
      { title: " Champú ", quantity: "3", variant_title: " Romero " },
      { title: "Sérum", quantity: "sin dato" },
      { title: "Pulsera", quantity: 0 },
    ] })?.lines).toEqual([
      { title: "Champú", quantity: 3, variant: "Romero" },
      { title: "Sérum", quantity: 1, variant: null },
      { title: "Pulsera", quantity: 1, variant: null },
    ]);
  });

  it("muestra la fecha y hora de Lima, también cuando el día UTC ya cambió", () => {
    expect(cartCreatedAtLabel("2026-10-27T13:02:00Z")).toBe("27/10/2026, 08:02");
    expect(cartCreatedAtLabel("2026-10-28T02:05:00Z")).toBe("27/10/2026, 21:05");
    expect(cartCreatedAtLabel("2026-10-27T08:02:00-05:00")).toBe("27/10/2026, 08:02");
    expect(cartCreatedAtLabel("sin fecha")).toBeNull();
    expect(cartCreatedAtLabel(null)).toBeNull();
  });
});
