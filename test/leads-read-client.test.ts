import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLeadConversation, loadLeadCustomerHistory, searchLeads } from "@/lib/leads-read-client";

afterEach(() => vi.unstubAllGlobals());

describe("leads browser transport", () => {
  it("dispatches a new read immediately while another is waiting", async () => {
    let release!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(Response.json([{ id: "found" }]));
    vi.stubGlobal("fetch", fetchMock);
    const history = loadLeadCustomerHistory("lead");
    const search = searchLeads(["store"], "999");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await search).toEqual([{ id: "found" }]);
    release(Response.json({ customerHistory: null, cartSummary: null }));
    await history;
    expect(fetchMock.mock.calls[1]).toEqual(["/api/leads/read", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store",
      body: JSON.stringify({ operation: "searchLeads", args: [["store"], "999"] }),
    })]);
  });

  it("supports cancellation of stale searches and chat reads", async () => {
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const searchAbort = new AbortController();
    const chatAbort = new AbortController();
    const search = searchLeads(["store"], "99", searchAbort.signal);
    const chat = loadLeadConversation("lead", undefined, false, chatAbort.signal);
    searchAbort.abort();
    chatAbort.abort();
    await expect(search).rejects.toMatchObject({ name: "AbortError" });
    await expect(chat).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports expired sessions and HTTP failures without parsing an HTML login page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("login", { status: 401 })));
    await expect(searchLeads(["store"], "99")).rejects.toThrow("Tu sesión venció");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failure", { status: 500 })));
    await expect(searchLeads(["store"], "99")).rejects.toThrow("No se pudo cargar");
  });
});

