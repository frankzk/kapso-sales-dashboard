// Owner, 17-11-2026: los pedidos nuevos de Lima con guía de GF Courier van a
// Programados en el día que GF estimó (no «Con el courier» sin haber salido), y
// llevan la etiqueta «Nuevo» para distinguirlos de lo reprogramado.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gfGuideDay } from "@/lib/repro-lima-pending-access";
import { limaIsNew } from "@/lib/repro-lima-blocks";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("el día de una guía de GF Courier que no salió", () => {
  it("manda el día pedido a GF; sin él, la fecha estimada que GF devolvió", () => {
    expect(gfGuideDay("2026-11-19", "2026-11-18")).toBe("2026-11-19");
    expect(gfGuideDay(null, "2026-11-18")).toBe("2026-11-18");
    expect(gfGuideDay("", "2026-11-18T00:00:00Z")).toBe("2026-11-18");
    expect(gfGuideDay(null, null)).toBe("");
  });

  it("la lectura trae la fecha estimada de la respuesta de GF", () => {
    expect(read("lib/repro-lima-pending-access.ts")).toContain("estimated:response->>estimated_delivery_date");
  });
});

describe("«Nuevo»", () => {
  const base = { stage: "preparacion" as const, hasPriorDispatch: false, dispatchedAt: null, attempts: 0 };
  it("sale por primera vez y todavía no sale", () => {
    expect(limaIsNew(base)).toBe(true);
    expect(limaIsNew({ ...base, stage: "por_despachar" })).toBe(true);
  });
  it("no lo es lo que ya salió alguna vez ni lo que está en curso", () => {
    expect(limaIsNew({ ...base, hasPriorDispatch: true })).toBe(false);
    expect(limaIsNew({ ...base, attempts: 1 })).toBe(false);
    expect(limaIsNew({ ...base, dispatchedAt: "2026-11-17T15:00:00Z" })).toBe(false);
    expect(limaIsNew({ ...base, stage: "en_curso" })).toBe(false);
  });
  it("la fila lo dice junto a la etapa", () => {
    expect(read("components/repro-lima-pending.tsx")).toContain("{limaIsNew(row) && <Badge tone=\"teal\"");
  });
});

describe("el filtro «Nuevo» de la barra (17-11-2026)", async () => {
  const { readRowFilters, rowFiltersMatch, emptyRowFilters, writeRowFilters } = await import("@/lib/repro-lima-pending");
  const nuevo = { stage: "preparacion", hasPriorDispatch: false, dispatchedAt: null, attempts: 0, createdAt: null, salesChannel: null, district: null, courier: null, courierDetail: null } as never;
  const viejo = { stage: "en_curso", hasPriorDispatch: true, dispatchedAt: "2026-11-10T15:00:00Z", attempts: 1, createdAt: null, salesChannel: null, district: null, courier: null, courierDetail: null } as never;
  it("Nuevos, No nuevos o todos", () => {
    expect(rowFiltersMatch(nuevo, { ...emptyRowFilters(), novelty: new Set(["nuevo"]) })).toBe(true);
    expect(rowFiltersMatch(viejo, { ...emptyRowFilters(), novelty: new Set(["nuevo"]) })).toBe(false);
    expect(rowFiltersMatch(viejo, { ...emptyRowFilters(), novelty: new Set(["no_nuevo"]) })).toBe(true);
    expect(rowFiltersMatch(viejo, emptyRowFilters())).toBe(true);
  });
  it("vive en la URL como «nuevo» y descarta valores extraños", () => {
    expect([...readRowFilters(new URLSearchParams("nuevo=nuevo&nuevo=otro")).novelty]).toEqual(["nuevo"]);
    const out = new URLSearchParams();
    writeRowFilters(out, { ...emptyRowFilters(), novelty: new Set(["no_nuevo"]) });
    expect(out.toString()).toBe("nuevo=no_nuevo");
  });
  it("la barra lo ofrece", () => {
    expect(read("components/repro-lima-board.tsx")).toContain('<FacetPill label="Nuevo" allLabel="Todos"');
  });
});
