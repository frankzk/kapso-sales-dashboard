import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { summarizeLeadProducts, type ProductReviewLead } from "@/lib/lead-product-review";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), catalogue: vi.fn(), backfill: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/db", () => ({ createAdminSupabase: mocks.admin }));
vi.mock("@/lib/lead-products-server", () => ({ loadLeadProductCatalog: mocks.catalogue, backfillLeadProducts: mocks.backfill, withProductOpeners: mocks.project }));
import { POST } from "@/app/api/internal/leads/product-review/route";

const storeId = "dcab8bf5-23ec-49f5-8e20-f75a8f978297";
const signal = (handle: string) => ({ handle, title: handle, at: "2026-11-11T12:00:00Z", evidence: "Private customer text", message_id: null, source: "customer_text" as const });
const row = (patch: Partial<ProductReviewLead> = {}): ProductReviewLead => ({ id: "l", store_id: storeId, first_seen_at: "2026-11-11", status: "nuevo", category: "open", ...patch });
describe("aggregate product counts", () => {
  it("uses entry/current separately and retains the retry/followup queue rules", () => {
    const leads = [row({ entry_product: signal("shampoo-biru"), interest_product: signal("aceite-magic") }),
      row({ entry_product: signal("magnesio-puro"), status: "volver_a_llamar", next_followup_at: "2026-11-12" }),
      row({ entry_product: signal("icefit-molde-de-hielo"), status: "no_responde", call_queue_ready: true }),
      row({ entry_product: signal("magnesio-12-en-1"), status: "yape_por_verificar", category: "hot" }),
      row({ entry_product: signal("shampoo-biru"), category: "won" })];
    const result = summarizeLeadProducts(leads, []);
    expect(result.queue_size).toBe(3);
    expect(result.entry.biru).toEqual({ por_llamar: 1, en_seguimiento: 0 });
    expect(result.current.magic.por_llamar).toBe(1);
    expect(result.entry.magnesio).toEqual({ por_llamar: 0, en_seguimiento: 1 });
    expect(result.entry.icefit.por_llamar).toBe(1);
    expect(JSON.stringify(result)).not.toContain("Private customer text");
  });
  it("only applies a declared ad product in its effective period; ambiguity blocks fallback", () => {
    const declarations = [{ store_id: storeId, ad_id: "ad", product_handle: "shampoo-biru", valid_from: "2026-11-10" }];
    const result = summarizeLeadProducts([row({ ad_id: "ad" }), row({ ad_id: "ad", first_seen_at: "2026-11-09" }), row({ ad_id: "ad", entry_product: { ...signal(""), handle: null, source: "ambiguous" } })], declarations);
    expect(result.entry.biru.por_llamar).toBe(1);
  });
});

describe("private server-side review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LEAD_PRODUCT_REVIEW_ACCESS", JSON.stringify({ token: "test-review-secret", expiresAt: "2099-01-01", storeIds: [storeId] }));
    const store = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn(async () => ({ data: { id: storeId }, error: null })) };
    mocks.admin.mockReturnValue({ from: () => store });
    mocks.catalogue.mockResolvedValue([{ handle: "icefit", title: "Icefit" }]);
    mocks.backfill.mockResolvedValue({ checked: 0, identified: 0 });
  });
  const request = (query = "", token = "test-review-secret") => new NextRequest(`https://example.test/api/internal/leads/product-review?storeId=${storeId}${query}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  it("rejects unauthenticated requests before creating a service client", async () => {
    expect((await POST(request("", "wrong"))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects invalid store or mode without scanning data", async () => {
    expect((await POST(request("&mode=anything"))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("denies expired access and stores outside the maintenance scope", async () => {
    vi.stubEnv("LEAD_PRODUCT_REVIEW_ACCESS", JSON.stringify({ token: "test-review-secret", expiresAt: "2000-01-01", storeIds: [storeId] }));
    expect((await POST(request())).status).toBe(401);
    vi.stubEnv("LEAD_PRODUCT_REVIEW_ACCESS", JSON.stringify({ token: "test-review-secret", expiresAt: "2099-01-01", storeIds: [] }));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("resumes a dedicated review cursor and returns only completion/counts", async () => {
    mocks.backfill.mockResolvedValueOnce({ checked: 1000, identified: 38 }).mockResolvedValueOnce({ checked: 7, identified: 2 });
    const response = await POST(request());
    expect(await response.json()).toEqual({ ok: true, source: "lead_product_full_audit_20261111", checked: 1007, identified: 40, complete: true });
    expect(mocks.backfill).toHaveBeenCalledTimes(2);
    expect(mocks.backfill.mock.calls[0]!.slice(3)).toEqual([1000, "lead_product_full_audit_20261111"]);
  });
  it("bounds each request even when every batch is full", async () => {
    mocks.backfill.mockResolvedValue({ checked: 1000, identified: 100 });
    expect((await (await POST(request())).json()).complete).toBe(false);
    expect(mocks.backfill).toHaveBeenCalledTimes(20);
  });
  it("does not expose private upstream error text and stops on failure", async () => {
    mocks.backfill.mockRejectedValueOnce(new Error("Private customer text"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("Private customer text");
    expect(mocks.backfill).toHaveBeenCalledTimes(1);
  });
});
