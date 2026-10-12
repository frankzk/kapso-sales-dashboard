import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadVoicePanelData } from "@/lib/voice-lead-labels";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  stores: vi.fn(),
  search: vi.fn(),
  history: vi.fn(),
  conversation: vi.fn(),
  alerts: vi.fn(),
  advisors: vi.fn(),
  voicePanel: vi.fn(),
  voiceTest: vi.fn(),
}));
vi.mock("@/lib/access", () => ({ getCurrentUser: mocks.user, getAccessibleStores: mocks.stores }));
vi.mock("@/app/dashboard/leads/actions", () => ({
  searchLeads: mocks.search,
  loadLeadCustomerHistory: mocks.history,
  loadLeadConversation: mocks.conversation,
  listYapeAlerts: mocks.alerts,
  listStoreVendedoras: mocks.advisors,
  loadLeadVoicePanel: mocks.voicePanel,
  // Exportada de verdad por las acciones de leads: si la lista blanca de la
  // ruta la dejara pasar, este mock la registraría.
  probarAgenteLeadEnMiTelefono: mocks.voiceTest,
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
    // Agente de voz de leads (MOM §33.3): no hay llamada a mano desde el
    // drawer, y «Probar en mi teléfono» marca por Telnyx, así que es una
    // mutación y nunca una lectura, aunque sus argumentos sean válidos. El
    // panel solo acepta exactamente un id de lead.
    ["probarAgenteLeadEnMiTelefono", [id, "999888777"]],
    ["loadLeadVoicePanel", []],
    ["loadLeadVoicePanel", [null]],
    ["loadLeadVoicePanel", ["not-a-uuid"]],
    ["loadLeadVoicePanel", [id, "extra argument"]],
  ])("rejects mutations and malformed arguments (%s)", async (operation, args) => {
    expect((await POST(request(operation as string, args as unknown[]))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.voicePanel).not.toHaveBeenCalled();
    expect(mocks.voiceTest).not.toHaveBeenCalled();
  });

  it("reads the lead voice-agent panel through the same allowlisted transport", async () => {
    // A ciegas (MOM §33.3): solo lo que el agente ya hizo. `satisfies` hace que
    // tsc rechace aquí un campo de cola o de brazo (eligible, reason, arm).
    const panel = {
      data: {
        enabled: true,
        configured: true,
        optOut: false,
        calls: [
          {
            id: "call-1",
            mode: "real",
            status: "completed",
            outcome: "volver_a_llamar",
            queued_at: "2026-10-12T15:00:00.000Z",
            resumen: "Pidió que la llamen mañana a las 10.",
            motivo: null,
            error: null,
          },
        ],
      },
    } satisfies { data: LeadVoicePanelData };
    mocks.voicePanel.mockResolvedValue(panel);
    const response = await POST(request("loadLeadVoicePanel", [id]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual(panel);
    expect(Object.keys(body.data).sort()).toEqual(["calls", "configured", "enabled", "optOut"]);
    expect(mocks.voicePanel).toHaveBeenCalledWith(id);
    // La autorización del lead es la del propio panel (RLS), no la de tiendas.
    expect(mocks.stores).not.toHaveBeenCalled();
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0]);
    expect(log).toEqual({ event: "leads.read", operation: "loadLeadVoicePanel", durationMs: expect.any(Number), authMs: expect.any(Number), totalMs: expect.any(Number) });
  });

  it("passes through the neutral panel of a store whose agent settings cannot be read", async () => {
    // Una tienda ilegible (o pre-0247) deja el agente apagado, no un error:
    // la ruta lo entrega tal cual para que el drawer no muestre un fallo.
    const neutral = { data: { enabled: false, configured: false, optOut: false, calls: [] } } satisfies {
      data: LeadVoicePanelData;
    };
    mocks.voicePanel.mockResolvedValue(neutral);
    const response = await POST(request("loadLeadVoicePanel", [id]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(neutral);
  });

  it("preserves a denied voice panel from the existing RLS authorization", async () => {
    mocks.voicePanel.mockResolvedValue({ error: "Sin acceso a este lead." });
    const response = await POST(request("loadLeadVoicePanel", [id]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: "Sin acceso a este lead." });
  });

  it("does not expose voice panel failures or the lead id", async () => {
    mocks.voicePanel.mockRejectedValue(new Error(`voice_calls de ${id}: TELNYX_LEADS_SIP_URI`));
    const response = await POST(request("loadLeadVoicePanel", [id]));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(id);
    expect(text).not.toContain("TELNYX");
    const logged = String(vi.mocked(console.info).mock.calls[0]![0]);
    expect(logged).not.toContain(id);
    expect(JSON.parse(logged)).toMatchObject({ event: "leads.read", operation: "loadLeadVoicePanel" });
  });

  it.each([
    ["missing session", null, "https://kapta.test", 401],
    ["cross-origin", { id: "advisor" }, "https://other.test", 403],
  ])("rejects voice panel polling with a %s", async (_case, user, origin, status) => {
    mocks.user.mockResolvedValue(user);
    expect((await POST(request("loadLeadVoicePanel", [id], origin))).status).toBe(status);
    expect(mocks.voicePanel).not.toHaveBeenCalled();
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
