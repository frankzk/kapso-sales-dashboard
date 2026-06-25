import { describe, it, expect } from "vitest";
import { leadWindowInfo, countLeadWindows } from "@/lib/leads";

const H = 3_600_000;
const now = 1_700_000_000_000; // fixed nowMs

const inboundHoursAgo = (h: number) => new Date(now - h * H).toISOString();

describe("leadWindowInfo (24h session window)", () => {
  it("buckets by time left (≤6h por_vencer, ≤2h crítica, >24h cerrada)", () => {
    expect(leadWindowInfo(inboundHoursAgo(2), now).state).toBe("fresca"); // 22h left
    expect(leadWindowInfo(inboundHoursAgo(17), now).state).toBe("fresca"); // 7h left
    expect(leadWindowInfo(inboundHoursAgo(20), now).state).toBe("por_vencer"); // 4h left
    expect(leadWindowInfo(inboundHoursAgo(23), now).state).toBe("critica"); // 1h left
    expect(leadWindowInfo(inboundHoursAgo(30), now).state).toBe("cerrada"); // past 24h
    expect(leadWindowInfo(null, now).state).toBeNull();
  });

  it("reports remaining ms while open", () => {
    const { msLeft } = leadWindowInfo(inboundHoursAgo(20), now);
    expect(Math.round((msLeft ?? 0) / H)).toBe(4);
  });
});

describe("countLeadWindows", () => {
  it("groups ≤6h (incl. crítica) as por_vencer; falls back to last_interaction_at", () => {
    const leads = [
      { last_inbound_at: inboundHoursAgo(2) }, // fresca
      { last_inbound_at: inboundHoursAgo(20) }, // por_vencer
      { last_inbound_at: inboundHoursAgo(23) }, // crítica → por_vencer bucket
      { last_inbound_at: inboundHoursAgo(30) }, // cerrada
      { last_inbound_at: null, last_interaction_at: inboundHoursAgo(21) }, // fallback → por_vencer
    ];
    const c = countLeadWindows(leads, now);
    expect(c.a_tiempo).toBe(1);
    expect(c.por_vencer).toBe(3);
    expect(c.cerrada).toBe(1);
  });
});
