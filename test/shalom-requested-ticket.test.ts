import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreShalom } from "@/lib/shalom/session";
import { resolveRequestedShalomTicket, type RequestedShalomTicket } from "@/lib/shalom/requested-ticket";

const remote = vi.hoisted(() => ({ listing: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/shalom/account-match", () => ({ collectListingPages: remote.listing }));
vi.mock("@/lib/shalom/session", () => ({ readWithFreshSession: remote.read, loadStoreShalom: vi.fn() }));

const GUIDE: RequestedShalomTicket = {
  id: "requested", store_id: "kenku", courier: "shalom", guide_code: "102371814", shalom_ose_id: null,
  created_at: "2026-11-01T22:51:56.417Z",
};
const STORE = {} as StoreShalom;
const orders = [{ id: 101, guia: "known-api-guide" }, { id: 202, guia: "102371814" }];

function fakeAdmin(opts: { known?: { guide_code: string; shalom_ose_id: number }[]; knownError?: boolean; writeError?: boolean; race?: "same" | "changed" } = {}) {
  const writes: { patch: unknown; filters: [string, unknown][] }[] = [];
  const from = vi.fn(() => {
    let kind = "known";
    const filters: [string, unknown][] = [];
    const q = {
      select(columns: string) { if (kind !== "write" && columns === "shalom_ose_id") kind = "current"; return q; },
      eq(key: string, value: unknown) { filters.push([key, value]); return q; },
      not() { return q; }, gte() { return q; },
      is(key: string, value: unknown) { filters.push([key, value]); return q; },
      update(patch: unknown) { kind = "write"; writes.push({ patch, filters }); return q; },
      async limit() { return { data: opts.known ?? [{ guide_code: "known-api-guide", shalom_ose_id: 101 }], error: opts.knownError ? { message: "error" } : null }; },
      async maybeSingle() {
        if (kind === "write") return { data: opts.race ? null : { shalom_ose_id: 202 }, error: opts.writeError ? { message: "error" } : null };
        return { data: opts.race === "same" ? { shalom_ose_id: 202 } : null, error: null };
      },
    };
    return q;
  });
  return { admin: { from } as unknown as SupabaseClient, writes, from };
}

beforeEach(() => {
  vi.clearAllMocks();
  remote.listing.mockResolvedValue({ orders, completo: true });
  remote.read.mockImplementation((_admin, _storeId, _store, run) => run({ ordersSince: vi.fn() }));
});

describe("ticket requested for one already-linked Shalom guide", () => {
  it("resolves a reused output older than seven days and writes only the requested identity", async () => {
    const { admin, writes } = fakeAdmin();
    expect(await resolveRequestedShalomTicket(admin, GUIDE, STORE)).toBe(202);
    expect(writes).toEqual([{ patch: { shalom_ose_id: 202 }, filters: [["id", "requested"], ["store_id", "kenku"], ["courier", "shalom"], ["guide_code", "102371814"], ["shalom_ose_id", null]] }]);
    expect(remote.read.mock.calls[0][1]).toBe("kenku");
  });

  it("reuses a known document ID without consulting the account or writing", async () => {
    const { admin, from } = fakeAdmin();
    expect(await resolveRequestedShalomTicket(admin, { ...GUIDE, shalom_ose_id: 303 }, STORE)).toBe(303);
    expect(remote.read).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "no anchor", "contradictory anchor", "duplicate target", "missing target"])("refuses an unsafe listing: %s", async (reason) => {
    const { admin, writes } = fakeAdmin();
    const data = reason === "no anchor" ? orders.slice(1) : reason === "contradictory anchor" ? [{ id: 999, guia: "known-api-guide" }, orders[1]] : reason === "duplicate target" ? [...orders, { id: 888, guia: "102371814" }] : reason === "missing target" ? orders.slice(0, 1) : orders;
    remote.listing.mockResolvedValue({ orders: data, completo: reason !== "incomplete" });
    await expect(resolveRequestedShalomTicket(admin, GUIDE, STORE)).rejects.toThrow();
    expect(writes).toHaveLength(0);
  });

  it("does not serve the old identity if the guide changed during the lookup", async () => {
    const { admin } = fakeAdmin({ race: "changed" });
    await expect(resolveRequestedShalomTicket(admin, GUIDE, STORE)).rejects.toThrow("La guía cambió");
  });

  it("accepts an identical ID saved by a concurrent ticket request", async () => {
    const { admin } = fakeAdmin({ race: "same" });
    expect(await resolveRequestedShalomTicket(admin, GUIDE, STORE)).toBe(202);
  });

  it.each(["knownError", "writeError"] as const)("stops on a database failure: %s", async (field) => {
    const { admin } = fakeAdmin({ [field]: true });
    await expect(resolveRequestedShalomTicket(admin, GUIDE, STORE)).rejects.toThrow();
  });

  it("does not query Shalom for another courier", async () => {
    await expect(resolveRequestedShalomTicket(fakeAdmin().admin, { ...GUIDE, courier: "olva" }, STORE)).rejects.toThrow();
    expect(remote.read).not.toHaveBeenCalled();
  });

  it.each([{ guide_code: null }, { created_at: "invalid" }])("rejects an unidentifiable guide before consulting the account", async (patch) => {
    await expect(resolveRequestedShalomTicket(fakeAdmin().admin, { ...GUIDE, ...patch }, STORE)).rejects.toThrow();
    expect(remote.read).not.toHaveBeenCalled();
  });
});
