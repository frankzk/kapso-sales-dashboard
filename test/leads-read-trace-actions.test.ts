import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), creds: vi.fn(), history: vi.fn(), lead: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: vi.fn(), resolveAgentNames: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: mocks.creds }));
vi.mock("@/lib/access", () => ({ getWaNumbers: async () => ({}) }));
vi.mock("@/lib/leads-access", () => ({ getCustomerHistory: mocks.history }));
vi.mock("@/lib/whatsapp-outbox", () => ({ listLeadWhatsappOutbox: async () => [], mergeTranscriptWithOutbox: (messages: unknown[]) => messages }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: "test-advisor" } } }) }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.access }) }) }) }),
  createAdminSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.lead }) }) }) }),
}));
import { loadLeadConversation, loadLeadCustomerHistory } from "@/app/dashboard/leads/actions";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.access.mockResolvedValue({ data: { store_id: "test-store", phone: "51999888777", kapso_conversation_id: "test-thread", wa_phone_number_id: "test-number" } });
  mocks.lead.mockResolvedValue({ data: { phone: "51999888777", order_id: null, source: "organic", cart_summary: null } });
  mocks.creds.mockResolvedValue({ kapso_api_key: "test-secret", shopify_domain: "shop.test", shopify_token: "shop-secret" });
  mocks.history.mockResolvedValue({ currentOrderId: null, currentOrderName: null, recentOrders: [] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const metric = () => JSON.parse(vi.mocked(console.info).mock.calls.at(-1)![0]);

describe("read timing integration with existing provider clients", () => {
  it("refreshes the authorized stored thread with one HTTP call and keeps selector metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    const result = await loadLeadConversation("test-lead", "test-thread", false, true);
    expect(result).toMatchObject({ activeConversationId: "test-thread", activePhoneNumberId: "test-number", threadsUnchanged: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(metric()).toMatchObject({ mode: "active_poll", httpStatuses: { kapso: { 200: 1 } } });
    expect(metric().stages).not.toHaveProperty("kapso.discovery");
    expect(metric().stages).not.toHaveProperty("db.labels");
  });
  it.each([
    ["test-thread", false, false], // periodic discovery
    ["test-thread", true, true], // complete history must never become a cheap poll
    ["untrusted-thread", false, true], // caller-controlled ids are not trusted
  ])("retains discovery for id=%s older=%s poll=%s", async (id, older, poll) => {
    const fetch = vi.fn().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return Response.json({ data: url.pathname.endsWith("/conversations")
        ? [{ id: "test-thread", phone_number_id: "test-number", last_active_at: "2026-10-01T00:00:00Z" }]
        : [] });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await loadLeadConversation("test-lead", id, older, poll);
    expect(metric().stages).toHaveProperty("kapso.discovery");
    expect(result.activeConversationId).toBe("test-thread");
    expect(result.threadsUnchanged).not.toBe(true);
  });
  it("preserves the active thread and selector if a cheap poll fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private error", { status: 403 })));
    expect(await loadLeadConversation("test-lead", "test-thread", false, true)).toMatchObject({
      activeConversationId: "test-thread", threadsUnchanged: true, reason: "No se pudo cargar la conversación de WhatsApp.",
    });
    expect(metric().httpStatuses).toEqual({ kapso: { 403: 1 } });
  });
  it("keeps the existing two-page transcript limit on active polls", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: Array.from({ length: 100 }, (_, i) => ({ id: `message-${i}` })), paging: { cursors: { after: "next-page" } } }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    await loadLeadConversation("test-lead", "test-thread", false, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toContain("next-page");
    expect(metric().stages).not.toHaveProperty("kapso.discovery");
  });
  it("discovers a rotated session when the requested id no longer matches the lead", async () => {
    mocks.access.mockResolvedValue({ data: { store_id: "test-store", phone: "51999888777", kapso_conversation_id: "new-thread", wa_phone_number_id: "test-number" } });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input) => Response.json({
      data: new URL(String(input)).pathname.endsWith("/conversations") ? [
        { id: "test-thread", phone_number_id: "test-number", last_active_at: "2026-09-30T00:00:00Z" },
        { id: "new-thread", phone_number_id: "test-number", last_active_at: "2026-10-01T00:00:00Z" },
      ] : [],
    })));
    const result = await loadLeadConversation("test-lead", "test-thread", false, true);
    expect(result.activeConversationId).toBe("new-thread");
    expect(metric().stages).toHaveProperty("kapso.discovery");
  });
  it("measures the fast chat path without discovering old sessions", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    expect((await loadLeadConversation("test-lead", undefined, false)).activeConversationId).toBe("test-thread");
    expect(fetch).toHaveBeenCalledOnce();
    expect(metric()).toMatchObject({ operation: "chat", mode: "first_paint", httpStatuses: { kapso: { 200: 1 } } });
    expect(metric().stages).toHaveProperty("kapso.transcript");
    expect(metric().stages).not.toHaveProperty("kapso.discovery");
  });
  it("measures Shopify separately from local history and preserves graceful fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private provider error", { status: 403 })));
    const result = await loadLeadCustomerHistory("test-lead");
    expect(result).toMatchObject({ customerHistory: { recentOrders: [] } });
    expect(metric().httpStatuses).toEqual({ shopify: { 403: 1 } });
    expect(metric().stages).toHaveProperty("db.history");
    expect(metric().stages).toHaveProperty("shopify.history");
    expect(JSON.stringify(metric())).not.toMatch(/51999888777|test-lead|private provider error|shop-secret|shop.test/);
  });
  it("does not call either provider for an inaccessible lead", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mocks.access.mockResolvedValue({ data: null });
    expect(await loadLeadCustomerHistory("denied")).toEqual({ error: "Sin acceso a este lead." });
    expect((await loadLeadConversation("denied")).reason).toBe("Sin acceso a este lead.");
    expect((await loadLeadConversation("denied", "test-thread", false, true)).reason).toBe("Sin acceso a este lead.");
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.creds).not.toHaveBeenCalled();
  });
});
