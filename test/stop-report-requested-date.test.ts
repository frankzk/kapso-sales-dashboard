// La fecha que pidió el cliente (12-10-2026, D9, MOM §9.5). El motorizado, la
// coordinación o el cuaderno la dejan en la parada (`delivery_stops.requested_date`)
// y la tienda la confirma en Repro Lima: nunca programa la salida. La escribe
// SOLO writeStopReport, y solo con «Reprogramado por el cliente» (CHECK de 0249).
//   - undefined conserva lo que había (Liquidaciones 2 no la manda);
//   - null la borra;
//   - con otro resultado se borra siempre;
//   - una fecha que no vale (antes de hoy, más de 60 días) no deja el reporte a medias.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: async () => undefined }));
vi.mock("@/lib/route-collection-access", () => ({
  loadRouteCollectionBalances: async (ids: string[]) => new Map(ids.map((id) => [id, { remaining: 89, validated: 0, pending: 0 }])),
}));

import { writeStopReport, type WriteStopReportInput } from "@/lib/stop-report";

type Call = { table: string; op: string; arg: unknown };

/** Un admin de mentira: las lecturas no encuentran nada y las escrituras se anotan. */
function fakeAdmin() {
  const calls: Call[] = [];
  const read = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      eq: self, is: self, in: self, limit: self, order: self,
      maybeSingle: async () => ({ data: table === "delivery_stops" ? { store_id: "store-1", shipment_id: null, status: "pendiente" } : null, error: null }),
    });
    return chain;
  };
  const admin = {
    from: (table: string) => ({
      select: () => read(table),
      update: (arg: unknown) => ({
        eq: async () => {
          calls.push({ table, op: "update", arg });
          return { error: null };
        },
      }),
      insert: (arg: unknown) => {
        calls.push({ table, op: "insert", arg });
        return Promise.resolve({ error: null });
      },
    }),
  } as never;
  return { admin, calls };
}

const ctx = {
  stop: { id: "stop-1", order_id: "order-1", route_id: "route-1", photo_path: "route-1/stop-1/entrega.jpg", voucher_path: null },
  routeStatus: "en_curso",
};

const base: WriteStopReportInput = {
  stopId: "stop-1",
  status: "no_entregado",
  paymentMethod: null,
  collectedAmount: null,
  outcomeReason: "reprogramado",
  note: null,
  actor: "user-1",
};

async function report(over: Partial<WriteStopReportInput>) {
  const { admin, calls } = fakeAdmin();
  const result = await writeStopReport(admin, { ...base, ...over }, ctx);
  const update = calls.find((c) => c.table === "delivery_stops" && c.op === "update")?.arg as Record<string, unknown> | undefined;
  const event = calls.find((c) => c.table === "order_events" && c.op === "insert")?.arg as { note: string; payload: Record<string, unknown> } | undefined;
  return { result, update, event };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Lunes 12/10/2026, 10:00 en Lima.
  vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("la fecha que pidió el cliente en el reporte de la parada", () => {
  it("undefined conserva: el reporte no toca la columna", async () => {
    const { result, update, event } = await report({});
    expect(result.ok).toBe(true);
    expect(update).toBeDefined();
    expect(update).not.toHaveProperty("requested_date");
    expect(event?.payload).not.toHaveProperty("requested_date");
    expect(event?.note).not.toContain("pidió el");
  });

  it("null la borra, y un texto vacío también", async () => {
    expect((await report({ requestedDate: null })).update).toMatchObject({ requested_date: null });
    expect((await report({ requestedDate: "  " })).update).toMatchObject({ requested_date: null });
  });

  it("con «Reprogramado por el cliente» se guarda tal cual, y el evento la dice sin darla por buena", async () => {
    const { result, update, event } = await report({ requestedDate: "2026-10-14" });
    expect(result.ok).toBe(true);
    expect(update).toMatchObject({ status: "no_entregado", outcome_reason: "reprogramado", requested_date: "2026-10-14" });
    expect(event?.payload).toMatchObject({ requested_date: "2026-10-14", outcome_reason: "reprogramado" });
    expect(event?.note).toContain("No entregado · Reprogramado por el cliente · pidió el mié 14/10 (sin confirmar)");
    // Hoy también vale: el cliente pide que se vuelva más tarde.
    expect((await report({ requestedDate: "2026-10-12" })).update).toMatchObject({ requested_date: "2026-10-12" });
  });

  it("con otro motivo o entregado se borra, aunque llegue una fecha (incluso una que ya pasó)", async () => {
    const other = await report({ outcomeReason: "no_contesta", requestedDate: "2026-10-14" });
    expect(other.result.ok).toBe(true);
    expect(other.update).toMatchObject({ requested_date: null });
    expect(other.event?.payload).not.toHaveProperty("requested_date");
    const past = await report({ outcomeReason: "no_estaba", requestedDate: "2026-10-01" });
    expect(past.result.ok).toBe(true);
    expect(past.update).toMatchObject({ requested_date: null });
    const delivered = await report({ status: "entregado", outcomeReason: null, paymentMethod: "efectivo", collectedAmount: 50, requestedDate: "2026-10-14" });
    expect(delivered.result.ok).toBe(true);
    expect(delivered.update).toMatchObject({ status: "entregado", requested_date: null });
    // Sin fecha que mandar, otro resultado la borra igual: el CHECK de 0249 no la deja.
    expect((await report({ outcomeReason: "no_contesta" })).update).toMatchObject({ requested_date: null });
  });

  it("una fecha que ya pasó, mal escrita o a más de 60 días no deja el reporte a medias", async () => {
    const past = await report({ requestedDate: "2026-10-11" });
    expect(past.result).toEqual({ ok: false, error: "La nueva fecha no puede ser anterior a hoy." });
    expect(past.update).toBeUndefined();
    expect(past.event).toBeUndefined();
    const far = await report({ requestedDate: "2026-12-12" });
    expect(far.result.ok).toBe(false);
    expect(far.update).toBeUndefined();
    const bad = await report({ requestedDate: "14/10/2026" });
    expect(bad.result).toEqual({ ok: false, error: "Elige una fecha válida." });
    expect(bad.update).toBeUndefined();
  });
});
