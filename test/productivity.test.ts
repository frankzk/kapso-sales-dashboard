import { describe, it, expect } from "vitest";
import { attachDeltas, computeAdvisorStats, type AdvisorCall, type AdvisorStat } from "@/lib/productivity";

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

  it("infers active hours by local day, splitting blocks on idle gaps >45min", () => {
    const calls: AdvisorCall[] = [
      // Day 1 (Lima 2026-06-20): one block 09:00→10:00 = 1h
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T14:00:00Z" },
      { vendedora: "u1", lead_id: "L1", kind: "call", occurred_at: "2026-06-20T14:30:00Z" },
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T15:00:00Z" },
      // …then a 2h idle gap → new block 12:00→12:30 = 0.5h
      { vendedora: "u1", lead_id: "L2", kind: "call", occurred_at: "2026-06-20T17:00:00Z" },
      { vendedora: "u1", lead_id: "L3", kind: "call", occurred_at: "2026-06-20T17:30:00Z" },
      // Day 2 (Lima 2026-06-21): a single action → 0h but still a worked day
      { vendedora: "u1", lead_id: "L4", kind: "call", occurred_at: "2026-06-21T15:00:00Z" },
    ];
    const leadOutcome = new Map([
      ["L1", { won: false, net: 0 }],
      ["L2", { won: false, net: 0 }],
      ["L3", { won: false, net: 0 }],
      ["L4", { won: false, net: 0 }],
    ]);
    const rows = computeAdvisorStats({ calls, leadOutcome, emailById });
    const u1 = rows.find((r) => r.userId === "u1")!;
    expect(u1.horas).toBeCloseTo(1.5); // 1h + 0.5h; the day-2 singleton adds 0
    expect(u1.dias).toBe(2);
  });

  it("attachDeltas computes per-advisor deltas, flags newcomers, and rolls up prev totals", () => {
    const mk = (o: Partial<AdvisorStat> & { userId: string }): AdvisorStat => ({
      email: o.userId,
      llamadas: 0,
      leadsTrabajados: 0,
      cerrados: 0,
      ingresos: 0,
      conversion: 0,
      horas: 0,
      dias: 0,
      ...o,
    });
    const cur = [
      mk({ userId: "u1", llamadas: 10, leadsTrabajados: 8, cerrados: 5, ingresos: 1200, conversion: 0.625 }),
      mk({ userId: "u2", llamadas: 4, leadsTrabajados: 4, cerrados: 1, ingresos: 200, conversion: 0.25 }), // new
    ];
    const prev = [
      mk({ userId: "u1", llamadas: 8, leadsTrabajados: 6, cerrados: 3, ingresos: 900, conversion: 0.5 }),
      mk({ userId: "u3", llamadas: 2, leadsTrabajados: 2, cerrados: 0, ingresos: 0, conversion: 0 }), // dropped
    ];
    const { rows, prevTotals } = attachDeltas(cur, prev);

    const u1 = rows.find((r) => r.userId === "u1")!;
    expect(u1.delta).toMatchObject({ llamadas: 2, cerrados: 2, ingresos: 300, isNew: false });
    expect(u1.delta.conversionPP).toBeCloseTo(12.5); // 62.5% − 50%

    const u2 = rows.find((r) => r.userId === "u2")!;
    expect(u2.delta.isNew).toBe(true); // no baseline last period
    expect(u2.delta.ingresos).toBe(200); // vs 0

    // prev totals include the dropped advisor (u3), not the current-only one (u2)
    expect(prevTotals).toMatchObject({ llamadas: 10, leadsTrabajados: 8, cerrados: 3, ingresos: 900 });
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
