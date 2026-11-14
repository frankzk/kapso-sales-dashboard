import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dailyLeadList, dailyListSummary, dailyQuotas } from "@/lib/lead-daily-list";
import { parseLeadRouting, validDailyCapacity } from "@/lib/lead-routing";

const aurela = "00000000-0000-0000-0000-00000000000a", kenku = "00000000-0000-0000-0000-00000000000b";
const ranked = (pattern: string) => [...pattern].map((c, i) => ({ id: `${c}${i}`, store_id: c === "A" ? aurela : kenku }));
const read = (p: string) => readFileSync(p, "utf8");

describe("la lista del día (Leads por día)", () => {
  it("reparte 250 con 90/10 en 225 Aurela y 25 Kenku", () => {
    expect(dailyQuotas(250, { [aurela]: 90, [kenku]: 10 })).toEqual({ [aurela]: 225, [kenku]: 25 });
    expect(dailyQuotas(7, { [aurela]: 50, [kenku]: 50 })).toEqual({ [aurela]: 4, [kenku]: 3 });
  });

  it("toma los primeros de cada tienda en orden de prioridad", () => {
    const rows = ranked("KKKAAAAAAAAAAK"); // 10 Aurela, 4 Kenku
    const ids = dailyLeadList(rows, { capacity: 10, weights: { [aurela]: 90, [kenku]: 10 } });
    expect(ids.size).toBe(10);
    expect(rows.filter((r) => ids.has(r.id) && r.store_id === kenku).map((r) => r.id)).toEqual(["K0"]);
    expect(rows.filter((r) => ids.has(r.id) && r.store_id === aurela)).toHaveLength(9);
  });

  it("si Aurela no alcanza, completa con Kenku (los siguientes más prioritarios)", () => {
    const rows = ranked("KAKKAKKKKK"); // 2 Aurela, 8 Kenku
    const ids = dailyLeadList(rows, { capacity: 5, weights: { [aurela]: 90, [kenku]: 10 } });
    expect([...ids].sort()).toEqual(["A1", "A4", "K0", "K2", "K3"].sort());
  });

  it("sin porcentajes, los N más prioritarios; con menos leads que la capacidad, todos", () => {
    const rows = ranked("KAKA");
    expect([...dailyLeadList(rows, { capacity: 2, weights: null })]).toEqual(["K0", "A1"]);
    expect(dailyLeadList(rows, { capacity: 250, weights: { [aurela]: 90, [kenku]: 10 } }).size).toBe(4);
    expect(dailyLeadList(rows, { capacity: 0, weights: null }).size).toBe(0);
  });

  it("resume la lista por tienda", () => {
    const names = new Map([[aurela, "Aurela"], [kenku, "Kenku Peru"]]);
    expect(dailyListSummary(ranked("AAK"), names)).toBe("Tu lista del día: 3 · 2 Aurela · 1 Kenku Peru");
  });

  it("valida «Leads por día» entre 1 y 1000 (o vacío)", () => {
    expect(validDailyCapacity(null)).toBe(true);
    expect(validDailyCapacity(250)).toBe(true);
    expect(validDailyCapacity(0)).toBe(false);
    expect(validDailyCapacity(1001)).toBe(false);
    expect(validDailyCapacity(2.5)).toBe(false);
    const base = { enabled: true, freshHours: 24 };
    const ok = parseLeadRouting({ ...base, assignments: [{ userId: aurela, blocks: [], backup: false, dailyCapacity: 250 }] });
    expect(ok?.assignments[0]?.dailyCapacity).toBe(250);
    expect(parseLeadRouting({ ...base, assignments: [{ userId: aurela, blocks: [], backup: false, dailyCapacity: 0 }] })).toBeNull();
    const absent = parseLeadRouting({ ...base, assignments: [{ userId: aurela, blocks: [], backup: false }] });
    expect(absent?.assignments[0]).not.toHaveProperty("dailyCapacity");
  });

  it("la base guarda y devuelve la capacidad; Equipo la edita; Leads filtra Por llamar", () => {
    const sql = read("db/migrations/0338_lead_daily_list.sql");
    expect(sql).toMatch(/daily_capacity integer\s+check \(daily_capacity is null or daily_capacity between 1 and 1000\)/);
    expect(sql).toContain("when v_assignment ? 'dailyCapacity'");
    expect(sql).toContain("'capacity',v_capacity");
    expect(read("db/apply.sql")).toContain("0338_lead_daily_list");
    expect(read("lib/lead-routing-access.ts")).toContain("daily_capacity");
    const team = read("components/team-lead-routing.tsx");
    expect(team).toContain("Leads por día");
    expect(team.match(/<DailyCapacityInput /g)).toHaveLength(2);
    const leads = read("components/leads.tsx");
    expect(leads).toContain("dailyLeadList(ranked, dailyPlan)");
    expect(leads).toContain("!isInCallQueue(l) || dailyList.ids.has(l.id)");
  });
});
