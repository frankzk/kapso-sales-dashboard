import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  stores: vi.fn(),
  search: vi.fn(),
  history: vi.fn(),
  conversation: vi.fn(),
  alerts: vi.fn(),
  advisors: vi.fn(),
}));
vi.mock("@/lib/access", () => ({ getCurrentUser: mocks.user, getAccessibleStores: mocks.stores }));
vi.mock("@/app/dashboard/leads/actions", () => ({
  searchLeads: mocks.search,
  loadLeadCustomerHistory: mocks.history,
  loadLeadConversation: mocks.conversation,
  listYapeAlerts: mocks.alerts,
  listStoreVendedoras: mocks.advisors,
}));
import { POST } from "@/app/api/leads/read/route";

const id = "dcab8bf5-23ec-49f5-8e20-f75a8f978297";
function request(operation: string, args: unknown[], origin = "https://kapta.test") {
  return new Request("https://kapta.test/api/leads/read", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ operation, args }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "advisor" });
  mocks.stores.mockResolvedValue([{ id }]);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("independent leads endpoint", () => {
  it("does not perform privileged advisor lookup for another store", async () => {
    mocks.stores.mockResolvedValue([]);
    expect((await POST(request("listStoreVendedoras", [id]))).status).toBe(403);
    expect(mocks.advisors).not.toHaveBeenCalled();
  });

  it("rejects missing sessions before any lead lookup", async () => {
    mocks.user.mockResolvedValue(null);
    const response = await POST(request("searchLeads", [[id], "999"]));
    expect(response.status).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it.each(["https://other.test", "null", ""])("rejects cross-origin maintenance requests: %s", async (origin) => {
    expect((await POST(request("listYapeAlerts", [], origin))).status).toBe(403);
    expect(mocks.alerts).not.toHaveBeenCalled();
  });

  it.each([
    ["sendLeadMessage", [id, "message"]],
    ["registerCall", []],
    ["claimLead", [id]],
    ["constructor", []],
    ["searchLeads", [["invalid-store"], "999"]],
    ["searchLeads", [[id], "x".repeat(201)]],
    ["loadLeadConversation", [id, null, "true"]],
    ["loadLeadConversation", [id, null, false, "true"]],
    ["loadLeadCustomerHistory", [id, "extra argument"]],
  ])("rejects mutations and malformed arguments (%s)", async (operation, args) => {
    expect((await POST(request(operation as string, args as unknown[]))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it("returns the existing scope-filtered result without caching or logging customer data", async () => {
    mocks.search.mockResolvedValue([]);
    const response = await POST(request("searchLeads", [[id], "999888777"]));
    expect(await response.json()).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.search).toHaveBeenCalledWith([id], "999888777");
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0]);
    expect(log).toEqual({ event: "leads.read", operation: "searchLeads", durationMs: expect.any(Number), authMs: expect.any(Number), totalMs: expect.any(Number) });
  });

  it("preserves a denied lead result from the existing RLS authorization", async () => {
    mocks.history.mockResolvedValue({ error: "Sin acceso a este lead." });
    const response = await POST(request("loadLeadCustomerHistory", [id]));
    expect(await response.json()).toEqual({ error: "Sin acceso a este lead." });
  });

  it("restores optional arguments serialized as null", async () => {
    mocks.conversation.mockResolvedValue({ messages: [] });
    await POST(request("loadLeadConversation", [id, null, false]));
    expect(mocks.conversation).toHaveBeenCalledWith(id, undefined, false);
  });

  it("accepts the optional active poll flag while retaining the existing authorization path", async () => {
    mocks.conversation.mockResolvedValue({ messages: [] });
    expect((await POST(request("loadLeadConversation", [id, "thread", false, true]))).status).toBe(200);
    expect(mocks.conversation).toHaveBeenCalledWith(id, "thread", false, true);
  });

  it("finishes a search while a slow history request is still pending", async () => {
    let finish!: (result: unknown) => void;
    mocks.history.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mocks.search.mockResolvedValue([{ id }]);
    let historyFinished = false;
    const history = POST(request("loadLeadCustomerHistory", [id])).then((r) => {
      historyFinished = true;
      return r;
    });
    const search = await POST(request("searchLeads", [[id], "999"]));
    expect(await search.json()).toEqual([{ id }]);
    expect(historyFinished).toBe(false);
    finish({ customerHistory: null, cartSummary: null });
    await history;
  });

  it("does not expose upstream error details", async () => {
    mocks.history.mockRejectedValue(new Error("provider credentials or customer data"));
    const response = await POST(request("loadLeadCustomerHistory", [id]));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("credentials");
  });

  it("rejects oversized or malformed bodies before dispatch", async () => {
    for (const body of ["not json", "x".repeat(16_385)]) {
      const response = await POST(new Request("https://kapta.test/api/leads/read", {
        method: "POST",
        headers: { origin: "https://kapta.test", "content-type": "application/json" },
        body,
      }));
      expect([400, 413]).toContain(response.status);
    }
    expect(mocks.search).not.toHaveBeenCalled();
  });
});

