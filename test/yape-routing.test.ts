import { describe, it, expect } from "vitest";
import { planYapeOffers, type RoutingAdvisor, type RoutingLead } from "@/lib/yape-routing";

const NOW = 1_000_000;
const online = (id: string, agoMs = 0): RoutingAdvisor => ({ id, lastSeenMs: NOW - agoMs });
const lead = (id: string, over: Partial<RoutingLead> = {}): RoutingLead => ({
  id,
  claimedBy: null,
  offeredTo: null,
  offeredAtMs: null,
  passed: [],
  ...over,
});

describe("planYapeOffers", () => {
  it("offers a new Yape to the least-loaded advisor", () => {
    // N=4 → cap=floor(2.4)=2, so neither A nor B is capped; A holds 1, B holds 0.
    const leads = [
      lead("c1", { claimedBy: "A" }),
      lead("c2", { claimedBy: "X" }),
      lead("c3", { claimedBy: "Y" }),
      lead("new"),
    ];
    const plans = planYapeOffers(leads, [online("A"), online("B")], NOW);
    expect(plans).toEqual([{ leadId: "new", offeredTo: "B", passed: [] }]);
  });

  it("breaks ties by most-recently-active", () => {
    const plans = planYapeOffers([lead("new")], [online("A", 10_000), online("B", 1_000)], NOW);
    expect(plans[0]).toMatchObject({ leadId: "new", offeredTo: "B" });
  });

  it("respects the 60% cap (an advisor can't hoard active Yapes)", () => {
    // N=5 → cap=3. A already holds 3 (at cap); the 2 new ones must go to B.
    const leads = [
      lead("a1", { claimedBy: "A" }),
      lead("a2", { claimedBy: "A" }),
      lead("a3", { claimedBy: "A" }),
      lead("n1"),
      lead("n2"),
    ];
    const plans = planYapeOffers(leads, [online("A"), online("B")], NOW);
    expect(plans.every((p) => p.offeredTo === "B")).toBe(true);
    expect(plans.map((p) => p.leadId).sort()).toEqual(["n1", "n2"]);
  });

  it("relaxes the cap when every candidate is already capped (never stuck)", () => {
    // Only A online and already holding 1 (cap=1) — she still gets the new one.
    const leads = [lead("a1", { claimedBy: "A" }), lead("new")];
    const plans = planYapeOffers(leads, [online("A")], NOW);
    expect(plans).toEqual([{ leadId: "new", offeredTo: "A", passed: [] }]);
  });

  it("distributes several simultaneous Yapes across advisors (repartir)", () => {
    const plans = planYapeOffers([lead("n1"), lead("n2")], [online("A"), online("B")], NOW);
    const byLead = Object.fromEntries(plans.map((p) => [p.leadId, p.offeredTo]));
    expect(byLead.n1).not.toBe(byLead.n2); // not both to the same advisor
    expect(new Set(Object.values(byLead))).toEqual(new Set(["A", "B"]));
  });

  it("loops infinitely: once everyone passed, the lap resets and it re-offers", () => {
    // Offer to A expired; B already passed → both online have passed → reset.
    const leads = [lead("L", { offeredTo: "A", offeredAtMs: NOW - 100_000, passed: ["B"] })];
    const plans = planYapeOffers(leads, [online("A"), online("B")], NOW);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.passed).toEqual([]); // lap reset
    expect(["A", "B"]).toContain(plans[0]!.offeredTo); // re-offered, never dropped
  });

  it("escalates an expired offer to the next advisor (offered one joins passed)", () => {
    const leads = [lead("L", { offeredTo: "A", offeredAtMs: NOW - 100_000, passed: [] })];
    const plans = planYapeOffers(leads, [online("A"), online("B")], NOW);
    expect(plans[0]).toMatchObject({ leadId: "L", offeredTo: "B" });
    expect(plans[0]!.passed).toContain("A");
  });

  it("leaves claimed and still-fresh-offer leads untouched", () => {
    const leads = [
      lead("claimed", { claimedBy: "A" }),
      lead("fresh", { offeredTo: "B", offeredAtMs: NOW - 1_000 }),
    ];
    expect(planYapeOffers(leads, [online("A"), online("B")], NOW)).toEqual([]);
  });

  it("offers nothing when no advisor is online", () => {
    expect(planYapeOffers([lead("new")], [online("A", 100_000)], NOW)).toEqual([]);
  });
});
