// Owner, 23-11-2026: «¿tienes ideas para reducir la cantidad de texto?» y «dale con
// esos cambios». La fila de #KP207897 repetía «GF Courier» seis veces y la fecha
// tres. Reglas: cada dato en un solo lugar; el próximo paso solo si hay algo que
// hacer; un solo chip por salida; los intentos sí («este sí me interesa»), «Nunca
// salió a reparto» no; la fecha dice el courier: «mié 25/11 · GF Courier».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import { agendaCourierLine, limaNextStep, limaNextStepIsInfo, type LimaRowClass } from "@/lib/repro-lima-blocks";
import { limaHistoryShort, limaHistoryText } from "@/lib/lima-block-details";
import { compactBoxLabel } from "@/lib/repro-lima";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const TODAY = "2026-11-23";
const row = (over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
  orderId: "o1", storeId: "a", storeName: "Kenku", orderName: "#KP207897", customerName: "Ana", customerPhone: "51999000111",
  district: "Surco", orderTotal: 189, createdAt: "2026-11-21T13:00:00Z", macroSince: "2026-11-21T13:00:00Z",
  stage: "por_despachar", substage: "listo_para_asignar", courier: "gf_courier", dispatchedAt: null, attempts: 0,
  hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, salesChannel: null, address: "Av. Ejemplo 123", reference: null,
  courierPickup: { courier: "gf_courier", date: "2026-11-25" }, gf: null, scheduledOn: null, ops: null, ...over,
});
const cls = (over: Partial<LimaRowClass> = {}): LimaRowClass => ({
  step: "programados", task: null, needsToday: false, departureUnknown: false, missedPickup: false, courier: null,
  guide: true, agenda: "despues", autoGuide: false, autoGuideBy: null, agendaDay: "2026-11-25", noReport: false,
  ...over,
} as LimaRowClass);

describe("el historial: los intentos sí, «Nunca salió a reparto» no", () => {
  it("nunca salió: solo los intentos; el texto entero queda al pasar el mouse", () => {
    expect(limaHistoryShort(row())).toBe("0 intentos");
    expect(limaHistoryShort(row({ attempts: 1 }))).toContain("1 intento");
    expect(limaHistoryText(row())).toContain("Nunca salió a reparto · 0 intentos registrados");
    expect(read("components/repro-lima-pending.tsx")).toContain("title={limaHistoryText(row)}>{limaHistoryShort(row)}</p>");
  });

  it("salió: con quién", () => {
    expect(limaHistoryShort(row({ attempts: 2, hasPriorDispatch: true, dispatchedWith: ["aliclik"] }))).toMatch(/^2 intentos · salió con /);
  });

  it("el historial reconstruido de rutas sigue a la vista en la fila", () => {
    expect(limaHistoryShort(row({ attempts: 2, hasPriorDispatch: true, dispatchedWith: ["aliclik"], historyFromRoutes: true }))).toMatch(/ · reconstruido de rutas$/);
    expect(limaHistoryShort(row())).not.toContain("rutas");
  });
});

describe("la fecha dice el courier: «mié 25/11 · GF Courier»", () => {
  it("cada origen con su courier y, chico, de dónde sale", () => {
    expect(agendaCourierLine("acuerdo", row(), "GF Courier")).toBe("GF Courier · acordado");
    expect(agendaCourierLine("recojo", row())).toBe("GF Courier · recojo");
    expect(agendaCourierLine("recojo", row({ courierPickup: { courier: "aliclik", date: "2026-11-24" } }))).toBe("Aliclik · recojo");
    expect(agendaCourierLine("programa", row())).toBe("Grupo GF · programa");
    // Sin courier conocido, el origen entero, como antes.
    expect(agendaCourierLine("acuerdo", row(), null)).toBe("Acordado con la clienta");
    expect(read("components/repro-lima-pending.tsx")).toContain("title={AGENDA_ORIGIN_LABEL[origin]}>{agendaCourierLine(origin, row, repro?.agreement?.courierName)}</p>");
  });
});

describe("el próximo paso solo si hay algo que hacer", () => {
  it("lo que sale solo es informativo: la fila muestra un guion", () => {
    const pickup = cls({ courier: "guia_creada" });
    expect(limaNextStepIsInfo(row(), pickup, TODAY)).toBe(true);
    expect(limaNextStep(row(), undefined, pickup, TODAY)).toBe("Lo recoge GF Courier el mié 25/11.");
    expect(limaNextStepIsInfo(row(), cls({ courier: "en_ruta" }), TODAY)).toBe(true);
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls(), TODAY)).toBe(true);
    expect(limaNextStep(row({ courierPickup: null }), undefined, cls(), TODAY)).toMatch(/^Sale el mié 25\/11\./);
  });

  it("lo que pide algo se sigue diciendo", () => {
    expect(limaNextStepIsInfo(row(), cls({ task: "no_entregados", step: "no_entregados" }), TODAY)).toBe(false);
    expect(limaNextStepIsInfo(row(), cls({ courier: "guia_creada", missedPickup: true }), TODAY)).toBe(false);
    expect(limaNextStepIsInfo(row(), cls({ courier: "retornando" }), TODAY)).toBe(false);
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls({ agendaDay: "2026-11-20" }), TODAY)).toBe(false);
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls({ guide: false, agenda: "hoy", agendaDay: TODAY }), TODAY)).toBe(false);
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls({ agendaDay: null, agenda: null }), TODAY)).toBe(false);
  });

  it("mañana sin guía: informativo solo si Kapta la crea", () => {
    const manana = { guide: false, agenda: "manana" as const, agendaDay: "2026-11-24" };
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls({ ...manana, autoGuideBy: "fenix" }), TODAY)).toBe(true);
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls({ ...manana, autoGuide: true }), TODAY)).toBe(true);
    expect(limaNextStepIsInfo(row({ courierPickup: null }), cls(manana), TODAY)).toBe(false);
  });

  it("el guion conserva el texto para el mouse y el lector de pantalla; un reintento sigue con su nota", () => {
    const ui = read("components/repro-lima-pending.tsx");
    expect(ui).toContain("limaNextStepIsInfo(row, cls, today) && !repro?.retryChain ? (");
    expect(ui).toContain('<span className="sr-only">{limaNextStep(row, repro, cls, today, now)}</span>');
  });
});

describe("un solo chip por salida en la lista; la ficha igual", () => {
  it("la caja en oficina de la salida viva, en corto", () => {
    expect(compactBoxLabel({ kind: "con_courier", courier: "gf_courier", enOficina: true } as never, "Salida de GF Courier en oficina · la recoge GF Courier")).toBe("Caja en oficina");
    expect(compactBoxLabel({ kind: "con_courier", courier: "gf_courier", enOficina: false } as never, "La lleva GF Courier")).toBe("La lleva GF Courier");
  });

  it("la lista pide la versión compacta; la ficha no", () => {
    const list = read("components/repro-lima-pending.tsx");
    expect(list).toContain("<FailureLine row={repro} compact />");
    expect(list).toContain("<ReproRowChips row={repro} today={today} compact />");
    const panel = read("components/repro-lima-panel.tsx");
    expect(panel).toContain("<FailureLine row={current} />");
    expect(panel).toContain("<ReproRowChips row={current} today={today} />");
    expect(panel).toContain('const STATE_SHOWN_IN_DATE = new Set(["programado", "salida_creada"]);');
    expect(list).not.toContain("· por su distrito");
  });
});
