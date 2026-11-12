import { describe, it, expect } from "vitest";
import { productReferenceResolver } from "@/lib/lead-product-references";
import { mergeLeadProductCatalog } from "@/lib/lead-products";
const catalogue = [
  { handle: "biru", title: "Shampoo Biru", skus: ["0012"], wooProductIds: ["12"] },
  { handle: "magic", title: "Aceite Magic", skus: ["0013"], wooProductIds: ["13"] },
];
describe("exact store product references", () => {
  it("resolves a Woo cart with no slug, and repeated units of the same product", () => {
    const r = productReferenceResolver(catalogue);
    expect(r.cart([{ product_id: "12", sku: "0012" }], "woocommerce")).toBe("biru");
    expect(r.cart([{ product_id: "12", sku: "variant-A" }, { product_id: "12", sku: "variant-B" }], "woocommerce")).toBe("biru");
  });
  it("does not confuse Shopify and Woo numeric IDs or use a purchase/title", () => {
    const r = productReferenceResolver(catalogue);
    expect(r.cart([{ product_id: "12" }], "shopify")).toBeNull();
    expect(r.cart([{ product_id: "12" }])).toBeNull();
    expect(r.cart([{ sku: "0012" }], "shopify")).toBe("biru");
    expect(r.cart([])).toBeNull();
    expect(r.cart([{}])).toBeNull();
  });
  it("does not discard unknown lines or pick one product from a mixed cart", () => {
    const r = productReferenceResolver(catalogue);
    expect(r.cart([{ sku: "0012" }, {}])).toBeNull();
    expect(r.cart([{ sku: "0012" }, { sku: "0013" }])).toBeNull();
    expect(r.cart([{ product_id: "13", sku: "0012" }], "woocommerce")).toBeNull();
  });
  it("preserves SKU leading zeroes and rejects collisions or incomplete ad mappings", () => {
    const r = productReferenceResolver(catalogue);
    expect(r.promoted(["12"])).toBeNull();
    expect(r.promoted(["0012", "unknown"])).toBeNull();
    expect(r.promoted(["0012", "0013"])).toBeNull();
    expect(r.promoted(["0012"])).toBe("biru");
    expect(productReferenceResolver([...catalogue, { handle: "duplicate", title: "Other", skus: ["0012"] }]).sku("0012")).toBeNull();
    expect(productReferenceResolver([catalogue[1]!]).sku("0012")).toBeNull();
  });
  it("retains historical SKUs only when a unique catalogue identity merges", () => {
    const merged = mergeLeadProductCatalog([{ handle: "biru™", title: "Shampoo Biru", skus: ["OLD"] }], catalogue);
    const r = productReferenceResolver(merged);
    expect(r.promoted(["OLD"])).toBe("biru");
    expect(r.cart([{ product_handle: "biru™" }])).toBe("biru");
  });
});
