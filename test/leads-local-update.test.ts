import { describe, expect, it } from "vitest";
import { leadMembership, patchLeadCounts, patchLeadRows } from "@/lib/leads-local-update";
import { decideQueueRefresh } from "@/lib/leads-live-refresh";
import type { LeadRow } from "@/lib/types";

const now = Date.parse("2026-10-01T19:00:00Z");
const lead = { id: "a", store_id: "store-a", category: "open", status: "nuevo", needs_attention: true,
  handoff_at: new Date(now - 1000).toISOString(), next_followup_at: null } as LeadRow;
const counts = { por_llamar: 6830, sin_llamar: 3000, handoff: 5, yape: 8, seguimientos: 20, ganados: 100, perdidos: 200 };

describe("confirmed call reconciliation", () => {
  it("moves a new lead to follow-up without changing other stores or mutating the original", () => {
    const other = { ...lead, id: "b", store_id: "store-b" };
    const patch = { status: "no_responde", needs_attention: false };
    const rows = patchLeadRows([lead, other], "a", patch, "por_llamar");
    expect(rows[0]?.status).toBe("no_responde");
    expect(rows[1]).toBe(other);
    expect(lead.status).toBe("nuevo");
    expect(patchLeadCounts(counts, lead, patch, now)).toEqual({ ...counts, sin_llamar: 2999, handoff: 4 });
  });
  it("removes a lost lead from the queue but retains it in global search", () => {
    const patch = { status: "cancelado_cliente", category: "lost" as const, needs_attention: false };
    expect(patchLeadRows([lead], "a", patch, "por_llamar")).toEqual([]);
    expect(patchLeadRows([lead], "a", patch)).toHaveLength(1);
    expect(patchLeadCounts(counts, lead, patch, now)).toEqual({ ...counts, por_llamar: 6829, sin_llamar: 2999, handoff: 4, perdidos: 201 });
  });
  it("updates Yape and due-follow-up membership", () => {
    const yape = { ...lead, status: "yape_por_verificar", category: "hot" as const, next_followup_at: new Date(now - 1000).toISOString() };
    const patch = { status: "volver_a_llamar", category: "open" as const, needs_attention: false, next_followup_at: new Date(now + 3600000).toISOString() };
    expect(patchLeadRows([yape], "a", patch, "yape")).toEqual([]);
    expect(patchLeadCounts(counts, yape, patch, now)).toEqual({ ...counts, por_llamar: 6831, yape: 7, handoff: 4, seguimientos: 19 });
  });
  it("adds a lead opened from search when it enters the current view, without duplicates", () => {
    const yape = { ...lead, status: "yape_por_verificar", category: "hot" as const };
    const patch = { status: "no_responde", category: "open" as const, needs_attention: false };
    const rows = patchLeadRows([], "a", patch, "por_llamar", yape);
    expect(rows).toHaveLength(1);
    expect(patchLeadRows(rows, "a", patch, "por_llamar", yape)).toHaveLength(1);
    expect(patchLeadRows([], "a", patch, "ganados", yape)).toEqual([]);
  });
  it("does not change counts for a note-only save or repeat disposition", () => {
    expect(patchLeadCounts(counts, lead, { last_interaction_at: new Date(now).toISOString() }, now)).toEqual(counts);
    const called = { ...lead, status: "no_responde", needs_attention: false };
    expect(patchLeadCounts(counts, called, { status: "no_responde", needs_attention: false }, now)).toEqual(counts);
  });
  it("matches the inclusive SQL time boundaries and category predicates", () => {
    const boundary = { ...lead, handoff_at: new Date(now - 24 * 3600000).toISOString(), next_followup_at: new Date(now).toISOString() };
    expect(leadMembership(boundary, now)).toMatchObject({ handoff: 1, seguimientos: 1, sin_llamar: 1 });
    expect(leadMembership(boundary, now + 1).handoff).toBe(0);
    expect(leadMembership({ ...lead, category: "won" }, now)).toMatchObject({ ganados: 1, por_llamar: 0, sin_llamar: 0 });
  });
  it("does not refresh for its own resolved handoff but detects another advisor's urgent change", () => {
    const adjusted = patchLeadCounts(counts, lead, { needs_attention: false }, now);
    const input = { prevSignature: "before", nextSignature: "after", prevCounts: adjusted, nextCounts: adjusted, lastRefreshAt: now, now: now + 30000 };
    expect(decideQueueRefresh(input)).toBe("skip");
    expect(decideQueueRefresh({ ...input, nextCounts: { ...adjusted, handoff: adjusted.handoff + 1 } })).toBe("urgent");
    expect(decideQueueRefresh({ ...input, now: now + 120000 })).toBe("quiet");
  });
});
