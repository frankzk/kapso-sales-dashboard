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
    expect(read("components/repro-lima-pending.tsx")).toContain("{cls?.step === \"nuevos\" && <Badge tone=\"fuchsia\"");
  });
});

describe("el paso «Nuevos» del Flujo del día (17-11-2026)", async () => {
  const { classifyLimaRow, limaBoardCounts, limaBoardRows, agendaWindow, LIMA_STEPS } = await import("@/lib/repro-lima-blocks");
  const TODAY = "2026-11-17";
  const base = {
    orderId: "n1", storeId: "s", storeName: "Kenku", orderName: "#KP1", customerName: "C", customerPhone: null, district: "Surco",
    orderTotal: 100, createdAt: "2026-11-17T16:00:00Z", macroSince: "2026-11-17T16:00:00Z", stage: "por_despachar", substage: "listo_para_asignar",
    courier: "gf_courier", dispatchedAt: null, attempts: 0, hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null,
    salesChannel: null, address: null, reference: null, courierDetail: null, gf: null, scheduledOn: null, scheduledCourier: null, ops: null,
    courierPickup: { courier: "gf_courier", date: "2026-11-18" },
  } as never as Parameters<typeof classifyLimaRow>[0];
  const win = agendaWindow(TODAY);
  it("va entre Sacar a reparto y Programados", () => {
    expect(LIMA_STEPS.indexOf("nuevos")).toBe(LIMA_STEPS.indexOf("por_sacar") + 1);
    expect(LIMA_STEPS.indexOf("programados")).toBe(LIMA_STEPS.indexOf("nuevos") + 1);
  });
  it("con guía de mañana deja Nuevos y pasa a Programados (Daysi, 18-11-2026)", () => {
    const cls = classifyLimaRow(base, undefined, TODAY, win);
    expect(cls.step).toBe("programados");
    const counts = limaBoardCounts([base], new Map([["n1", cls]]));
    expect(counts.step.nuevos).toBe(0);
    expect(counts.step.programados).toBe(1);
    expect(counts.agenda.manana).toBe(1);
    expect(limaBoardRows([base], new Map([["n1", cls]]), "manana").map((r) => r.orderId)).toEqual(["n1"]);
  });
  it("lo nuevo sin guía ni día está en Nuevos · Sin día", () => {
    const row = { ...base, courier: null, courierPickup: null, stage: "preparacion", substage: "por_generar_rotulo" } as typeof base;
    const cls = classifyLimaRow(row, undefined, TODAY, win);
    expect(cls.step).toBe("nuevos");
    expect(limaBoardCounts([row], new Map([["n1", cls]])).sub.nuevos_sin_dia).toBe(1);
  });
  it("lo que ya salió alguna vez no es nuevo: sigue en su paso", () => {
    const row = { ...base, hasPriorDispatch: true } as typeof base;
    expect(classifyLimaRow(row, undefined, TODAY, win).step).not.toBe("nuevos");
  });
  it("la barra ya no tiene el filtro «Nuevo»; la fila conserva la etiqueta", () => {
    expect(read("components/repro-lima-board.tsx")).not.toContain('label="Nuevo"');
    expect(read("components/repro-lima-pending.tsx")).toContain("{cls?.step === \"nuevos\" && <Badge tone=\"fuchsia\"");
  });
});
