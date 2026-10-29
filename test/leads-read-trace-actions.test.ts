import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), creds: vi.fn(), history: vi.fn(), lead: vi.fn(), name: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: mocks.name, resolveAgentNames: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: mocks.creds }));
vi.mock("@/lib/access", () => ({ getWaNumbers: async () => ({}) }));
vi.mock("@/lib/leads-access", () => ({ getCustomerHistory: mocks.history }));
vi.mock("@/lib/whatsapp-outbox", () => ({ listLeadWhatsappOutbox: async () => [], mergeTranscriptWithOutbox: (messages: unknown[]) => messages }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: "test-advisor" } } }) }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.access }) }) }) }),
  createAdminSupabase: () => ({ from: () => {
    const q: any = { select: () => q, update: () => q, eq: () => q, gt: () => q, maybeSingle: mocks.lead };
    return q;
  } }),
}));
import { loadLeadConversation, loadLeadCustomerHistory, pollLeadState, renewLeadClaim } from "@/app/dashboard/leads/actions";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.access.mockResolvedValue({ data: { store_id: "test-store", phone: "51999888777", kapso_conversation_id: "test-thread", wa_phone_number_id: "test-number" } });
  mocks.lead.mockResolvedValue({ data: { phone: "51999888777", order_id: null, source: "organic", cart_summary: null } });
  mocks.creds.mockResolvedValue({ kapso_api_key: "test-secret", shopify_domain: "shop.test", shopify_token: "shop-secret" });
  mocks.history.mockResolvedValue({ currentOrderId: null, currentOrderName: null, recentOrders: [] });
  mocks.name.mockResolvedValue("Tania");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const metric = () => JSON.parse(vi.mocked(console.info).mock.calls.at(-1)![0]);

describe("pérdida de reserva confirmada", () => {
  const fresh = () => new Date().toISOString();
  const old = () => new Date(Date.now() - 11 * 60_000).toISOString();
  const state = { has_order: false, status: "pendiente", category: "nuevo" };
  it("el sondeo identifica a la otra asesora sin renovar ni tomar su reserva", async () => {
    mocks.access.mockResolvedValueOnce({ data: { store_id: "store" } }).mockResolvedValueOnce({ data: { ...state, claimed_by: "tania", claimed_at: fresh() } });
    expect(await pollLeadState("lead")).toMatchObject({ claimLost: true, claimError: "Tania está atendiendo este lead." });
    expect(mocks.name).toHaveBeenCalledWith("tania", expect.anything());
  });
  it.each(["test-advisor", null])("la reserva propia o libre no inventa un conflicto: %s", async (owner) => {
    mocks.access.mockResolvedValueOnce({ data: { store_id: "store" } }).mockResolvedValueOnce({ data: { ...state, claimed_by: owner, claimed_at: fresh() } });
    expect(await pollLeadState("lead")).toEqual({ hasOrder: false, status: "pendiente", category: "nuevo" });
  });
  it("una reserva ajena vencida no se presenta como vigente", async () => {
    mocks.access.mockResolvedValueOnce({ data: { store_id: "store" } }).mockResolvedValueOnce({ data: { ...state, claimed_by: "tania", claimed_at: old() } });
    expect(await pollLeadState("lead")).not.toHaveProperty("claimLost");
  });
  it("un fallo de lectura no cierra una ficha ni inventa un cambio de dueña", async () => {
    mocks.access.mockResolvedValueOnce({ data: { store_id: "store" } }).mockResolvedValueOnce({ data: null, error: { message: "offline" } });
    const result = await pollLeadState("lead");
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("claimLost");
  });
  it("la renovación comunica la pérdida para cerrar la ficha anterior", async () => {
    mocks.lead.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: { claimed_by: "tania", claimed_at: fresh() }, error: null });
    expect(await renewLeadClaim("lead")).toMatchObject({ claimLost: true, error: expect.stringContaining("Tania tomó este lead") });
  });
  it("si falla comprobar la renovación no se interpreta como reserva vencida", async () => {
    mocks.lead.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { message: "offline" } });
    expect(await renewLeadClaim("lead")).toEqual({ error: "No se pudo comprobar la reserva del lead. Intenta nuevamente." });
  });
  it("una reserva vencida propia sí cierra la ficha y exige volver a abrirla", async () => {
    mocks.lead.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: { claimed_by: "test-advisor", claimed_at: old() }, error: null });
    expect(await renewLeadClaim("lead")).toHaveProperty("claimLost", true);
  });
  it("una renovación de otra pestaña propia no se interpreta como pérdida", async () => {
    mocks.lead.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: { claimed_by: "test-advisor", claimed_at: fresh() }, error: null });
    expect(await renewLeadClaim("lead")).toEqual({ notice: "Reserva vigente." });
  });
  it("sin acceso al lead no consulta su dueño ni expone el nombre", async () => {
    mocks.access.mockResolvedValueOnce({ data: null });
    expect(await pollLeadState("denied")).toEqual({ error: "Sin acceso a este lead." });
    expect(mocks.name).not.toHaveBeenCalled();
  });
  it("cierra por pérdida confirmada aunque falle resolver el nombre", async () => {
    mocks.access.mockResolvedValueOnce({ data: { store_id: "store" } }).mockResolvedValueOnce({ data: { ...state, claimed_by: "tania", claimed_at: fresh() } });
    mocks.name.mockRejectedValueOnce(new Error("offline"));
    expect(await pollLeadState("lead")).toMatchObject({ claimLost: true, claimError: "Otra asesora está atendiendo este lead." });
    expect(mocks.lead).not.toHaveBeenCalled();
  });
});

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
