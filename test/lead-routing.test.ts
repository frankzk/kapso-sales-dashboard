import { describe, expect, it } from "vitest";
import { LEAD_WORK_BLOCKS, PRINCIPAL_BLOCKS, parseLeadRouting, routingCoverage, routingLabel } from "@/lib/lead-routing";
const userId = "00000000-0000-0000-0000-000000000001";
const otherId = "00000000-0000-0000-0000-000000000002";
const principal = { userId, blocks: [...PRINCIPAL_BLOCKS], backup: false };
const recovery = { userId: otherId, blocks: ["recuperacion" as const], backup: false };
describe("team work allocation", () => {
  it("accepts multi-block assignment and keeps backup separate", () => {
    expect(parseLeadRouting({ enabled: true, freshHours: 24, assignments: [principal, recovery] })?.assignments).toEqual([principal, recovery]);
    expect(routingLabel(principal.blocks)).toBe("Principal");
    expect(routingLabel(recovery.blocks)).toBe("Recuperación");
  });
  it.each([0, 169, 24.5, NaN])("rejects an unusable freshness window %s", freshHours => {
    expect(parseLeadRouting({ enabled: true, freshHours, assignments: [] })).toBeNull();
  });
  it("rejects duplicate people, arbitrary blocks and non-boolean fallback", () => {
    for (const assignments of [[principal, principal], [{ ...principal, blocks: ["inventado"] }], [{ ...principal, backup: "true" }], [{ ...principal, blocks: ["recuperacion", "recuperacion"] }]]) {
      expect(parseLeadRouting({ enabled: true, freshHours: 24, assignments })).toBeNull();
    }
  });
  it("requires explicit store access for every block, including recovery", () => {
    const advisors = [{ userId, stores: ["a", "b"] }, { userId: otherId, stores: ["a"] }];
    expect(routingCoverage([principal, recovery], advisors, ["a", "b"])).toEqual([{ storeId: "b", block: "recuperacion" }]);
    expect(routingCoverage([principal, recovery], advisors.map(a => ({ ...a, stores: ["a", "b"] })), ["a", "b"])).toEqual([]);
  });
  it("backup alone cannot conceal an uncovered block", () => {
    expect(routingCoverage([{ userId, blocks: [], backup: true }], [{ userId, stores: ["a"] }], ["a"])).toHaveLength(LEAD_WORK_BLOCKS.length);
  });
});
