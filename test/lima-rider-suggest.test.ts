// El motorizado sugerido por distrito (owner, 17-11-2026; 0353).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRiderSuggestions, gfAwaitingRider, riderFirstName, riderSuggestionText } from "@/lib/lima-rider-suggest";

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
});
