// Owner, 18-11-2026, #KP206971: «este pedido nunca salió a reparto, ¿debería
// estar en "Sacar a reparto"?». GF Courier anuló su guía por «no responde» con
// la caja lista para recojo; la anulación del courier abre la recuperación
// (En curso · Por reprogramar Lima) y Repro Lima lo ponía en No entregados con
// «No consta dónde está la caja». La caja nunca salió de la oficina: es su
// primera salida, va a «Nuevos» y la caja consta en oficina (MOM §9.5).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { limaBoxNeverLeft, limaIsNew } from "@/lib/repro-lima-pending";
import { agendaWindow, classifyLimaRow, limaBoardCounts, limaStepPart, limaTaskOf } from "@/lib/repro-lima-blocks";
import { annulledBeforePickup, annulledBeforePickupLine, boxLocation, boxLocationLabel } from "@/lib/repro-lima";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

// La guía de #KP206971 tal como quedó: anulada por GF, sin salir, caja en la empresa.
const gfAnnulled: { id: string; courier: string; delivery_status: string; custody_state: string; dispatched_at: string | null;
  returned_at: string | null; output_number: number; closed_at: string | null; out_for_delivery_at?: string | null } = {
  id: "g1", courier: "gf_courier", delivery_status: "anulado", custody_state: "empresa", dispatched_at: null,
  returned_at: null, output_number: 1, closed_at: "2026-11-18T18:28:25.668Z",
};

describe("¿la caja nunca salió?", () => {
  it("sí: el courier anuló la guía antes de recogerla y la caja sigue en la empresa", () => {
    expect(limaBoxNeverLeft([gfAnnulled])).toBe(true);
    // Aliclik y Swayp igual; con una guía nueva viva que todavía no sale, también.
    expect(limaBoxNeverLeft([{ ...gfAnnulled, courier: "aliclik" }])).toBe(true);
    expect(limaBoxNeverLeft([gfAnnulled, { ...gfAnnulled, id: "g2", delivery_status: "pendiente", closed_at: null }])).toBe(true);
  });

  it("no: alguna guía salió, volvió o la tiene el courier", () => {
    expect(limaBoxNeverLeft([{ ...gfAnnulled, dispatched_at: "2026-11-17T17:32:00Z" }])).toBe(false);
    expect(limaBoxNeverLeft([{ ...gfAnnulled, returned_at: "2026-11-18T10:00:00Z" }])).toBe(false);
    // #KP205214: Aliclik la anuló con la caja en su almacén central.
    expect(limaBoxNeverLeft([{ ...gfAnnulled, courier: "aliclik", custody_state: "courier" }])).toBe(false);
    expect(limaBoxNeverLeft([gfAnnulled, { ...gfAnnulled, id: "g2", out_for_delivery_at: "2026-11-18T15:00:00Z" }])).toBe(false);
  });

  it("no: la salida propia de Grupo GF, una agencia o ninguna guía anulada", () => {
    expect(limaBoxNeverLeft([{ ...gfAnnulled, courier: "propio" }])).toBe(false);
    expect(limaBoxNeverLeft([{ ...gfAnnulled, courier: "shalom" }])).toBe(false);
    expect(limaBoxNeverLeft([{ ...gfAnnulled, delivery_status: "pendiente" }])).toBe(false);
    expect(limaBoxNeverLeft([])).toBe(false);
  });

  it("la guía anulada es la de consecutivo más alto, y no hay ninguna si una salió", () => {
    const second = { ...gfAnnulled, id: "g2", output_number: 2 };
    expect(annulledBeforePickup([gfAnnulled, second])?.id).toBe("g2");
    expect(annulledBeforePickup([gfAnnulled, { ...second, dispatched_at: "2026-11-17T17:32:00Z" }])).toBeNull();
  });
});

describe("en Repro Lima es su primera salida (Nuevos), no un no entregado", () => {
  const TODAY = "2026-11-18";
  const win = agendaWindow(TODAY);
  const row = {
    orderId: "kp206971", storeId: "s", storeName: "Kenku", orderName: "#KP206971", customerName: "VALENTIN MONTEZA",
    customerPhone: null, district: "Villa El Salvador", orderTotal: 100, createdAt: "2026-11-17T14:44:25Z",
    macroSince: "2026-11-18T18:28:25Z", stage: "en_curso", substage: "por_reprogramar_lima", courier: "gf_courier",
    dispatchedAt: null, attempts: 0, hasPriorDispatch: false, lastDepartureAt: null, programmedFor: null, salesChannel: null,
    address: null, reference: null, courierDetail: null, gf: null, scheduledOn: null, scheduledCourier: null, ops: null,
    courierPickup: null, neverLeft: true,
  } as never as Parameters<typeof classifyLimaRow>[0];

  it("#KP206971 va a Nuevos · Sin día, con la etiqueta «Nuevo»", () => {
    const cls = classifyLimaRow(row, undefined, TODAY, win);
    expect(limaTaskOf(row)).toBe("primer_despacho");
    expect(cls.step).toBe("nuevos");
    expect(limaStepPart(cls)).toBe("nuevos_sin_dia");
    expect(limaBoardCounts([row], new Map([[row.orderId, cls]])).step.no_entregados).toBe(0);
    expect(limaIsNew(row)).toBe(true);
  });

  it("sin `neverLeft`, un «Por reprogramar Lima» sigue en No entregados", () => {
    const other = { ...row, neverLeft: false } as typeof row;
    expect(classifyLimaRow(other, undefined, TODAY, win).step).toBe("no_entregados");
    expect(limaIsNew(other)).toBe(false);
  });

  it("si ya salió alguna vez o tuvo un intento, no es su primera salida", () => {
    expect(limaIsNew({ ...row, hasPriorDispatch: true } as typeof row)).toBe(false);
    expect(limaIsNew({ ...row, attempts: 1 } as typeof row)).toBe(false);
  });

  it("la lectura marca `neverLeft` solo en «Por reprogramar Lima» sin salidas ni intentos", () => {
    const src = read("lib/repro-lima-pending-access.ts");
    expect(src).toContain('row.macro_stage === "en_curso" && row.macro_substage === "por_reprogramar_lima"');
    expect(src).toContain("!departures.has(row.order_id) && !row.dispatched_at && Number(row.attempt_count ?? 0) === 0");
    expect(src).toContain("if (limaBoxNeverLeft(byOrder.get(id) ?? [])) neverLeft.add(id);");
  });
});

describe("la caja consta en oficina y la fila dice qué pasó", () => {
  it("«En oficina» en vez de «No consta dónde está la caja»", () => {
    const box = boxLocation({ ownLive: null, box: null, lastFailed: null, receivedAt: null, annulledInOffice: { courier: "gf_courier" } });
    expect(box).toEqual({ kind: "en_oficina", since: null, courier: "gf_courier", nuncaSalio: true });
    expect(boxLocationLabel(box)).toBe("En oficina");
    expect(boxLocation({ ownLive: null, box: null, lastFailed: null, receivedAt: null }).kind).toBe("desconocida");
  });

  it("la línea de la fila en vez de «Sin «No entregado» registrado»", () => {
    expect(annulledBeforePickupLine("gf_courier", "2026-11-18T18:28:25.668Z")).toBe(
      "GF Courier anuló la guía el mié 18/11 antes de recogerla: la caja nunca salió de la oficina. Es su primera salida.",
    );
    expect(read("lib/repro-lima-access.ts")).toContain("annulledBeforePickupLine(annulled.courier, annulled.closed_at)");
    expect(read("lib/repro-lima-program.ts")).toContain("const annulledInOffice = failedStops.length || failedOutput ? null : annulledBeforePickup(outputs);");
  });
});
