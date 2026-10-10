// «Reprogramado por el cliente» con fecha, de una vez (10-10-2026). Coordinación
// reportaba la parada y después tenía que ir a Grupo GF a programar el día que
// pidió el cliente. Ahora la fecha es opcional en el mismo reporte y agenda la
// salida por el mismo camino que «Programar».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rescheduleDateProblem, writeGfDispatchProgram } from "@/lib/gf-dispatch-program";

describe("la fecha que se acepta", () => {
  it("hoy y los próximos dos meses, sí; antes de hoy, más allá o mal escrita, no", () => {
    expect(rescheduleDateProblem("2026-10-10", "2026-10-10")).toBeNull();
    expect(rescheduleDateProblem("2026-10-13", "2026-10-10")).toBeNull();
    expect(rescheduleDateProblem("2026-12-09", "2026-10-10")).toBeNull();
    expect(rescheduleDateProblem("2026-10-09", "2026-10-10")).toBe("La nueva fecha no puede ser anterior a hoy.");
    expect(rescheduleDateProblem("2026-12-10", "2026-10-10")).toMatch(/60 días/);
    expect(rescheduleDateProblem("13/10/2026", "2026-10-10")).toBe("Elige una fecha válida.");
  });
});

describe("el programa se escribe igual desde Grupo GF y desde el reporte", () => {
  function fakeAdmin(opts: { upsertError?: string } = {}) {
    const calls: { table: string; op: string; arg: unknown }[] = [];
    const admin = {
      from: (table: string) => ({
        upsert: async (arg: unknown) => { calls.push({ table, op: "upsert", arg }); return { error: opts.upsertError ? { message: opts.upsertError } : null }; },
        update: (arg: unknown) => ({ eq: async () => { calls.push({ table, op: "update", arg }); return { error: null }; } }),
        insert: async (arg: unknown) => { calls.push({ table, op: "insert", arg }); return { error: null }; },
      }),
    } as never;
    return { admin, calls };
  }

  it("guarda el día, mueve la solicitud y deja el evento con el motivo", async () => {
    const { admin, calls } = fakeAdmin();
    const result = await writeGfDispatchProgram(admin, {
      orderId: "o1", storeId: "s1", day: "2026-10-13", reason: "Reprogramado por el cliente (reporte de la parada de Alexis)",
      actor: "u1", request: { id: "r1", scheduled_for: "2026-10-10", shipment_id: "sh1" }, from: null, now: "2026-10-10T15:00:00Z",
    });
    expect(result).toEqual({ written: true, error: null });
    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual(["gf_dispatch_programs.upsert", "logistics_requests.update", "order_events.insert"]);
    const event = calls[2]!.arg as { kind: string; note: string };
    expect(event.kind).toBe("dispatch_programmed");
    expect(event.note).toBe("Salida programada para el mar 13/10: Reprogramado por el cliente (reporte de la parada de Alexis).");
  });

  it("si el programa no se guarda, lo dice y no deja evento", async () => {
    const { admin, calls } = fakeAdmin({ upsertError: "boom" });
    const result = await writeGfDispatchProgram(admin, {
      orderId: "o1", storeId: "s1", day: "2026-10-13", reason: "x", actor: "u1", request: null, from: null,
    });
    expect(result).toEqual({ written: false, error: "boom" });
    expect(calls.map((c) => c.table)).toEqual(["gf_dispatch_programs"]);
  });
});

describe("el reporte y la pantalla", () => {
  const actions = readFileSync(resolve(process.cwd(), "app/reparto/actions.ts"), "utf8");
  const form = readFileSync(resolve(process.cwd(), "components/rider-route.tsx"), "utf8");

  it("la fecha solo cuenta con «Reprogramado por el cliente» y se valida ANTES de escribir el reporte", () => {
    const body = actions.slice(actions.indexOf("export async function reportStop("), actions.indexOf("async function programFromReport("));
    expect(body).toContain('input.status === "no_entregado" && input.outcomeReason === "reprogramado" && input.rescheduleOn?.trim()');
    expect(body.indexOf("rescheduleDateProblem(rescheduleOn, limaTodayKey())")).toBeLessThan(body.indexOf("await writeStopReport("));
    // Escrito el reporte, se agenda; si falla, el reporte ya quedó y se dice qué falta.
    expect(body.indexOf("await programFromReport(")).toBeGreaterThan(body.indexOf("await writeStopReport("));
    expect(body).toContain("prográmalo en Grupo GF.");
  });

  it("el campo es opcional, sale solo con ese motivo y no deja elegir antes de hoy", () => {
    expect(form).toContain('{status === "no_entregado" && reason === "reprogramado" && (');
    expect(form).toContain('Nueva fecha <span className="font-normal text-ink-500">(opcional)</span>');
    expect(form).toContain("min={limaToday()}");
    expect(form).toContain('rescheduleOn: status === "no_entregado" && reason === "reprogramado" ? rescheduleOn || null : null,');
  });

  it("«Programar» de Grupo GF usa la misma escritura", () => {
    const courier = readFileSync(resolve(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
    expect(courier).toContain("await writeGfDispatchProgram(admin, {");
    expect(actions).toContain("await writeGfDispatchProgram(admin, {");
  });
});
