import { describe, expect, it } from "vitest";
import { pickDistributedLead, validStoreWeights, PRIORITY_DISTRIBUTION } from "@/lib/lead-store-distribution";
import { parseLeadRouting } from "@/lib/lead-routing";
const a = "00000000-0000-0000-0000-000000000001", b = "00000000-0000-0000-0000-000000000002";
const now = new Date("2026-11-12T18:00:00Z");
const row = (id: string, store_id: string) => ({ id, store_id, status: "nuevo", claimed_by: null as string | null, claimed_at: null as string | null, call_queue_ready: false, next_followup_at: null as string | null });
const queue = [row("b1", b), row("a1", a), row("a2", a), row("b2", b)];
const options = { userId: "advisor", now };
const mix = { weights: { [a]: 80, [b]: 20 }, completed: {} as Record<string, number> };
describe("automatic store distribution", () => {
  it("leaves everyone on priority by default and does not mutate the list", () => {
    expect(pickDistributedLead(queue, options, PRIORITY_DISTRIBUTION)?.id).toBe("b1");
    expect(queue.map(r => r.id)).toEqual(["b1", "a1", "a2", "b2"]);
  });
  it("paces eight of ten real completed leads to Aurela; opening or skipping is not a completed management", () => {
    const state = structuredClone(mix);
    const selected: string[] = [];
    for (let i = 0; i < 10; i++) {
      const lead = pickDistributedLead(queue, options, state)!;
      // Opening again leaves both the counts and the decision intact.
      expect(pickDistributedLead(queue, options, state)).toEqual(lead);
      selected.push(lead.store_id);
      state.completed[lead.store_id] = (state.completed[lead.store_id] ?? 0) + 1;
    }
    expect(selected.filter(id => id === a)).toHaveLength(8);
    expect(selected.filter(id => id === b)).toHaveLength(2);
  });
  it("keeps priority within each store and skips other reservations without stealing", () => {
    expect(pickDistributedLead(queue, options, mix)?.id).toBe("a1");
    const claimed = queue.map(r => r.id === "a1" ? { ...r, claimed_by: "other", claimed_at: now.toISOString() } : r);
    expect(pickDistributedLead(claimed, options, mix)?.id).toBe("a2");
    expect(pickDistributedLead(queue, { ...options, skipped: new Set(["a1"]) }, mix)?.id).toBe("a2");
  });
  it("honors the current reservation even when the store target changes", () => {
    expect(pickDistributedLead(queue, { ...options, current: "b2" }, mix)?.id).toBe("b2");
  });
  it("takes an overdue agreed appointment first, not a future appointment", () => {
    const appointment = { ...row("due", b), call_queue_ready: true, next_followup_at: "2026-11-12T17:00:00Z" };
    expect(pickDistributedLead([...queue, appointment], options, mix)?.id).toBe("due");
    expect(pickDistributedLead([...queue, { ...appointment, next_followup_at: "2026-11-12T19:00:00Z" }], options, mix)?.id).toBe("a1");
  });
  it("falls back when preferred stores have no free eligible leads, including a single-store filter", () => {
    expect(pickDistributedLead(queue.filter(r => r.store_id === b), options, mix)?.id).toBe("b1");
    expect(pickDistributedLead(queue.filter(r => r.store_id === b), options, { ...mix, weights: { [a]: 100, [b]: 0 } })?.id).toBe("b1");
    expect(pickDistributedLead(queue.map(r => ({ ...r, status: "pedido_generado" })), options, mix)).toBeNull();
  });
  it("corrects a day's deficit and accepts generic store counts", () => {
    expect(pickDistributedLead(queue, options, { ...mix, completed: { [a]: 8, [b]: 0 } })?.store_id).toBe(b);
    expect(pickDistributedLead(queue, options, { ...mix, completed: { [a]: 0, [b]: 8 } })?.store_id).toBe(a);
  });
});
describe("routing configuration percentages", () => {
  const config = (storeWeights: unknown) => ({ enabled: true, freshHours: 24, assignments: [{ userId: a, blocks: ["carrito_reciente"], backup: false, storeWeights }] });
  it("supports explicit priority and custom targets with legacy optional fields", () => {
    expect(parseLeadRouting(config(null))?.assignments[0]?.storeWeights).toBeNull();
    expect(parseLeadRouting(config(mix.weights))?.assignments[0]?.storeWeights).toEqual(mix.weights);
    expect(parseLeadRouting(config(undefined))?.assignments[0]).not.toHaveProperty("storeWeights");
  });
  it.each([{}, [], { [a]: 80 }, { [a]: -1, [b]: 101 }, { [a]: 79.5, [b]: 20.5 }, { [a]: "80", [b]: 20 }, { x: 100 }])("rejects invalid weights %j", value => {
    expect(validStoreWeights(value)).toBe(false);
    expect(parseLeadRouting(config(value))).toBeNull();
  });
});
