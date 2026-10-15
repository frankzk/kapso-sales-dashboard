import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { courierDisplayName, dispatchedWith, dispatchedWithLabel, dispatchedWithShort } from "@/lib/dispatched-with";
import { ownRiderAttempts } from "@/lib/order-status";
import { emptyFilters, matchesFilters } from "@/lib/order-master-filters";
import { buildMasterQuery, parseMasterQuery } from "@/lib/master-query";
import type { OrderMasterRow } from "@/lib/types";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const stop = (id: string, status: string, rider: string | null, shipment_id: string | null = "s-gf") => ({ id, status, rider, shipment_id });

describe("«Salió con» (MOM §9.3, 15-10-2026)", () => {
  it("#KP140941: dos paradas con Roy y la de hoy en curso son «Grupo GF · Roy»", () => {
    const guides = [{ id: "s-gf", courier: "propio", delivery_status: "pendiente", custody_state: "courier" }];
    expect(dispatchedWith({ guides, stops: [stop("a", "no_entregado", "Roy"), stop("b", "no_entregado", "Roy"), stop("c", "pendiente", "Roy")], events: [], urpiAttempts: 0 })).toEqual(["gf:Roy"]);
  });
  it("cada motorizado y cada courier que llegó a salir, primero Grupo GF", () => {
    const guides = [
      { id: "s-gf", courier: "propio", delivery_status: "anulado", custody_state: "devuelto" },
      { id: "t1", courier: "tanders", delivery_status: "anulado", reported_status: "RETURNED" },
      { id: "a1", courier: "aliclik", delivery_status: "anulado" },
      { id: "f1", courier: "fenix", delivery_status: "en_ruta", swayp_state: 8 },
      { id: "p1", courier: "por_definir", delivery_status: "pendiente" },
    ];
    const out = dispatchedWith({ guides, stops: [stop("a", "no_entregado", "Yhoni"), stop("b", "no_entregado", "Alexis")], events: [], urpiAttempts: 1 });
    expect(out).toEqual(["gf:Alexis", "gf:Yhoni", "fenix", "tanders", "urpi"]);
  });
  it("una parada pendiente sin la caja en la calle, o una guía que no salió, no cuentan", () => {
    const guides = [{ id: "s-gf", courier: "propio", delivery_status: "pendiente", custody_state: "empresa" }, { id: "a1", courier: "aliclik", delivery_status: "pendiente" }];
    expect(dispatchedWith({ guides, stops: [stop("c", "pendiente", "Roy")], events: [], urpiAttempts: 0 })).toEqual([]);
  });
  it("una salida de Grupo GF sin parada conocida queda como «Grupo GF»", () => {
    const guides = [{ id: "s-gf", courier: "propio", delivery_status: "entregado", dispatched_at: "2026-08-01T15:00:00Z" }];
    expect(dispatchedWith({ guides, stops: [], events: [], urpiAttempts: 0 })).toEqual(["gf"]);
  });
  it("los nombres que ve el equipo", () => {
    expect(dispatchedWithLabel("gf:Roy")).toBe("Grupo GF · Roy");
    expect(dispatchedWithLabel("gf")).toBe("Grupo GF");
    expect(dispatchedWithLabel("fenix")).toBe("Swayp");
    expect(dispatchedWithShort("gf:Alexis")).toBe("Alexis");
    expect(courierDisplayName("propio")).toBe("Grupo GF");
    expect(courierDisplayName("por_definir")).toBe("Por definir");
    expect(courierDisplayName("fenix")).toBe("Swayp");
    expect(courierDisplayName(null)).toBe("—");
  });
  it("los intentos de Grupo GF cuentan las paradas del cuaderno histórico, sin duplicar las que tienen evento", () => {
    const events = [{ kind: "stop_reported", payload: { stop_id: "a" } }];
    expect(ownRiderAttempts(events, [{ id: "a", status: "no_entregado" }, { id: "b", status: "entregado" }, { id: "c", status: "pendiente" }])).toBe(2);
  });
  it("el filtro: URL, navegador, base y opciones", () => {
    const q = parseMasterQuery(new URLSearchParams("sc=gf:Roy,tanders"));
    expect([...q.filters.dispatchedWith]).toEqual(["gf:Roy", "tanders"]);
    const f = emptyFilters();
    f.dispatchedWith = new Set(["gf:Alexis"]);
    expect(buildMasterQuery({ filters: f, sortKey: "created", page: 1 }).toString()).toBe("sc=gf%3AAlexis");
    const row = (dispatched_with: string[] | null) => ({ dispatched_with } as unknown as OrderMasterRow);
    const now = new Date().toISOString();
    expect(matchesFilters(row(["gf:Roy", "gf:Alexis"]), f, now)).toBe(true);
    expect(matchesFilters(row(["gf:Roy"]), f, now)).toBe(false);
    expect(matchesFilters(row(null), f, now)).toBe(false);
    expect(read("lib/orders-master-access.ts")).toContain('if (f.dispatchedWith.size) q = q.overlaps("dispatched_with", [...f.dispatchedWith]);');
    const sql = read("db/migrations/0266_order_master_dispatched_with.sql");
    expect(sql).toContain("add column if not exists dispatched_with text[] not null default '{}'");
    expect(sql).toContain("select distinct unnest(dispatched_with) as v from order_master");
  });
  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**«Salió con» (v1.30, 15-10-2026).**");
    expect(mom).toContain("las paradas del cuaderno histórico");
  });
});
