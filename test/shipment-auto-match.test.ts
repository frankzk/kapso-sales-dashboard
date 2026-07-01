import { describe, it, expect } from "vitest";
import { decideSuggestion, type SuggestCandidate } from "@/lib/shipment-auto-match";

function candidate(over: Partial<SuggestCandidate>): SuggestCandidate {
  return { gid: "gid://shopify/Order/1", storeId: "s1", name: "#KP118200", customer_phone: null, ...over };
}

describe("decideSuggestion", () => {
  it("never suggests when the shipment has no phone, even with one candidate", () => {
    const r = decideSuggestion(
      { orderName: "#KP118200", customerPhone: null },
      [candidate({ customer_phone: "51930295803" })],
    );
    expect(r).toEqual({ suggest: false, candidate: null });
  });

  it("suggests the single candidate whose phone matches", () => {
    const match = candidate({ customer_phone: "51930295803" });
    const r = decideSuggestion({ orderName: "#KP118200", customerPhone: "51930295803" }, [match]);
    expect(r).toEqual({ suggest: true, candidate: match });
  });

  it("does not suggest when there are no candidates", () => {
    const r = decideSuggestion({ orderName: "#KP118200", customerPhone: "51930295803" }, []);
    expect(r).toEqual({ suggest: false, candidate: null });
  });

  it("disambiguates multiple candidates when exactly one phone matches", () => {
    const match = candidate({ gid: "gid://shopify/Order/2", customer_phone: "51930295803" });
    const r = decideSuggestion({ orderName: "#KP118200", customerPhone: "51930295803" }, [
      candidate({ gid: "gid://shopify/Order/1", customer_phone: "51999000111" }),
      match,
    ]);
    expect(r).toEqual({ suggest: true, candidate: match });
  });

  it("does not suggest when 2+ candidates share the matching phone (ambiguous)", () => {
    const r = decideSuggestion({ orderName: "#KP118200", customerPhone: "51930295803" }, [
      candidate({ gid: "gid://shopify/Order/1", customer_phone: "51930295803" }),
      candidate({ gid: "gid://shopify/Order/2", customer_phone: "51930295803" }),
    ]);
    expect(r).toEqual({ suggest: false, candidate: null });
  });

  it("does not suggest a name-only coincidence — the phone must cross-validate", () => {
    // The exact scenario that motivated this: #KP173369 exists as a Shopify
    // order but belongs to a different customer than the shipment.
    const r = decideSuggestion({ orderName: "#KP173369", customerPhone: "51984111770" }, [
      candidate({ name: "#KP173369", customer_phone: "51900000000" }),
    ]);
    expect(r).toEqual({ suggest: false, candidate: null });
  });
});
