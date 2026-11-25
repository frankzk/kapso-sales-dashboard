import { beforeEach, describe, expect, it, vi } from "vitest";
const { routing, server } = vi.hoisted(() => ({ routing: vi.fn(), server: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: server, createAdminSupabase: vi.fn() }));
vi.mock("@/lib/lead-routing-access", async original => ({ ...await original<typeof import("@/lib/lead-routing-access")>(), getLeadRoutingScope: routing }));
vi.mock("@/lib/pending-voucher-access", () => ({ loadPendingVouchers: async () => new Map(), loadPendingVoucherLeads: async () => [], countExtraPendingVoucherLeads: async () => 0 }));
import { getLeadQueueSnapshot, getStoreLeads } from "@/lib/leads-access";
describe("restricted lists and counters use the same server scope", () => {
  const rows = Array.from({ length: 1010 }, (_, i) => ({ id: `lead-${i}`, category: "open", status: "nuevo", store_id: "a" }));
  const counts = { por_llamar: 5, sin_llamar: 5, handoff: 0, yape: 0, seguimientos: 0, ganados: 9, perdidos: 12 };
  beforeEach(() => {
    routing.mockReset(); server.mockReset();
    routing.mockResolvedValue({ enabled: true, blockedIds: rows.slice(0, 1005).map(l => l.id), blocks: ["recuperacion"], allowed: true, signature: "v2", counts });
    server.mockResolvedValue({ from: () => {
      const q: any = {};
      let after: string | null = null;
      let lo: string | null = null;
      let hi: string | null = null;
      for (const method of ["select", "in", "neq", "eq", "order"]) q[method] = () => q;
      q.range = async (from: number, to: number) => ({ data: rows.slice(from, to + 1), count: rows.length, error: null });
      // «Por llamar» se drena por clave (`id > último`) dentro de los cortes de cada tramo de ids
      // (`gte`/`lt`); `rows` va en el orden en que la base las devuelve.
      q.gt = (_column: string, value: string) => { after = value; return q; };
      q.gte = (_column: string, value: string) => { lo = value; return q; };
      q.lt = (_column: string, value: string) => { hi = value; return q; };
      q.limit = async (n: number) => {
        const slice = rows.filter(l => (lo === null || l.id >= lo) && (hi === null || l.id < hi));
        const from = after === null ? 0 : slice.findIndex(l => l.id === after) + 1;
        return { data: slice.slice(from, from + n), error: null };
      };
      return q;
    } });
  });
  it("filters after complete pagination, so eligible leads beyond the first 1,000 survive", async () => {
    const visible = await getStoreLeads(["a"], "por_llamar", 200);
    expect(visible.map(l => l.id).sort()).toEqual(rows.slice(1005).map(l => l.id).sort());
  });
  it("returns the same scoped totals to page load and live polling", async () => {
    const snapshot = await getLeadQueueSnapshot(["a"]);
    expect(snapshot.counts).toEqual(counts);
    expect(snapshot.signature).toContain("routing:v2");
  });
  it("keeps the scope signature's trailing minute, so changes outside the open/hot queue still reload within the quiet window", async () => {
    // lead_routing_scope signs `max(updated_at)|revision|md5(blocked)|minute` over
    // open/hot leads only; a bot handoff on a won lead moves none of the first
    // three. Only the minute makes the board notice it before the forced reload.
    routing.mockResolvedValue({ enabled: true, blockedIds: [], blocks: [], allowed: true, signature: "2026-11-06 20:00:00+00|3|abc|29876543", counts });
    const a = await getLeadQueueSnapshot(["a"]);
    routing.mockResolvedValue({ enabled: true, blockedIds: [], blocks: [], allowed: true, signature: "2026-11-06 20:00:00+00|3|abc|29876544", counts });
    const b = await getLeadQueueSnapshot(["a"]);
    expect(a.signature).toBe("routing:2026-11-06 20:00:00+00|3|abc|29876543:cv:");
    expect(b.signature).not.toBe(a.signature);
  });
  // Owner, 25-11-2026: «es clave el tiempo de carga del sistema». La cola no espera al reparto para empezar a
  // leerse; el reparto sigue decidiendo qué se devuelve.
  it("starts reading the whole queue before the routing answer, and still filters by it", async () => {
    let answer: (scope: unknown) => void = () => undefined;
    routing.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const pending = getStoreLeads(["a"], "por_llamar", null);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    // La lectura de la cola termina sola; la función no devuelve nada hasta saber el reparto.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    answer({ enabled: true, blockedIds: rows.slice(0, 1005).map(l => l.id), blocks: ["recuperacion"], allowed: true, signature: "v2", counts });
    expect((await pending).map(l => l.id).sort()).toEqual(rows.slice(1005).map(l => l.id).sort());
  });
  it("with a view limit the queue is not read ahead of the routing answer", async () => {
    let answer: (scope: unknown) => void = () => undefined;
    routing.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const reads: string[] = [];
    const client = await server();
    server.mockResolvedValue({ from: (table: string) => { reads.push(table); return client.from(table); } });
    const pending = getStoreLeads(["a"], "por_llamar", 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toEqual([]);
    answer({ enabled: true, blockedIds: [], blocks: [], allowed: true, signature: "v2", counts });
    expect(await pending).toHaveLength(200);
    expect(reads.length).toBeGreaterThan(0);
  });
  it("cannot fall back to the global queue when the routing read fails", async () => {
    routing.mockRejectedValue(new Error("unavailable"));
    await expect(getStoreLeads(["a"], "por_llamar", null)).rejects.toThrow("unavailable");
    await expect(getLeadQueueSnapshot(["a"])).rejects.toThrow("unavailable");
  });
});
