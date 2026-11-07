import { describe, expect, it, vi } from "vitest";
import { YAPE_RECONCILE_MIN_MS, claimYapeReconcileTick } from "@/lib/yape-reconcile-tick";

const client = (result: unknown) => ({ rpc: vi.fn(async () => result) }) as never;

describe("claimYapeReconcileTick (una pestaña por tienda reconcilia, 0312)", () => {
  it("asks the RPC with the store and the minimum gap in seconds", async () => {
    const admin = client({ data: true, error: null }) as unknown as { rpc: ReturnType<typeof vi.fn> };
    expect(await claimYapeReconcileTick(admin as never, "store-1")).toBe(true);
    expect(admin.rpc).toHaveBeenCalledWith("claim_yape_reconcile_tick", { p_store: "store-1", p_min_seconds: YAPE_RECONCILE_MIN_MS / 1000 });
    expect(YAPE_RECONCILE_MIN_MS).toBeLessThan(15_000); // a lone tab (15 s poll) always wins its tick
  });

  it("skips when another tab already reconciled this store", async () => {
    expect(await claimYapeReconcileTick(client({ data: false, error: null }), "s")).toBe(false);
  });

  it("reconciles as before when the migration is missing or the call fails", async () => {
    expect(await claimYapeReconcileTick(client({ data: null, error: { code: "PGRST202" } }), "s")).toBe(true);
    expect(await claimYapeReconcileTick({ rpc: async () => { throw new Error("down"); } } as never, "s")).toBe(true);
  });
});
