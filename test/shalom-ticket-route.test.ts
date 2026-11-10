import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/shalom/ticket/[shipmentId]/route";

const state = vi.hoisted(() => ({ user: true, shipment: null as unknown, admin: vi.fn(), store: vi.fn(), resolve: vi.fn(), pdf: vi.fn() }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: state.admin,
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user ? { id: "operator" } : null } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.shipment }) }) }) }),
  }),
}));
vi.mock("@/lib/shalom/session", () => ({ loadStoreShalom: state.store }));
vi.mock("@/lib/shalom/requested-ticket", () => ({ resolveRequestedShalomTicket: state.resolve }));
vi.mock("@/lib/shalom/label-cache", () => ({ shalomVoucherPdf: state.pdf }));
const GUIDE = { id: "requested", store_id: "kenku", courier: "shalom", guide_code: "102371814", shalom_ose_id: null, created_at: "2026-11-01T22:51:56Z" };
const request = () => GET(new NextRequest("https://kapta.test/api/shalom/ticket/requested"), { params: Promise.resolve({ shipmentId: "requested" }) });

beforeEach(() => {
  vi.clearAllMocks(); state.user = true; state.shipment = { ...GUIDE };
  state.admin.mockReturnValue({}); state.store.mockResolvedValue({ shalom_pro_email: "operator@example.test" });
  state.resolve.mockResolvedValue(202); state.pdf.mockResolvedValue(new TextEncoder().encode("%PDF-1.4\nfixture"));
});

describe("private Shalom ticket HTTP route", () => {
  it("requires login before constructing an admin client or querying Shalom", async () => {
    state.user = false;
    expect((await request()).status).toBe(401);
    expect(state.admin).not.toHaveBeenCalled(); expect(state.resolve).not.toHaveBeenCalled();
  });

  it("respects row-level access before any lookup", async () => {
    state.shipment = null;
    expect((await request()).status).toBe(403);
    expect(state.admin).not.toHaveBeenCalled(); expect(state.resolve).not.toHaveBeenCalled();
  });

  it("does not try Shalom for another courier", async () => {
    state.shipment = { ...GUIDE, courier: "olva" };
    expect((await request()).status).toBe(400); expect(state.resolve).not.toHaveBeenCalled();
  });

  it("resolves and downloads exactly the authorized guide, returning a private PDF", async () => {
    const res = await request();
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("content-disposition")).toContain("ticket-shalom-202.pdf");
    expect(state.resolve).toHaveBeenCalledWith({}, GUIDE, { shalom_pro_email: "operator@example.test" });
    expect(state.pdf).toHaveBeenCalledWith({}, "kenku", { shalom_pro_email: "operator@example.test" }, 202);
    expect(await res.text()).toContain("%PDF-");
  });

  it("does not download any PDF when the guide ID cannot be resolved safely", async () => {
    state.resolve.mockRejectedValueOnce(new Error("La guía cambió"));
    expect((await request()).status).toBe(502); expect(state.pdf).not.toHaveBeenCalled();
  });

  it("rejects a non-PDF upstream response", async () => {
    state.pdf.mockResolvedValueOnce(new TextEncoder().encode('{"error":"upstream"}'));
    expect((await request()).status).toBe(502);
  });

  it("does not query Shalom when the store has no configured account", async () => {
    state.store.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(409); expect(state.resolve).not.toHaveBeenCalled();
  });

  it("rejects an oversized document", async () => {
    state.pdf.mockResolvedValueOnce(new Uint8Array(10 * 1024 * 1024 + 1));
    expect((await request()).status).toBe(502);
  });
});
