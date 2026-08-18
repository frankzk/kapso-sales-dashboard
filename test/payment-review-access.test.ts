import { describe, expect, it } from "vitest";
import { paymentReviewBatches } from "@/lib/payment-review";

describe("paymentReviewBatches", () => {
  it("divide la carga grande sin perder ni duplicar pedidos", () => {
    const ids = Array.from({ length: 241 }, (_, index) => `pedido-${index + 1}`);
    const batches = paymentReviewBatches(ids, 40);

    expect(batches.map((batch) => batch.length)).toEqual([40, 40, 40, 40, 40, 40, 1]);
    expect(batches.flat()).toEqual(ids);
  });

  it("tolera una bandeja vacía", () => {
    expect(paymentReviewBatches([])).toEqual([]);
  });

  it("rechaza tamaños inválidos", () => {
    expect(() => paymentReviewBatches(["pedido"], 0)).toThrow(/positivo/);
  });
});
