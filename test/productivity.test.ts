import { describe, it, expect } from "vitest";
import { computeAdvisorStats, type AdvisorCall } from "@/lib/productivity";

describe("computeAdvisorStats (per-advisor productivity)", () => {
  const emailById = new Map([
    ["u1", "ale@aurela.pe"],
    ["u2", "gaby@aurela.pe"],
  ]);

  it("aggregates activity and credits a win to the LAST caller", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T11:00:00Z" },
      { vendedora: "u2", lead_id: "L1", kind: "call", occurred_at: "2026-06-21T09:00:00Z" }, // later touch on L1
      { vendedora: "u2", lead_id: "L3", kind: "note", occurred_at: "2026-06-21T10:00:00Z" }, // not a "call"
    ];
    const leadOutcome = new Map([
      ["L1", { won: true, net: 189 }], // last caller = u2
      ["L2", { won: false, net: 0 }],
      ["L3", { won: true, net: 99 }], // last caller = u2
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    const u2 = rows.find((r) => r.userId === "u2")!;

    expect(u1.llamadas).toBe(2);
    expect(u1.leadsTrabajados).toBe(2); // L1, L2
    expect(u1.cerrados).toBe(0); // L1 went to u2 (later touch); L2 not won
    expect(u1.ingresos).toBe(0);

    expect(u2.llamadas).toBe(1); // only kind="call"; the note doesn't count
    expect(u2.leadsTrabajados).toBe(2); // L1, L3
    expect(u2.cerrados).toBe(2); // L1 (last touch) + L3
    expect(u2.ingresos).toBe(288); // 189 + 99
    expect(u2.conversion).toBe(1); // 2 / 2
    expect(u2.email).toBe("gaby@aurela.pe");
  });

  it("sorts by revenue desc and ignores calls without a vendedora", () => {
    const calls: AdvisorCall[] = [
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "u2", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T10:00:00Z" },
      { vendedora: "", lead_id: "L3", kind: "system", occurred_at: "2026-06-20T10:00:00Z" },
    ];
    const leadOutcome = new Map([
      ["L1", { won: true, net: 50 }],
      ["L2", { won: true, net: 500 }],
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    expect(rows.map((r) => r.userId)).toEqual(["u2", "u1"]); // u2 has more revenue first
    expect(rows).toHaveLength(2); // the empty-vendedora system row is skipped
  });
});
