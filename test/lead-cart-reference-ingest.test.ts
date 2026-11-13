import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftOrderRow } from "@/lib/types";
const catalogue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lead-products-server", () => ({ loadLeadProductCatalog: catalogue,
  saveCustomerProducts: vi.fn(), backfillLeadProducts: vi.fn(), markProductConversationAttempt: vi.fn() }));
import { linkDraftOrdersToLeads } from "@/lib/leads-ingest";

describe("Woo cart reconciliation on catalogue outages", () => {
  it.each(["failed", "empty"])("does not overwrite known references or dispositions on a %s catalogue", async failure => {
    if (failure === "failed") catalogue.mockRejectedValueOnce(new Error("upstream offline"));
    else catalogue.mockResolvedValueOnce([]);
    const from = vi.fn();
    const draft = { customer_phone: "synthetic", platform: "woocommerce", tags: ["cod_form"], line_items: [{ product_id: "12", sku: "SKU" }] } as DraftOrderRow;
    await expect(linkDraftOrdersToLeads({ from } as unknown as SupabaseClient, "store", [draft])).rejects.toThrow("se conserva la atribución");
    expect(from).not.toHaveBeenCalled();
    expect(draft.line_items[0]).not.toHaveProperty("product_handle");
  });
});
