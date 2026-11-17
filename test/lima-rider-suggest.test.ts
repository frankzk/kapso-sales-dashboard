// El motorizado sugerido por distrito (owner, 17-11-2026; 0353).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRiderSuggestions, gfAwaitingRider, parseGfAssigned, riderFirstName, riderSuggestionText, shownRiderSuggestion } from "@/lib/lima-rider-suggest";
import { emptyRowFilters, readRowFilters, rowFilterOptions, rowFiltersMatch, writeRowFilters, type LimaPendingOrder } from "@/lib/repro-lima-pending";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const r = (district: string, rider_name: string, deliveries: number) => ({ district, rider_name, deliveries });

describe("buildRiderSuggestions", () => {
  // Las cifras del 17-11-2026 (30 días).
  const map = buildRiderSuggestions([
    r("Santiago de Surco", "Roy Pérez", 368), r("Santiago de Surco", "Yukio Tanaka", 11), r("Santiago de Surco", "Alexis Q", 4),
    r("Lima", "Yordani X", 45), r("Lima", "Alexis Q", 40), r("Lima", "Roy Pérez", 8), r("Lima", "Yhoni Z", 5),
    r("Callao", "Alexis Q", 52), r("Callao", "Yordani X", 20),
    r("Barranco", "Roy Pérez", 2), r("Barranco", "Yhoni Z", 1),
    r("Chorrillos", "Roy Pérez", 4), r("Chorrillos", "Yhoni Z", 3), r("Chorrillos", "Alexis Q", 3),
    r("Ate", "Alexis Q", 60), r("ATE", "Alexis Q", 40),
  ]);
  it("un motorizado con la mayoría: ese", () => {
    expect(map.get("santiago de surco")).toEqual(["Roy"]);
    expect(map.get("callao")).toEqual(["Alexis"]);
  });
  it("repartido entre dos que juntos llevan casi todo: los dos, el de más paradas primero", () => {
    expect(map.get("lima")).toEqual(["Yordani", "Alexis"]);
    expect(riderSuggestionText(map.get("lima")!)).toBe("Yordani o Alexis");
  });
  it("con pocas paradas o repartido entre muchos, no se adivina", () => {
    expect(map.has("barranco")).toBe(false);
    expect(map.has("chorrillos")).toBe(false);
  });
  it("el mismo distrito con otras mayúsculas es uno", () => {
    expect(map.get("ate")).toEqual(["Alexis"]);
  });
  it("el nombre de pila", () => {
    expect(riderFirstName("  Yordani Ramos ")).toBe("Yordani");
  });
});

describe("solo mientras GF Courier no asigne", () => {
  it("antes de asignar sí; asignado o en la calle, no", () => {
    for (const s of [null, "", "CREATED", "READY_FOR_PICKUP", "READY_FOR_PICKUP:LABELED", "READY_FOR_PICKUP:AWAITING_ASSIGNMENT"]) expect(gfAwaitingRider(s), String(s)).toBe(true);
    for (const s of ["READY_FOR_PICKUP:AWAITING_OFFICE_CHECK", "READY_FOR_PICKUP:AWAITING_RIDER", "OUT_FOR_DELIVERY", "DELIVERED"]) expect(gfAwaitingRider(s), s).toBe(false);
  });
  it("la base cuenta y solo el servidor la llama; la fila lo muestra", () => {
    const sql = read("db/migrations/0353_lima_rider_district_share.sql");
    expect(sql).toContain("create or replace function public.lima_rider_district_share(p_days integer default 30)");
    expect(sql).toContain("grant execute on function public.lima_rider_district_share(integer) to service_role;");
    expect(read("lib/repro-lima-pending-access.ts")).toContain('admin.rpc("lima_rider_district_share", { p_days: RIDER_SHARE_DAYS })');
    expect(read("components/repro-lima-pending.tsx")).toContain("Sugerido: <span");
  });
  it("solo se muestra con guía de GF Courier sin motorizado", () => {
    const gf = { ops: { liveCouriers: ["gf_courier"], reportedStatus: "READY_FOR_PICKUP:AWAITING_ASSIGNMENT", courierDelivered: null, lastGfBox: null }, courierPickup: null };
    expect(shownRiderSuggestion(gf, ["Roy"])).toEqual(["Roy"]);
    expect(shownRiderSuggestion({ ...gf, ops: { ...gf.ops, reportedStatus: "READY_FOR_PICKUP:AWAITING_OFFICE_CHECK" } }, ["Roy"])).toBeNull();
    expect(shownRiderSuggestion({ ...gf, ops: { ...gf.ops, liveCouriers: ["aliclik"] } }, ["Roy"])).toBeNull();
    expect(shownRiderSuggestion(gf, null)).toBeNull();
  });
});

describe("el filtro «Sugerido» (owner, 17-11-2026)", () => {
  const row = (orderId: string, suggestedRiders: string[] | null) => ({ orderId, salesChannel: null, district: null, courier: null, courierDetail: null, createdAt: null, suggestedRiders }) as unknown as LimaPendingOrder;
  const rows = [row("a", ["Roy"]), row("b", ["Yordani", "Alexis"]), row("c", ["Alexis"]), row("d", null)];
  it("cuenta cada motorizado y «Sin sugerencia» al final", () => {
    expect(rowFilterOptions(rows).suggested).toEqual([
      { value: "Alexis", label: "Alexis", count: 2 },
      { value: "Roy", label: "Roy", count: 1 },
      { value: "Yordani", label: "Yordani", count: 1 },
      { value: "sin_sugerido", label: "Sin sugerencia", count: 1 },
    ]);
  });
  it("«Yordani o Alexis» entra con cualquiera de los dos", () => {
    const f = { ...emptyRowFilters(), suggested: new Set(["Alexis"]) };
    expect(rows.filter((r) => rowFiltersMatch(r, f)).map((r) => r.orderId)).toEqual(["b", "c"]);
    expect(rows.filter((r) => rowFiltersMatch(r, { ...emptyRowFilters(), suggested: new Set(["sin_sugerido"]) })).map((r) => r.orderId)).toEqual(["d"]);
  });
  it("vive en la URL como «sugerido» y la barra lo ofrece", () => {
    const out = new URLSearchParams();
    writeRowFilters(out, { ...emptyRowFilters(), suggested: new Set(["Roy"]) });
    expect(out.toString()).toBe("sugerido=Roy");
    expect([...readRowFilters(out).suggested]).toEqual(["Roy"]);
    expect(read("components/repro-lima-board.tsx")).toContain('<FacetPill label="Sugerido" allLabel="Todos"');
  });
});

describe("el motorizado asignado por GF Courier (owner, 17-11-2026)", () => {
  it("lee el nombre y el día de la línea del aviso", () => {
    expect(parseGfAssigned("GF Courier: asignado a Alexis para la ruta del 17/11.")).toEqual({ rider: "Alexis", day: "17/11" });
    expect(parseGfAssigned("GF Courier: asignado a Roy Pérez para la ruta del 18/11 — por Daysi (GF).")).toEqual({ rider: "Roy", day: "18/11" });
    expect(parseGfAssigned("GF Courier: asignado a Yhonny.")).toEqual({ rider: "Yhonny", day: null });
    expect(parseGfAssigned("GF Courier: entregada.")).toBeNull();
    expect(parseGfAssigned(null)).toBeNull();
  });
  it("solo cuenta la línea de la guía viva y, con asignado, ya no sugiere", () => {
    const access = read("lib/repro-lima-pending-access.ts");
    expect(access).toContain('.ilike("note", "GF Courier: asignado a %")');
    expect(access).toContain("guides.get(e.guide_code) !== e.order_id");
    expect(access).toContain("suggestedRiders: gfAssigned.has(row.order_id) ? null :");
    const ui = read("components/repro-lima-pending.tsx");
    expect(ui).toContain("Asignado: <span");
    expect(ui).toContain("{!assigned && suggested && (");
  });
});
