import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), access: vi.fn(), current: vi.fn(), order: vi.fn(), insert: vi.fn(), update: vi.fn(), revalidate: vi.fn(), insertResult: {} as unknown, updateResult: {} as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: vi.fn(), resolveAgentNames: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({ auth: { getClaims: mocks.claims }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.access }) }) }) }),
  createAdminSupabase: () => ({ from: (table: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: table === "orders" ? mocks.order : table === "stores" ? async () => ({ data: { timezone: "America/Lima" } }) : mocks.current }) }),
    insert: (payload: unknown) => { mocks.insert(payload); return { select: () => ({ single: async () => mocks.insertResult }) }; },
    update: (patch: unknown) => { mocks.update(patch); return { eq: async () => mocks.updateResult }; },
  }) }),
}));
// Mutable results let us cover partial-write failures without any live database.
const state = mocks as typeof mocks & { insertResult: unknown; updateResult: unknown };
import { registerCall } from "@/app/dashboard/leads/actions";

function form(status = "no_responde") {
  const data = new FormData();
  data.set("lead_id", "synthetic-lead"); data.set("status", status); data.set("note", "private test note");
  return data;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.claims.mockResolvedValue({ data: { claims: { sub: "advisor" } } });
  mocks.access.mockResolvedValue({ data: { store_id: "store" } });
  mocks.current.mockResolvedValue({ data: { category: "open", has_order: false, next_followup_at: null } });
  state.insertResult = { data: { id: "call", lead_id: "synthetic-lead" }, error: null };
  state.updateResult = { error: null };
});
afterEach(() => vi.restoreAllMocks());

describe("call save without queue revalidation", () => {
  it("returns the confirmed call and patch without rendering the board or logging private data", async () => {
    const result = await registerCall({}, form());
    expect(result).toMatchObject({ savedCall: { id: "call" }, leadPatch: { status: "no_responde", category: "open", needs_attention: false } });
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![0])).toEqual({ event: "leads.call.save", outcome: "success", durationMs: expect.any(Number), commit: "local" });
  });
  it("rejects inaccessible leads before privileged writes", async () => {
    mocks.access.mockResolvedValue({ data: null });
    expect((await registerCall({}, form())).error).toBeTruthy();
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects invalid states and unauthenticated requests", async () => {
    expect((await registerCall({}, form("invalid"))).error).toBeTruthy();
    mocks.claims.mockResolvedValue({ data: null });
    await expect(registerCall({}, form())).rejects.toThrow("redirect:/login");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("still protects a won lead with an active order", async () => {
    mocks.current.mockResolvedValue({ data: { category: "won", has_order: true, order_id: "order" } });
    mocks.order.mockResolvedValue({ data: { name: "test-order", cancelled_at: null } });
    expect((await registerCall({}, form())).error).toContain("pedido activo");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("keeps automatic follow-ups and note-only calls", async () => {
    expect((await registerCall({}, form("volver_a_llamar"))).leadPatch?.next_followup_at).toBeTruthy();
    const noteOnly = await registerCall({}, form(""));
    expect(noteOnly.savedCall).toBeTruthy(); expect(noteOnly.leadPatch).not.toHaveProperty("status");
  });
  it.each(["insertResult", "updateResult"] as const)("does not report success on %s failure", async (key) => {
    state[key] = { error: { message: "synthetic failure" } };
    const result = await registerCall({}, form());
    expect(result.error).toBeTruthy(); expect(result.savedCall).toBeUndefined();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
